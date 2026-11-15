"""Structural guards for the async storage seam.

The conversion from synchronous to asynchronous storage is mechanical, and the
two ways it can silently rot are both invisible in a green test run:

1. a forgotten `await`, which returns a coroutine object instead of a value
   (usually surfacing later as a nonsensical comparison, or not at all);
2. a new route or service method that is still synchronous, so it cannot be
   awaited by the Postgres adapter's callers.

This module asserts the shape rather than the behaviour: every route handler and
FastAPI dependency is a coroutine function, every public service and repository
method is one, and the in-memory adapter implements exactly the protocol surface.
That last check is why a new protocol method cannot be added to one adapter and
forgotten in the other.
"""

from __future__ import annotations

import inspect

import pytest
from fastapi.routing import APIRoute, APIWebSocketRoute

from app.core.app import create_app
from app.db import memory, protocols
from app.jobs.manager import JobManager
from app.library.progress_service import ProgressService
from app.library.service import LibraryService
from app.users.preferences import UserPreferencesService

SERVICES = (JobManager, LibraryService, ProgressService, UserPreferencesService)

# Routes that are deliberately not part of the API surface.
PUBLIC_ROUTES = {"/health", "/api/ws"}


def _public_functions(owner: type) -> list[tuple[str, object]]:
    return [
        (name, value)
        for name, value in vars(owner).items()
        if not name.startswith("_") and inspect.isfunction(value)
    ]


def test_every_route_handler_is_a_coroutine() -> None:
    app = create_app()
    handlers = [
        route.endpoint for route in app.routes if isinstance(route, (APIRoute, APIWebSocketRoute))
    ]
    assert handlers, "no routes registered"
    synchronous = [
        handler.__name__ for handler in handlers if not inspect.iscoroutinefunction(handler)
    ]
    assert synchronous == []


def test_every_route_dependency_is_a_coroutine() -> None:
    app = create_app()

    def walk(dependant) -> list[str]:
        found = []
        for dependency in dependant.dependencies:
            if not inspect.iscoroutinefunction(dependency.call):
                found.append(getattr(dependency.call, "__name__", repr(dependency.call)))
            found.extend(walk(dependency))
        return found

    offenders: list[str] = []
    for route in app.routes:
        if isinstance(route, (APIRoute, APIWebSocketRoute)):
            offenders.extend(walk(route.dependant))
    assert offenders == []


@pytest.mark.parametrize("service", SERVICES, ids=lambda service: service.__name__)
def test_every_public_service_method_is_a_coroutine(service: type) -> None:
    blocked = sorted(
        name
        for name, _ in _public_functions(service)
        if not inspect.iscoroutinefunction(getattr(service, name))
    )
    assert blocked == []


@pytest.mark.parametrize(
    "protocol",
    [
        protocols.UserRepository,
        protocols.SessionRepository,
        protocols.FolderRepository,
        protocols.JobRepository,
        protocols.JobSourceRepository,
        protocols.ProgressRepository,
        protocols.TrashRepository,
    ],
    ids=lambda protocol: protocol.__name__,
)
def test_memory_adapter_implements_the_whole_protocol_asynchronously(protocol: type) -> None:
    adapter = {
        "UserRepository": memory.MemoryUserRepository,
        "SessionRepository": memory.MemorySessionRepository,
        "FolderRepository": memory.MemoryFolderRepository,
        "JobRepository": memory.MemoryJobRepository,
        "JobSourceRepository": memory.MemoryJobSourceRepository,
        "ProgressRepository": memory.MemoryProgressRepository,
        "TrashRepository": memory.MemoryTrashRepository,
    }[protocol.__name__]

    declared = [
        name
        for name, value in vars(protocol).items()
        if not name.startswith("_") and callable(value)
    ]
    missing = [name for name in declared if not callable(getattr(adapter, name, None))]
    synchronous = [
        name
        for name in declared
        if inspect.isfunction(getattr(adapter, name, None))
        and not inspect.iscoroutinefunction(getattr(adapter, name))
    ]
    assert missing == []
    assert synchronous == []
