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
    await hub.connect(first)  # type: ignore[arg-type]
    await hub.connect(second)  # type: ignore[arg-type]

    await hub.broadcast({"type": "chunk_ready"})

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
    await hub.connect(responsive)  # type: ignore[arg-type]
    await hub.connect(stalled)  # type: ignore[arg-type]

    await hub.broadcast({"type": "chunk_ready"})

    assert len(responsive.messages) == 1
    assert stalled.messages == []
    assert stalled not in hub._connections
    assert responsive in hub._connections
