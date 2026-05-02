from __future__ import annotations

import os
from uuid import uuid4

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient

from app.core.app import create_app


def pytest_collection_modifyitems(items: list[pytest.Item]) -> None:
    if os.getenv("READFLOW_ENABLE_REAL_MODEL_TESTS") == "1":
        return
    skip_marker = pytest.mark.skip(reason="Set READFLOW_ENABLE_REAL_MODEL_TESTS=1 to run")
    for item in items:
        if "real_model" in item.keywords:
            item.add_marker(skip_marker)


@pytest.fixture
def app(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("READFLOW_TTS_PROVIDER", "fake")
    monkeypatch.setenv("READFLOW_SCHEDULER_AUTOSTART", "false")
    monkeypatch.setenv("READFLOW_TEMP_DIR_NAME", f"readflow-test-{uuid4()}")
    return create_app()


@pytest_asyncio.fixture
async def client(app):
    async with app.router.lifespan_context(app):
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://testserver") as test_client:
            yield test_client


@pytest_asyncio.fixture
async def services(client, app):
    del client
    yield app.state.services
