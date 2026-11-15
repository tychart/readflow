from __future__ import annotations

import asyncio
import logging
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.router import build_router
from app.core.config import get_settings
from app.core.services import AppServices, build_services

logger = logging.getLogger(__name__)


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
        recovery = await services.job_manager.recover_after_restart(
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

    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_credentials=False,
        allow_methods=["*"],
        allow_headers=["*"],
    )
    app.include_router(build_router(lambda: app.state.services))
    return app


def get_services(app: FastAPI) -> AppServices:
    return app.state.services
