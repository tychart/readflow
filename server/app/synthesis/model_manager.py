from __future__ import annotations

from time import monotonic

from app.core.config import RuntimeConfig
from app.jobs.models import ModelState
from app.synthesis.provider import SynthesisProvider
from app.telemetry.service import TelemetryService


class ModelManager:
    def __init__(
        self,
        provider: SynthesisProvider,
        telemetry: TelemetryService,
        config: RuntimeConfig,
    ) -> None:
        self._provider = provider
        self._telemetry = telemetry
        self._config = config
        self._state = ModelState.UNLOADED
        self._loaded_model_id: str | None = None
        self._last_used_at: float | None = None

    @property
    def state(self) -> ModelState:
        return self._state

    async def ensure_loaded(self, model_id: str) -> None:
        if self._loaded_model_id == model_id and self._state in {
            ModelState.WARM_IDLE,
            ModelState.BUSY,
        }:
            self._touch()
            return
        self._state = ModelState.LOADING
        self._telemetry.set_model_state(self._state)
        await self._provider.load_model(model_id)
        self._loaded_model_id = model_id
        self._state = ModelState.WARM_IDLE
        self._touch()

    async def unload(self) -> None:
        if self._state == ModelState.UNLOADED:
            return
        self._state = ModelState.EVICTING
        self._telemetry.set_model_state(self._state)
        await self._provider.unload_model()
        self._loaded_model_id = None
        self._state = ModelState.UNLOADED
        self._last_used_at = None
        self._telemetry.set_model_state(self._state)
        self._telemetry.set_idle_deadline(None)

    def mark_busy(self) -> None:
        self._state = ModelState.BUSY
        self._touch()

    def mark_idle(self) -> None:
        self._state = ModelState.WARM_IDLE if self._loaded_model_id else ModelState.UNLOADED
        self._touch()

    async def maybe_unload_idle(self) -> None:
        if not self._loaded_model_id or self._last_used_at is None:
            return
        deadline = self._last_used_at + self._config.idle_unload_seconds
        self._telemetry.set_idle_deadline(deadline)
        if monotonic() >= deadline and self._state != ModelState.BUSY:
            await self.unload()

    async def memory_stats(self) -> tuple[int, int]:
        return await self._provider.memory_stats()

    def _touch(self) -> None:
        self._last_used_at = monotonic()
        self._telemetry.set_model_state(self._state)
        if self._last_used_at is None:
            self._telemetry.set_idle_deadline(None)
        else:
            self._telemetry.set_idle_deadline(self._last_used_at + self._config.idle_unload_seconds)
