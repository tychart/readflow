from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.router import build_router
from app.core.config import get_settings
from app.core.services import AppServices, build_services


def create_app() -> FastAPI:
    settings = get_settings()
    base_dir = Path(__file__).resolve().parents[2]
    services = build_services(settings, base_dir)
    scheduler_task: asyncio.Task[None] | None = None

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        nonlocal scheduler_task
        app.state.services = services
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

    app = FastAPI(title=settings.app_name, lifespan=lifespan)
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
