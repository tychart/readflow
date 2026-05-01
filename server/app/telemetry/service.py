from __future__ import annotations

from collections import deque
from dataclasses import asdict, dataclass
from time import time

from app.jobs.models import ModelState


@dataclass(slots=True)
class BatchMetric:
    batch_size: int
    duration_seconds: float
    reserved_vram_mb: int
    allocated_vram_mb: int
    at: float


class TelemetryService:
    def __init__(self, recent_events_limit: int) -> None:
        self._recent_batches: deque[BatchMetric] = deque(maxlen=100)
        self._recent_events: deque[dict[str, object]] = deque(maxlen=recent_events_limit)
        self._queue_depth: int = 0
        self._model_state: ModelState = ModelState.UNLOADED
        self._idle_deadline: float | None = None
        self._oom_count = 0

    def record_event(self, event_type: str, payload: dict[str, object]) -> None:
        self._recent_events.appendleft({"type": event_type, "payload": payload, "at": time()})

    def record_batch(
        self,
        batch_size: int,
        duration_seconds: float,
        reserved_vram_mb: int,
        allocated_vram_mb: int,
    ) -> None:
        self._recent_batches.appendleft(
            BatchMetric(
                batch_size=batch_size,
                duration_seconds=duration_seconds,
                reserved_vram_mb=reserved_vram_mb,
                allocated_vram_mb=allocated_vram_mb,
                at=time(),
            )
        )

    def record_oom(self) -> None:
        self._oom_count += 1
        self.record_event("oom", {"count": self._oom_count})

    def set_queue_depth(self, queue_depth: int) -> None:
        self._queue_depth = queue_depth

    def set_model_state(self, state: ModelState) -> None:
        self._model_state = state

    def set_idle_deadline(self, deadline: float | None) -> None:
        self._idle_deadline = deadline

    def snapshot(self) -> dict[str, object]:
        return {
            "queue_depth": self._queue_depth,
            "model_state": self._model_state,
            "idle_deadline": self._idle_deadline,
            "oom_count": self._oom_count,
            "recent_batches": [asdict(metric) for metric in self._recent_batches],
            "recent_events": list(self._recent_events),
        }
