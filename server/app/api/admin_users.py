"""Admin user management and the database backup download.

Both are admin-only, and both are about plumbing rather than content: an admin
can create, disable and re-password accounts, and can take a backup. No endpoint
here returns another user's chunk or source text.
"""

from __future__ import annotations

import asyncio
import logging
import os
import secrets
import tempfile
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.responses import FileResponse
from starlette.background import BackgroundTask

from app.api.deps import current_admin, get_app_services
from app.auth.models import AuthError
from app.auth.passwords import PasswordError
from app.core.services import AppServices
from app.db.models import User
from app.schemas.auth import (
    UserCreateRequest,
    UserListResponse,
    UserResponse,
    UserUpdateRequest,
    user_response,
)

logger = logging.getLogger(__name__)

# `pg_dump` on a book-sized library is seconds, not minutes, but it must not be
# unbounded: a hung dump would pin a request and a temporary file forever.
BACKUP_TIMEOUT_SECONDS = 1800


def build_admin_users_router() -> APIRouter:
    router = APIRouter(prefix="/admin")

    @router.get("/users", response_model=UserListResponse)
    async def list_users(
        app_services: AppServices = Depends(get_app_services),
        admin: User = Depends(current_admin),
    ) -> UserListResponse:
        del admin
        users = await app_services.auth.list_users()
        return UserListResponse(users=[user_response(user) for user in users])

    @router.post("/users", response_model=UserResponse, status_code=status.HTTP_201_CREATED)
    async def create_user(
        payload: UserCreateRequest,
        app_services: AppServices = Depends(get_app_services),
        admin: User = Depends(current_admin),
    ) -> UserResponse:
        del admin
        # Admin-created accounts are the normal path (there is no self-service
        # registration endpoint at all). `allow_registration` exists only for
        # deployments that want to refuse even this.
        try:
            user = await app_services.auth.create_user(
                username=payload.username,
                password=payload.password,
                display_name=payload.display_name,
                is_admin=payload.is_admin,
            )
        except (AuthError, PasswordError) as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        return user_response(user)

    @router.patch("/users/{user_id}", response_model=UserResponse)
    async def update_user(
        user_id: str,
        payload: UserUpdateRequest,
        app_services: AppServices = Depends(get_app_services),
        admin: User = Depends(current_admin),
    ) -> UserResponse:
        """Disable, re-privilege, rename or re-password an account.

        Disabling and re-password both revoke that user's sessions, so a stolen
        cookie stops working immediately.
        """
        try:
            user = await app_services.auth.update_user(
                user_id,
                is_active=payload.is_active,
                is_admin=payload.is_admin,
                display_name=payload.display_name,
                password=payload.password,
            )
        except (AuthError, PasswordError) as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        if payload.is_active is False or payload.password is not None:
            # The session rows are gone; take the live stream with them.
            await app_services.hub.disconnect_user(user_id)
        if admin.id == user_id and payload.is_admin is False:
            # An admin may demote themselves, but then this request is the last
            # privileged thing they do; say so rather than failing silently later.
            logger.warning("Admin %s demoted themselves", admin.username)
        return user_response(user)

    @router.get("/backup")
    async def download_backup(
        app_services: AppServices = Depends(get_app_services),
        admin: User = Depends(current_admin),
    ) -> FileResponse:
        """Stream a `pg_dump -Fc` of the database.

        A backup is the one artefact that contains everything, by definition.
        It is therefore admin-only, written 0600 in a private temp directory, and
        never logged. The dump runs as a subprocess with `PGPASSWORD` in the
        environment (never in argv, which `ps` would show).
        """
        url = app_services.settings.database_url
        if not url:
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="No database is configured; there is nothing to back up",
            )
        path = await _dump_database(url)
        logger.info("Admin %s downloaded a database backup", admin.username)
        return FileResponse(
            path,
            media_type="application/octet-stream",
            filename=path.name,
            background=BackgroundTask(path.unlink, missing_ok=True),
        )

    return router


def _parse_postgres_url(url: str) -> dict[str, str]:
    """Split a SQLAlchemy URL into `pg_dump` connection settings."""
    from sqlalchemy.engine import make_url

    parsed = make_url(url)
    settings = {
        "PGHOST": parsed.host or "127.0.0.1",
        "PGPORT": str(parsed.port or 5432),
        "PGUSER": parsed.username or "",
        "PGDATABASE": parsed.database or "",
    }
    if parsed.password:
        settings["PGPASSWORD"] = parsed.password
    return settings


async def _dump_database(url: str) -> Path:
    """Run `pg_dump -Fc` into a private temp file and return its path."""
    directory = Path(tempfile.mkdtemp(prefix="readflow-backup-"))
    path = directory / f"readflow-{secrets.token_hex(8)}.dump"
    environment = {**os.environ, **_parse_postgres_url(url)}
    command = ["pg_dump", "--format=custom", "--file", str(path)]
    try:
        process = await asyncio.create_subprocess_exec(
            *command,
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.PIPE,
            env=environment,
        )
    except FileNotFoundError as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="pg_dump is not installed in this container",
        ) from exc
    try:
        _stdout, stderr = await asyncio.wait_for(
            process.communicate(), timeout=BACKUP_TIMEOUT_SECONDS
        )
    except TimeoutError as exc:
        process.kill()
        await process.wait()
        raise HTTPException(status_code=504, detail="The backup timed out") from exc
    if process.returncode != 0:
        detail = stderr.decode(errors="replace").strip().splitlines()[-1:] or ["unknown error"]
        # The dump's stderr can name tables but never row contents; one line is
        # enough to debug and small enough to show.
        raise HTTPException(status_code=500, detail=f"pg_dump failed: {detail[0]}")
    path.chmod(0o600)
    return path
