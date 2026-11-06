from __future__ import annotations

import asyncio
import json
from collections.abc import Iterable

from fastapi import WebSocket

# A client that stops reading (a sleeping phone tab, a suspended laptop) applies
# TCP backpressure, so `send_text` can block for as long as the peer stays
# away. Every broadcast sits on the scheduling tick's path, which means one
# stalled viewer could freeze rendering with nothing logged. Frames are small
# (a chunk delta is ~1 KiB), so a healthy client fails this instantly.
BROADCAST_TIMEOUT_SECONDS = 5.0


class WebSocketHub:
    def __init__(self) -> None:
        self._connections: set[WebSocket] = set()
        self._lock = asyncio.Lock()

    async def connect(self, websocket: WebSocket) -> None:
        await websocket.accept()
        async with self._lock:
            self._connections.add(websocket)

    async def disconnect(self, websocket: WebSocket) -> None:
        async with self._lock:
            self._connections.discard(websocket)

    async def broadcast(self, payload: dict[str, object]) -> None:
        message = json.dumps(payload)
        async with self._lock:
            connections: Iterable[WebSocket] = tuple(self._connections)
        # Send concurrently and bound each delivery, so one unresponsive client
        # costs at most one timeout rather than one timeout per client.
        failed = await asyncio.gather(*(self._deliver(ws, message) for ws in connections))
        stale = [websocket for websocket in failed if websocket is not None]
        if stale:
            async with self._lock:
                for websocket in stale:
                    self._connections.discard(websocket)

    async def _deliver(self, websocket: WebSocket, message: str) -> WebSocket | None:
        """Send one frame, returning the socket when it should be dropped."""
        try:
            await asyncio.wait_for(websocket.send_text(message), timeout=BROADCAST_TIMEOUT_SECONDS)
        except Exception:
            # Disconnected, broken, or too slow to keep up. Dropping the entry
            # is enough: the endpoint's receive loop skips the send and exits on
            # the next client disconnect.
            return websocket
        return None
