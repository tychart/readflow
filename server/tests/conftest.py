from __future__ import annotations

import os
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient

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
    monkeypatch.setenv("READFLOW_TEMP_DIR_NAME", f"readflow-test-{uuid4()}")
    return create_app()


@pytest.fixture
def client(app):
    with TestClient(app) as test_client:
        yield test_client


@pytest.fixture
def services(app):
    with TestClient(app):
        yield app.state.services
