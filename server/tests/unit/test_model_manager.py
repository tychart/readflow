from __future__ import annotations

import pytest

from app.core.config import RuntimeConfig
from app.jobs.models import ModelState
from app.synthesis.model_manager import ModelManager
from app.synthesis.provider import ModelVRAMError
from app.telemetry.service import TelemetryService


class _FakeProvider:
    """Minimal provider for testing ModelManager device-related behavior."""

    def __init__(self) -> None:
        self._device: str = "auto"
        self.load_called_with: list[str] = []
        self.unload_called: int = 0

    def validate_environment(self) -> None:
        return None

    def set_device(self, device: str) -> None:
        self._device = device

    async def load_model(self, model_id: str) -> None:
        self.load_called_with.append(model_id)

    async def unload_model(self) -> None:
        self.unload_called += 1

    async def synthesize_batch(self, *args, **kwargs):
        raise RuntimeError("Not implemented in test provider")

    async def memory_stats(self):
        return (False, 0, 0, 0, 0, 16384, 10240, 4096, "cpu")


class _FakeOomProvider:
    """Provider that raises ModelVRAMError on load_model."""

    def __init__(self) -> None:
        self._device: str = "auto"
        self.load_called_with: list[str] = []

    def validate_environment(self) -> None:
        return None

    def set_device(self, device: str) -> None:
        self._device = device

    async def load_model(self, model_id: str) -> None:
        self.load_called_with.append(model_id)
        raise ModelVRAMError("Not enough VRAM to load model on GPU")

    async def unload_model(self) -> None:
        return None

    async def synthesize_batch(self, *args, **kwargs):
        raise RuntimeError("Not implemented in test provider")

    async def memory_stats(self):
        return (False, 0, 0, 0, 0, 16384, 10240, 4096, "cpu")


@pytest.fixture
def telemetry():
    return TelemetryService(recent_events_limit=50)


@pytest.fixture
def config():
    return RuntimeConfig()


@pytest.fixture
def manager(telemetry, config):
    provider = _FakeProvider()
    return ModelManager(provider, telemetry, config)


@pytest.fixture
def oom_manager(telemetry, config):
    provider = _FakeOomProvider()
    return ModelManager(provider, telemetry, config)


# ─── set_device propagation ──────────────────────────────────────────


def test_set_device_propagates_to_provider(manager):
    manager.set_device("cpu")
    assert manager._provider._device == "cpu"

    manager.set_device("gpu")
    assert manager._provider._device == "gpu"

    manager.set_device("auto")
    assert manager._provider._device == "auto"


def test_set_device_leaves_warm_idle_state_unchanged(manager):
    """Changing device should not auto-evict a loaded model."""
    # Simulate a loaded state
    manager._loaded_model_id = "test-model"
    manager._state = ModelState.WARM_IDLE

    manager.set_device("cpu")

    assert manager._state == ModelState.WARM_IDLE
    assert manager._loaded_model_id == "test-model"


def test_set_device_resets_not_enough_vram_state(manager):
    """Changing device from a NOT_ENOUGH_VRAM state should reset to UNLOADED."""
    manager._state = ModelState.NOT_ENOUGH_VRAM
    manager._loaded_model_id = None

    manager.set_device("cpu")

    assert manager._state == ModelState.UNLOADED
    # Telemetry should have been updated
    snapshot = manager._telemetry.snapshot()
    assert snapshot.get("model_state") == "unloaded"


# ─── ensure_loaded with ModelVRAMError ──────────────────────────────


def test_ensure_loaded_sets_not_enough_vram_on_vram_error(oom_manager):
    """When provider raises ModelVRAMError, state should become NOT_ENOUGH_VRAM."""
    model_id = "Qwen/Qwen3-TTS-12Hz-0.6B-Base"

    with pytest.raises(ModelVRAMError):
        import asyncio

        asyncio.run(oom_manager.ensure_loaded(model_id))

    assert oom_manager.state == ModelState.NOT_ENOUGH_VRAM
    assert oom_manager._loaded_model_id is None

    snapshot = oom_manager._telemetry.snapshot()
    assert snapshot.get("model_state") == "not_enough_vram"


def test_ensure_loaded_clears_not_enough_vram_before_retry(oom_manager):
    """If state is NOT_ENOUGH_VRAM, ensure_loaded should reset to UNLOADED and
    then to LOADING before attempting a load (which may fail again)."""
    model_id = "Qwen/Qwen3-TTS-12Hz-0.6B-Base"

    # First attempt: fails with VRAM error
    with pytest.raises(ModelVRAMError):
        import asyncio

        asyncio.run(oom_manager.ensure_loaded(model_id))

    assert oom_manager.state == ModelState.NOT_ENOUGH_VRAM

    # Second attempt: it should reset to LOADING before hitting the error again
    with pytest.raises(ModelVRAMError):
        import asyncio

        asyncio.run(oom_manager.ensure_loaded(model_id))

    # Should end up in NOT_ENOUGH_VRAM again, but the load was re-tried
    assert oom_manager.state == ModelState.NOT_ENOUGH_VRAM
    assert len(oom_manager._provider.load_called_with) == 2


def test_ensure_loaded_succeeds_after_vram_error_and_device_change(monkeypatch, manager):
    """After NOT_ENOUGH_VRAM, changing device should allow a fresh load."""
    model_id = "Qwen/Qwen3-TTS-12Hz-0.6B-Base"

    # Set state to NOT_ENOUGH_VRAM (simulating a previous GPU OOM)
    manager._state = ModelState.NOT_ENOUGH_VRAM
    manager._loaded_model_id = None

    # Change device to CPU (this should reset the state)
    manager.set_device("cpu")

    # Now load should succeed
    import asyncio

    asyncio.run(manager.ensure_loaded(model_id))

    assert manager.state == ModelState.WARM_IDLE
    assert manager._loaded_model_id == model_id


# ─── ensure_loaded normal path ──────────────────────────────────────


def test_ensure_loaded_changes_state_to_warm_idle(manager):
    """Normal successful load should transition through LOADING → WARM_IDLE."""
    model_id = "Qwen/Qwen3-TTS-12Hz-0.6B-Base"

    import asyncio

    asyncio.run(manager.ensure_loaded(model_id))

    assert manager.state == ModelState.WARM_IDLE
    assert manager._loaded_model_id == model_id
    assert len(manager._provider.load_called_with) == 1


def test_ensure_loaded_skips_redundant_load(manager):
    """Calling ensure_loaded twice with same model_id should only load once."""
    model_id = "Qwen/Qwen3-TTS-12Hz-0.6B-Base"

    import asyncio

    asyncio.run(manager.ensure_loaded(model_id))
    asyncio.run(manager.ensure_loaded(model_id))

    assert len(manager._provider.load_called_with) == 1


def test_unload_works_from_not_enough_vram_state(manager):
    """Unload should work from any state, including NOT_ENOUGH_VRAM."""
    manager._state = ModelState.NOT_ENOUGH_VRAM
    manager._loaded_model_id = None

    import asyncio

    asyncio.run(manager.unload())

    assert manager.state == ModelState.UNLOADED
