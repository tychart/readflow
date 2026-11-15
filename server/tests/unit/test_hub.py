import asyncio

from app.core.hub import WebSocketHub


class _FakeSocket:
    """Minimal ASGI websocket: records frames, optionally never completes."""

    def __init__(self, *, hangs: bool = False) -> None:
        self.hangs = hangs
        self.accepted = False
        self.messages: list[str] = []

    async def accept(self) -> None:
        self.accepted = True

    async def send_text(self, message: str) -> None:
        if self.hangs:
            await asyncio.sleep(60)
        self.messages.append(message)


async def test_broadcast_delivers_to_every_connection():
    hub = WebSocketHub()
    first, second = _FakeSocket(), _FakeSocket()
    await hub.connect(first, user_id="u1", is_admin=False)  # type: ignore[arg-type]
    await hub.connect(second, user_id="u1", is_admin=False)  # type: ignore[arg-type]

    await hub.send_to_user("u1", {"type": "chunk_ready"})

    assert first.messages == second.messages
    assert '"chunk_ready"' in first.messages[0]


async def test_broadcast_drops_a_client_that_cannot_keep_up(monkeypatch):
    """A stalled viewer must not freeze the scheduler tick.

    Broadcasts run on the scheduling loop's path, so an unresponsive client
    blocked by TCP backpressure would stop rendering with nothing logged.
    """
    monkeypatch.setattr("app.core.hub.BROADCAST_TIMEOUT_SECONDS", 0.01)
    hub = WebSocketHub()
    responsive, stalled = _FakeSocket(), _FakeSocket(hangs=True)
    await hub.connect(responsive, user_id="u1", is_admin=False)  # type: ignore[arg-type]
    await hub.connect(stalled, user_id="u1", is_admin=False)  # type: ignore[arg-type]

    await hub.send_to_user("u1", {"type": "chunk_ready"})

    assert len(responsive.messages) == 1
    assert stalled.messages == []
    assert stalled not in hub._connections
    assert responsive in hub._connections


async def test_a_user_only_receives_their_own_events() -> None:
    hub = WebSocketHub()
    mine, theirs = _FakeSocket(), _FakeSocket()
    await hub.connect(mine, user_id="u1", is_admin=False)  # type: ignore[arg-type]
    await hub.connect(theirs, user_id="u2", is_admin=False)  # type: ignore[arg-type]

    await hub.send_to_user("u1", {"type": "chunk_ready", "payload": {"job": "a"}})

    assert len(mine.messages) == 1
    assert theirs.messages == []


async def test_admin_events_reach_admins_only() -> None:
    hub = WebSocketHub()
    admins, user = _FakeSocket(), _FakeSocket()
    await hub.connect(admins, user_id="u1", is_admin=True)  # type: ignore[arg-type]
    await hub.connect(user, user_id="u2", is_admin=False)  # type: ignore[arg-type]

    await hub.broadcast_to_admins({"type": "scheduler_state"})

    assert len(admins.messages) == 1
    assert user.messages == []


async def test_disconnect_forgets_the_connection() -> None:
    hub = WebSocketHub()
    socket = _FakeSocket()
    await hub.connect(socket, user_id="u1", is_admin=False)  # type: ignore[arg-type]
    await hub.disconnect(socket)  # type: ignore[arg-type]

    await hub.send_to_user("u1", {"type": "chunk_ready"})
    assert socket.messages == []
