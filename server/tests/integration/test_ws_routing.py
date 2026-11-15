"""WebSocket authentication and per-user event routing.

Two properties are security-relevant, so they are tested over a real socket:

- a handshake without a valid session cookie is refused (close 1008) rather than
  connected and filtered later;
- an event addressed to one user's job never reaches another user's socket.
"""

from __future__ import annotations

import pytest
from starlette.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from app.core.identity import DEFAULT_USER_PASSWORD, DEFAULT_USER_USERNAME


def test_a_handshake_without_a_session_is_refused(app) -> None:
    with TestClient(app) as client:
        with pytest.raises(WebSocketDisconnect) as exc:
            with client.websocket_connect("/api/ws") as websocket:
                websocket.receive_text()
    assert exc.value.code == 1008


def test_an_authenticated_handshake_connects_and_answers_ping(app) -> None:
    with TestClient(app) as client:
        login = client.post(
            "/api/auth/login",
            json={"username": DEFAULT_USER_USERNAME, "password": DEFAULT_USER_PASSWORD},
        )
        assert login.status_code == 200
        with client.websocket_connect("/api/ws") as websocket:
            # The seeded user is an admin, so the first frame is the telemetry
            # snapshot that only admins receive.
            assert websocket.receive_json()["type"] == "telemetry"
            websocket.send_text("ping")
            assert websocket.receive_json()["type"] == "pong"


async def test_events_only_reach_their_owner(app, services) -> None:
    """`send_to_user` is the routing rule: no client-side filtering anywhere."""
    from app.core.hub import WebSocketHub

    hub = WebSocketHub()

    class _Socket:
        def __init__(self) -> None:
            self.messages: list[str] = []

        async def accept(self) -> None:
            return None

        async def send_text(self, message: str) -> None:
            self.messages.append(message)

    mine, theirs = _Socket(), _Socket()
    await hub.connect(mine, user_id=services.user_id, is_admin=False)  # type: ignore[arg-type]
    await hub.connect(theirs, user_id="someone-else", is_admin=False)  # type: ignore[arg-type]

    await hub.send_to_user(services.user_id, {"type": "job_updated", "payload": {"id": "job-1"}})

    assert len(mine.messages) == 1
    assert theirs.messages == []


async def test_admin_events_do_not_reach_normal_users(app, services) -> None:
    from app.core.hub import WebSocketHub

    hub = WebSocketHub()

    class _Socket:
        def __init__(self) -> None:
            self.messages: list[str] = []

        async def accept(self) -> None:
            return None

        async def send_text(self, message: str) -> None:
            self.messages.append(message)

    admin, reader = _Socket(), _Socket()
    await hub.connect(admin, user_id="admin", is_admin=True)  # type: ignore[arg-type]
    await hub.connect(reader, user_id="reader", is_admin=False)  # type: ignore[arg-type]

    await hub.broadcast_to_admins({"type": "scheduler_state", "payload": {}})

    assert len(admin.messages) == 1
    assert reader.messages == []


async def test_disabling_a_user_closes_an_open_socket() -> None:
    """A live stream must not outlive the session that authorised it."""
    from app.core.hub import WebSocketHub

    hub = WebSocketHub()

    class _Socket:
        def __init__(self) -> None:
            self.closed = False
            self.code: int | None = None

        async def accept(self) -> None:
            return None

        async def send_text(self, message: str) -> None:
            return None

        async def close(self, code: int = 1000) -> None:
            self.closed = True
            self.code = code

    reader = _Socket()
    await hub.connect(reader, user_id="reader", is_admin=False)  # type: ignore[arg-type]

    await hub.disconnect_user("reader")

    assert reader.closed is True
    assert reader.code == 1008
