from __future__ import annotations

from time import monotonic

from app.core.config import RuntimeConfig
from app.jobs.models import ModelState
from app.synthesis.provider import ModelVRAMError, SynthesisProvider
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
        self._last_error: str | None = None

    @property
    def state(self) -> ModelState:
        return self._state

    @property
    def last_error(self) -> str | None:
        """Description of the most recent load/synthesis failure, if any."""
        return self._last_error

    def set_device(self, device: str) -> None:
        self._provider.set_device(device)
        # If the model was in NOT_ENOUGH_VRAM state and the device setting
        # changed, reset to UNLOADED so the next load attempt can succeed.
        if self._state == ModelState.NOT_ENOUGH_VRAM:
            self._state = ModelState.UNLOADED
            self._telemetry.set_model_state(self._state)

    async def ensure_loaded(self, model_id: str) -> None:
        if self._loaded_model_id == model_id and self._state in {
            ModelState.WARM_IDLE,
            ModelState.BUSY,
        }:
            self._touch()
            return
        # A previous failure (out of VRAM, timeout, bad load) is cleared before
        # retrying so the next attempt always starts from a known state.
        if self._state in {ModelState.NOT_ENOUGH_VRAM, ModelState.ERROR}:
            self._state = ModelState.UNLOADED
        self._state = ModelState.LOADING
        self._telemetry.set_model_state(self._state)
        try:
            await self._provider.load_model(model_id)
        except ModelVRAMError as exc:
            self._state = ModelState.NOT_ENOUGH_VRAM
            self._loaded_model_id = None
            self._last_used_at = None
            self._last_error = str(exc)
            self._telemetry.set_model_state(self._state)
            raise
        except Exception as exc:
            # Anything that is not a VRAM error (network failure, missing
            # dependency, timed-out/hung load) must still resolve the state out
            # of LOADING. Leaving it there made the model look permanently busy
            # and hid the real failure from the admin view.
            self._state = ModelState.ERROR
            self._loaded_model_id = None
            self._last_used_at = None
            self._last_error = f"{type(exc).__name__}: {exc}"
            self._telemetry.set_model_state(self._state)
            self._telemetry.record_event("model_load_error", {"error": self._last_error})
            raise
        self._loaded_model_id = model_id
        self._state = ModelState.WARM_IDLE
        self._last_error = None
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
        self._last_error = None
        self._telemetry.set_model_state(self._state)
        self._telemetry.set_idle_deadline(None)

    async def reset_provider(self) -> None:
        """Recover from an errored or hung provider without a server restart.

        Calls the provider's synchronous `reset` (never the worker executor,
        which may be the thing that is stuck), discards all cached model state,
        and returns to UNLOADED so the next batch triggers a fresh load.
        """
        self._state = ModelState.EVICTING
        self._telemetry.set_model_state(self._state)
        self._provider.reset()
        self._loaded_model_id = None
        self._last_used_at = None
        self._last_error = None
        self._state = ModelState.UNLOADED
        self._telemetry.set_model_state(self._state)
        self._telemetry.set_idle_deadline(None)
        self._telemetry.record_event("provider_reset", {})

    def mark_error(self, message: str) -> None:
        """Flag an unrecoverable provider failure (e.g. a timed-out call).

        Sets `ModelState.ERROR`, which makes the scheduler stop dispatching new
        batches until `reset_provider` is called.
        """
        self._state = ModelState.ERROR
        self._last_error = message
        self._telemetry.set_model_state(self._state)
        self._telemetry.record_event("model_error", {"error": message})

    def mark_busy(self) -> None:
        self._state = ModelState.BUSY
        self._touch()

    def mark_idle(self) -> None:
        # Never let the end of a batch clobber an ERROR transition: that state
        # is the circuit breaker the scheduler reads on the next tick.
        if self._state == ModelState.ERROR:
            return
        self._state = ModelState.WARM_IDLE if self._loaded_model_id else ModelState.UNLOADED
        self._touch()

    async def maybe_unload_idle(self, *, has_pending_work: bool = False) -> None:
        if not self._loaded_model_id or self._last_used_at is None:
            return
        deadline = self._last_used_at + self._config.idle_unload_seconds
        self._telemetry.set_idle_deadline(deadline)
        # Keep VRAM while there is still unrendered work, even across long gaps;
        # the model is the thing that will do that work. It is released only
        # once the queue is empty and the idle timeout has elapsed.
        if has_pending_work:
            return
        if monotonic() >= deadline and self._state != ModelState.BUSY:
            await self.unload()

    async def memory_stats(self) -> tuple[str, int, int, int, int, int, int, int, str]:
        stats = await self._provider.memory_stats()
        _is_cuda, vram_total, vram_allocated = stats[0], stats[1], stats[2]
        vram_reserved, vram_free, ram_total, ram_free = stats[3], stats[4], stats[5], stats[6]
        ram_used, resolved_device = stats[7], stats[8]
        # Use the resolved device from the provider when the model is loaded.
        # During loading/evicting transitions, use the state label.
        if self._state in {ModelState.LOADING, ModelState.EVICTING}:
            device = self._state
        elif self._state in {ModelState.WARM_IDLE, ModelState.BUSY} and self._loaded_model_id:
            device = resolved_device
        else:
            device = "unloaded"
        return (
            device,
            vram_total,
            vram_allocated,
            vram_reserved,
            vram_free,
            ram_total,
            ram_free,
            ram_used,
            resolved_device,
        )

    def _touch(self) -> None:
        self._last_used_at = monotonic()
        self._telemetry.set_model_state(self._state)
        if self._last_used_at is None:
            self._telemetry.set_idle_deadline(None)
        else:
            self._telemetry.set_idle_deadline(self._last_used_at + self._config.idle_unload_seconds)
