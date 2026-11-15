"""Application factory: lifespan, CSRF, and the router.

Startup order matters and is deliberate:

1. build the service graph (choosing the storage adapter),
2. reconcile whatever a crashed process left mid-flight,
3. start the scheduler (only after the data is consistent).

Shutdown stops the scheduler, unloads the model and closes the database.
"""

from __future__ import annotations

import asyncio
import logging
from contextlib import asynccontextmanager
from pathlib import Path
from urllib.parse import urlsplit

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from app.api.admin_users import build_admin_users_router
from app.api.auth import build_auth_router
from app.api.router import build_router
from app.core.config import get_settings
from app.core.services import AppServices, build_services

logger = logging.getLogger(__name__)

# Methods that change state, and so need the origin check. GET/HEAD/OPTIONS are
# read-only, and the media routes rely on that being cheap.
UNSAFE_METHODS = frozenset({"POST", "PUT", "PATCH", "DELETE"})


def _allowed_hosts() -> set[str]:
    """Hosts an `Origin` header may name for a state-changing request.

    `READFLOW_ALLOWED_ORIGINS` takes full origins; `HOST_URL` (the dev/proxy
    hostname) contributes its host. Comparison is on the **host**, because that
    is what a reverse proxy forwards as `Host` while the browser sends the public
    origin.
    """
    settings = get_settings()
    hosts: set[str] = set()
    for entry in settings.allowed_origins.split(","):
        entry = entry.strip()
        if entry:
            hosts.add(_host_of(entry))
    if settings.host_url:
        hosts.add(_host_of(settings.host_url))
    hosts.discard("")
    return hosts


def _host_of(value: str) -> str:
    """`https://example.com:443/` -> `example.com:443`; a bare host passes through."""
    parsed = urlsplit(value if "//" in value else f"//{value}")
    return parsed.netloc or parsed.path


def create_app() -> FastAPI:
    settings = get_settings()
    base_dir = Path(__file__).resolve().parents[2]
    scheduler_task: asyncio.Task[None] | None = None

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        nonlocal scheduler_task
        services = await build_services(settings, base_dir)
        app.state.services = services
        # Reconcile whatever the previous process left mid-flight *before* the
        # scheduler can dispatch: an interrupted `RENDERING` chunk or a
        # `WRITTEN` chunk whose audio is gone is repaired here, once.
        recovery = await services.scheduler_jobs.recover_after_restart(
            services.media_store.chunk_files_exist
        )
        if recovery.recovered:
            logger.info(
                "Recovered %d of %d job(s) after restart: %s",
                len(recovery.recovered),
                recovery.examined,
                ", ".join(recovery.recovered),
            )
        if settings.scheduler_autostart:
            scheduler_task = asyncio.create_task(services.scheduler.run_forever())
        yield
        await services.scheduler.shutdown()
        if scheduler_task is not None:
            scheduler_task.cancel()
            try:
                await scheduler_task
            except asyncio.CancelledError:
                pass
        await services.model_manager.unload()
        await services.database.close()

    app = FastAPI(title=settings.app_name, lifespan=lifespan)

    @app.get("/health")
    async def health_check() -> dict[str, str]:
        return {"status": "ok"}

    @app.middleware("http")
    async def csrf_origin_check(request: Request, call_next):
        """Reject a state-changing cross-site request.

        SameSite=Lax is the primary defence; this is the second. An `Origin`
        header must name the request's own host or an allow-listed origin. A
        missing `Origin` (curl, tests, same-origin `fetch` in some browsers) is
        allowed — rejecting it would break the CLI and the test suite without
        adding any protection, because a cross-site form post always sends one.
        """
        if request.method in UNSAFE_METHODS:
            origin = request.headers.get("origin")
            if origin:
                allowed = _allowed_hosts() | {_request_host(request)}
                if _host_of(origin) not in allowed:
                    return JSONResponse(
                        status_code=403, content={"detail": "Cross-origin request refused"}
                    )
        return await call_next(request)

    app.include_router(build_router(lambda: app.state.services))
    # Auth and admin-user routes live under /api as well, so the frontend keeps
    # one relative base path and Vite/Caddy keep one proxy rule.
    app.include_router(build_auth_router(), prefix="/api")
    app.include_router(build_admin_users_router(), prefix="/api")
    return app


def _request_host(request: Request) -> str:
    """The host this request arrived on, honouring a reverse proxy."""
    forwarded = request.headers.get("x-forwarded-host", "").split(",")[0].strip()
    if forwarded:
        return _host_of(forwarded)
    return _host_of(request.headers.get("host", ""))


def get_services(app: FastAPI) -> AppServices:
    return app.state.services


__all__ = ["create_app", "get_services"]
