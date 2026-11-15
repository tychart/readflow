"""Live events, routed by owner.

The hub is the **only** place that decides who receives an event. Call sites say
*who* owns the event (`send_to_user(job.user_id)`) or `broadcast_to_admins`, and
never filter on the client: a filter in the browser is a leak with extra steps.

Ownership table (also in AGENTS.md):

| event | recipients |
|---|---|
| `job_created`, `job_updated`, `chunk_ready`, `job_completed` | the job's owner |
| `job_progress`, `library_changed` | the job's owner |
| `scheduler_state`, `memory_stats`, `model_state` | admins |
| `telemetry`, `admin_config_updated` | admins |

A connection remembers who it is, so a token that is revoked (logout, password
change, disable) takes effect on the next send: the hub drops sockets whose
session no longer resolves.
"""

from __future__ import annotations

import asyncio
import json
from collections.abc import Iterable
from dataclasses import dataclass, field

from fastapi import WebSocket

# A client that stops reading (a sleeping phone tab, a suspended laptop) applies
# TCP backpressure, so `send_text` can block for as long as the peer stays
# away. Every broadcast sits on the scheduling tick's path, which means one
# stalled viewer could freeze rendering with nothing logged. Frames are small
# (a chunk delta is ~1 KiB), so a healthy client fails this instantly.
BROADCAST_TIMEOUT_SECONDS = 5.0


@dataclass(slots=True)
class _Connection:
    websocket: WebSocket
    user_id: str
    is_admin: bool
    queue: asyncio.Queue[str] = field(default_factory=asyncio.Queue)


class WebSocketHub:
    def __init__(self) -> None:
        self._connections: dict[WebSocket, _Connection] = {}
        self._lock = asyncio.Lock()

    async def connect(self, websocket: WebSocket, *, user_id: str, is_admin: bool) -> None:
        await websocket.accept()
        async with self._lock:
            self._connections[websocket] = _Connection(
                websocket=websocket, user_id=user_id, is_admin=is_admin
            )

    async def disconnect(self, websocket: WebSocket) -> None:
        async with self._lock:
            self._connections.pop(websocket, None)

    async def disconnect_user(self, user_id: str, *, code: int = 1008) -> None:
        """Close every socket owned by one user.

        Used when the account is disabled or its password is reset: dropping the
        session row stops new requests, and this stops the live stream that is
        already open. Closing is best-effort — a socket that refuses to close is
        simply forgotten.
        """
        async with self._lock:
            connections = [
                connection
                for connection in self._connections.values()
                if connection.user_id == user_id
            ]
            for connection in connections:
                self._connections.pop(connection.websocket, None)
        for connection in connections:
            try:
                await asyncio.wait_for(
                    connection.websocket.close(code=code), timeout=BROADCAST_TIMEOUT_SECONDS
                )
            except Exception:
                continue

    async def send_to_user(self, user_id: str, payload: dict[str, object]) -> None:
        """Deliver to every connection owned by one user."""
        if not user_id:
            return
        async with self._lock:
            targets: Iterable[_Connection] = tuple(
                connection
                for connection in self._connections.values()
                if connection.user_id == user_id
            )
        await self._deliver_all(targets, json.dumps(payload))

    async def broadcast_to_admins(self, payload: dict[str, object]) -> None:
        """Deliver to admin connections only (never to a normal user)."""
        async with self._lock:
            targets: Iterable[_Connection] = tuple(
                connection for connection in self._connections.values() if connection.is_admin
            )
        await self._deliver_all(targets, json.dumps(payload))

    async def _deliver_all(self, connections: Iterable[_Connection], message: str) -> None:
        # Send concurrently and bound each delivery, so one unresponsive client
        # costs at most one timeout rather than one timeout per client.
        failed = await asyncio.gather(
            *(self._deliver(connection, message) for connection in connections)
        )
        stale = [connection for connection in failed if connection is not None]
        if stale:
            async with self._lock:
                for connection in stale:
                    self._connections.pop(connection.websocket, None)

    async def _deliver(self, connection: _Connection, message: str) -> _Connection | None:
        """Send one frame, returning the connection when it should be dropped."""
        try:
            await asyncio.wait_for(
                connection.websocket.send_text(message), timeout=BROADCAST_TIMEOUT_SECONDS
            )
        except Exception:
            # Disconnected, broken, or too slow to keep up. Dropping the entry
            # is enough: the endpoint's receive loop exits on the next client
            # disconnect.
            return connection
        return None
