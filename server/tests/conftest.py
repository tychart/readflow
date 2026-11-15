"""Shared test fixtures.

Two scopes, deliberately separate:

- `app_services` is the process-wide graph (scheduler, GPU, media, hub, auth).
- `services` is the **user scope** a request would get, plus read-only access to
  the process-wide attributes so existing tests stay readable.

`TestServices` is test-only and exists so a test can say `services.jobs` (what a
handler gets) and `services.scheduler` (what the process owns) without threading
two objects through every signature. Production code has no such object on
purpose: a handler may only reach the user scope.
"""

from __future__ import annotations

import os
from collections.abc import AsyncIterator
from uuid import uuid4

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient

from app.core.app import create_app
from app.core.identity import DEFAULT_USER_PASSWORD, DEFAULT_USER_USERNAME
from app.core.services import AppServices
from app.core.user_services import UserServices, build_user_services


class Harness:
    """Test-only facade over the two service scopes."""

    def __init__(self, app_services: AppServices, user: UserServices) -> None:
        self._app = app_services
        self._user = user

    # ── user scope (what a request handler sees) ────────────────────────────
    @property
    def jobs(self):
        return self._user.jobs

    @property
    def library(self):
        return self._user.library

    @property
    def progress(self):
        return self._user.progress

    @property
    def preferences(self):
        return self._user.preferences

    @property
    def user(self):
        return self._user.user

    @property
    def user_id(self) -> str:
        return self._user.user_id

    # ── system scope (what the process owns) ────────────────────────────────
    def __getattr__(self, name: str):
        return getattr(self._app, name)


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
    # Tests always run on the in-memory adapter, whatever the shell exported.
    monkeypatch.delenv("DATABASE_URL", raising=False)
    monkeypatch.delenv("READFLOW_DATABASE_URL", raising=False)
    return create_app()


@pytest_asyncio.fixture
async def app_services(app) -> AsyncIterator[AppServices]:
    """The process-wide graph, with the lifespan running."""
    async with app.router.lifespan_context(app):
        yield app.state.services


@pytest_asyncio.fixture
async def client(app, app_services) -> AsyncIterator[AsyncClient]:
    """An authenticated client, acting as the seeded in-memory user."""
    del app_services
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://testserver") as test_client:
        response = await test_client.post(
            "/api/auth/login",
            json={"username": DEFAULT_USER_USERNAME, "password": DEFAULT_USER_PASSWORD},
        )
        assert response.status_code == 200, response.text
        yield test_client


@pytest_asyncio.fixture
async def anonymous_client(app, app_services) -> AsyncIterator[AsyncClient]:
    """A client with no session, for the auth tests."""
    del app_services
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://testserver") as test_client:
        yield test_client


@pytest_asyncio.fixture
async def services(client, app_services) -> AsyncIterator[Harness]:
    """The user scope for the authenticated user, plus the process graph."""
    del client
    async with app_services.database.transaction() as uow:
        user = await uow.users.get_by_username(DEFAULT_USER_USERNAME)
    assert user is not None
    yield Harness(app_services, build_user_services(app_services, user))
