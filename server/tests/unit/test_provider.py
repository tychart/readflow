from __future__ import annotations

import asyncio
from typing import Any, ClassVar, cast

import pytest

from app.jobs.models import ChunkRecord
from app.synthesis.provider import ModelVRAMError, QwenProvider
from app.voices.registry import VoicePrompt


class _FakeCudaDeviceProperties:
    total_memory = 11 * 1024 * 1024 * 1024  # 11 GB


class _FakeCuda:
    @staticmethod
    def is_available() -> bool:
        return True

    @staticmethod
    def reset_peak_memory_stats() -> None:
        return None

    @staticmethod
    def synchronize() -> None:
        return None

    @staticmethod
    def max_memory_allocated() -> int:
        return 128 * 1024 * 1024

    @staticmethod
    def max_memory_reserved() -> int:
        return 256 * 1024 * 1024

    @staticmethod
    def memory_allocated(device: int | None = None) -> int:
        return 64 * 1024 * 1024

    @staticmethod
    def memory_reserved(device: int | None = None) -> int:
        return 96 * 1024 * 1024

    @staticmethod
    def get_device_properties(device: int) -> _FakeCudaDeviceProperties:
        return _FakeCudaDeviceProperties()

    @staticmethod
    def empty_cache() -> None:
        return None


class _FakeCudaNotAvailable:
    @staticmethod
    def is_available() -> bool:
        return False

    @staticmethod
    def reset_peak_memory_stats() -> None:
        return None

    @staticmethod
    def synchronize() -> None:
        return None

    @staticmethod
    def max_memory_allocated() -> int:
        return 0

    @staticmethod
    def max_memory_reserved() -> int:
        return 0

    @staticmethod
    def memory_allocated(device: int | None = None) -> int:
        return 0

    @staticmethod
    def memory_reserved(device: int | None = None) -> int:
        return 0

    @staticmethod
    def get_device_properties(device: int) -> None:
        raise RuntimeError("CUDA not available")

    @staticmethod
    def empty_cache() -> None:
        return None


class _FakeTorch:
    bfloat16 = object()
    float32 = object()
    cuda = _FakeCuda()


class _FakeTorchNoCuda:
    bfloat16 = object()
    float32 = object()
    cuda = _FakeCudaNotAvailable()


class _FakeQwenModel:
    def __init__(self) -> None:
        self.prompt_calls: list[tuple[str, str, bool]] = []
        self.generate_calls: list[dict[str, object]] = []

    def create_voice_clone_prompt(
        self, *, ref_audio: str, ref_text: str, x_vector_only_mode: bool
    ) -> object:
        self.prompt_calls.append((ref_audio, ref_text, x_vector_only_mode))
        return {"voice": ref_audio, "text": ref_text}

    def generate_voice_clone(
        self,
        *,
        text: list[str],
        language: str,
        voice_clone_prompt: list[object],
        **kwargs: object,
    ) -> tuple[list[object], int]:
        self.generate_calls.append(
            {
                "text": text,
                "language": language,
                "voice_clone_prompt": voice_clone_prompt,
                **kwargs,
            }
        )
        return (["wave-1", "wave-2"], 22050)


class _LongWave:
    """Stand-in waveform with a controlled token length.

    The provider measures generated audio to detect a sequence that ran into the
    token budget instead of emitting EOS, so a fake just needs `len()`.
    """

    def __init__(self, seconds: float, sample_rate: int = 22050) -> None:
        self._length = int(seconds * sample_rate)

    def __len__(self) -> int:
        return self._length


class _FakeQwenFactory:
    created_models: ClassVar[list[_FakeQwenModel]] = []

    @classmethod
    def from_pretrained(cls, *args, **kwargs) -> _FakeQwenModel:
        model = _FakeQwenModel()
        cls.created_models.append(model)
        return model


class _FakeQwenOomOnCudaFactory:
    """Factory that raises OOM when loading on CUDA, succeeds on CPU."""

    created_models: ClassVar[list[_FakeQwenModel]] = []

    @classmethod
    def from_pretrained(cls, *args, **kwargs) -> _FakeQwenModel:
        device = kwargs.get("device_map", "cpu")
        if device.startswith("cuda"):
            raise RuntimeError("CUDA out of memory. Tried to allocate ...")
        model = _FakeQwenModel()
        cls.created_models.append(model)
        return model


async def _run_sync_in_place(callback, *args):
    return callback(*args)


def _make_provider_module_cuda(monkeypatch: pytest.MonkeyPatch) -> None:
    from app.synthesis import provider as provider_module

    monkeypatch.setattr(
        provider_module,
        "_import_qwen_runtime",
        lambda: (_FakeTorch, _FakeQwenFactory),
    )


def _make_provider_module_no_cuda(monkeypatch: pytest.MonkeyPatch) -> None:
    from app.synthesis import provider as provider_module

    monkeypatch.setattr(
        provider_module,
        "_import_qwen_runtime",
        lambda: (_FakeTorchNoCuda, _FakeQwenFactory),
    )


def _make_provider_module_oom_on_cuda(monkeypatch: pytest.MonkeyPatch) -> None:
    from app.synthesis import provider as provider_module

    monkeypatch.setattr(
        provider_module,
        "_import_qwen_runtime",
        lambda: (_FakeTorch, _FakeQwenOomOnCudaFactory),
    )


def _setup_provider(monkeypatch: pytest.MonkeyPatch, device: str = "auto") -> QwenProvider:
    provider = QwenProvider(default_language="English", device=device)
    monkeypatch.setattr(provider, "_call_in_worker", _run_sync_in_place)
    monkeypatch.setattr(provider, "_waveform_to_wav_bytes", lambda waveform, sample_rate: b"wav")
    return provider


def test_qwen_provider_batches_list_inputs_and_reuses_prompt_objects(monkeypatch):
    from app.synthesis import provider as provider_module

    monkeypatch.setattr(
        provider_module,
        "_import_qwen_runtime",
        lambda: (_FakeTorch, _FakeQwenFactory),
    )

    provider = QwenProvider(default_language="English")
    monkeypatch.setattr(provider, "_call_in_worker", _run_sync_in_place)
    monkeypatch.setattr(provider, "_waveform_to_wav_bytes", lambda waveform, sample_rate: b"wav")

    asyncio.run(provider.load_model("Qwen/Qwen3-TTS-12Hz-0.6B-Base"))

    prompt = VoicePrompt(
        voice_id="suzy",
        reference_text="Reference text",
        reference_audio_path="/tmp/suzy.wav",
    )
    chunks = [
        ChunkRecord(
            job_id="job-1",
            index=0,
            text="Hello there.",
            voice_id="suzy",
            plan_version=1,
            char_start=0,
            char_end=12,
            language="English",
        ),
        ChunkRecord(
            job_id="job-1",
            index=1,
            text="General Kenobi.",
            voice_id="suzy",
            plan_version=1,
            char_start=13,
            char_end=28,
            language="English",
        ),
    ]

    results = asyncio.run(
        provider.synthesize_batch("Qwen/Qwen3-TTS-12Hz-0.6B-Base", chunks, [prompt, prompt])
    )

    model = _FakeQwenFactory.created_models[-1]
    call = cast(dict[str, Any], model.generate_calls[-1])
    voice_clone_prompt = cast(list[object], call["voice_clone_prompt"])

    assert call["text"] == ["Hello there.", "General Kenobi."]
    assert call["language"] == "English"
    assert len(voice_clone_prompt) == 2
    assert voice_clone_prompt[0] is voice_clone_prompt[1]
    assert model.prompt_calls == [("/tmp/suzy.wav", "Reference text", False)]
    assert len(results) == 2
    assert all(result.wav_bytes == b"wav" for result in results)


def test_qwen_provider_repeats_list_like_prompts_using_batch_script_shape(monkeypatch):
    from app.synthesis import provider as provider_module

    monkeypatch.setattr(
        provider_module,
        "_import_qwen_runtime",
        lambda: (_FakeTorch, _FakeQwenFactory),
    )

    provider = QwenProvider(default_language="English")
    monkeypatch.setattr(provider, "_call_in_worker", _run_sync_in_place)
    monkeypatch.setattr(provider, "_waveform_to_wav_bytes", lambda waveform, sample_rate: b"wav")

    asyncio.run(provider.load_model("Qwen/Qwen3-TTS-12Hz-0.6B-Base"))

    model = _FakeQwenFactory.created_models[-1]
    model.create_voice_clone_prompt = lambda **kwargs: ["prompt-token"]

    prompt = VoicePrompt(
        voice_id="suzy",
        reference_text="Reference text",
        reference_audio_path="/tmp/suzy.wav",
    )
    chunks = [
        ChunkRecord(
            job_id="job-1",
            index=0,
            text="Hello there.",
            voice_id="suzy",
            plan_version=1,
            char_start=0,
            char_end=12,
            language="English",
        ),
        ChunkRecord(
            job_id="job-1",
            index=1,
            text="General Kenobi.",
            voice_id="suzy",
            plan_version=1,
            char_start=13,
            char_end=28,
            language="English",
        ),
    ]

    asyncio.run(
        provider.synthesize_batch("Qwen/Qwen3-TTS-12Hz-0.6B-Base", chunks, [prompt, prompt])
    )

    call = cast(dict[str, Any], model.generate_calls[-1])
    voice_clone_prompt = cast(list[str], call["voice_clone_prompt"])
    assert voice_clone_prompt == ["prompt-token", "prompt-token"]


# ─── Device mode tests ─────────────────────────────────────────────────


def test_set_device_updates_provider_device(monkeypatch):
    _make_provider_module_cuda(monkeypatch)
    provider = _setup_provider(monkeypatch, device="auto")

    assert provider._device == "auto"

    provider.set_device("cpu")
    assert provider._device == "cpu"

    provider.set_device("gpu")
    assert provider._device == "gpu"

    provider.set_device("auto")
    assert provider._device == "auto"


def test_cpu_device_loads_on_cpu_only(monkeypatch):
    _make_provider_module_cuda(monkeypatch)
    provider = _setup_provider(monkeypatch, device="cpu")

    asyncio.run(provider.load_model("Qwen/Qwen3-TTS-12Hz-0.6B-Base"))

    # Verify it was loaded on CPU (resolved_device should be "cpu")
    assert provider._resolved_device == "cpu"


def test_gpu_device_with_cuda_available_loads_on_gpu(monkeypatch):
    _make_provider_module_cuda(monkeypatch)
    provider = _setup_provider(monkeypatch, device="gpu")

    asyncio.run(provider.load_model("Qwen/Qwen3-TTS-12Hz-0.6B-Base"))

    assert provider._resolved_device == "cuda:0"


def test_gpu_device_without_cuda_raises_model_vram_error(monkeypatch):
    _make_provider_module_no_cuda(monkeypatch)
    provider = _setup_provider(monkeypatch, device="gpu")

    with pytest.raises(ModelVRAMError, match="CUDA is not available"):
        asyncio.run(provider.load_model("Qwen/Qwen3-TTS-12Hz-0.6B-Base"))

    # Model should not be marked as loaded
    assert provider._loaded_model_id is None
    assert provider._model is None


def test_gpu_device_with_oom_raises_model_vram_error(monkeypatch):
    """GPU mode should not fall back to CPU on OOM — it should raise."""
    _make_provider_module_oom_on_cuda(monkeypatch)
    provider = _setup_provider(monkeypatch, device="gpu")

    with pytest.raises(ModelVRAMError, match="Not enough VRAM"):
        asyncio.run(provider.load_model("Qwen/Qwen3-TTS-12Hz-0.6B-Base"))

    assert provider._loaded_model_id is None
    assert provider._model is None


def test_auto_device_with_oom_falls_back_to_cpu(monkeypatch):
    """Auto mode should fall back to CPU when GPU OOM occurs at load time."""
    _make_provider_module_oom_on_cuda(monkeypatch)
    provider = _setup_provider(monkeypatch, device="auto")

    asyncio.run(provider.load_model("Qwen/Qwen3-TTS-12Hz-0.6B-Base"))

    # Should have successfully loaded on CPU after GPU OOM
    assert provider._loaded_model_id == "Qwen/Qwen3-TTS-12Hz-0.6B-Base"
    assert provider._model is not None
    assert provider._resolved_device == "cpu"
    assert len(_FakeQwenOomOnCudaFactory.created_models) == 1


def test_auto_device_with_cuda_loads_on_gpu(monkeypatch):
    """Auto mode should prefer GPU when CUDA is available."""
    _make_provider_module_cuda(monkeypatch)
    provider = _setup_provider(monkeypatch, device="auto")

    asyncio.run(provider.load_model("Qwen/Qwen3-TTS-12Hz-0.6B-Base"))

    assert provider._resolved_device == "cuda:0"


def test_auto_device_without_cuda_loads_on_cpu(monkeypatch):
    """Auto mode should fall back to CPU when CUDA is not available."""
    _make_provider_module_no_cuda(monkeypatch)
    provider = _setup_provider(monkeypatch, device="auto")

    asyncio.run(provider.load_model("Qwen/Qwen3-TTS-12Hz-0.6B-Base"))

    assert provider._resolved_device == "cpu"


def test_set_device_then_load_uses_new_device(monkeypatch):
    """Changing device via set_device then loading should use the new device."""
    _make_provider_module_cuda(monkeypatch)
    provider = _setup_provider(monkeypatch, device="auto")

    asyncio.run(provider.load_model("Qwen/Qwen3-TTS-12Hz-0.6B-Base"))
    assert provider._resolved_device == "cuda:0"

    # Evict and switch to CPU
    asyncio.run(provider.unload_model())
    provider.set_device("cpu")

    asyncio.run(provider.load_model("Qwen/Qwen3-TTS-12Hz-0.6B-Base"))
    assert provider._resolved_device == "cpu"


def test_validate_environment_gpu_without_cuda_raises(monkeypatch):
    _make_provider_module_no_cuda(monkeypatch)
    provider = _setup_provider(monkeypatch, device="gpu")

    with pytest.raises(RuntimeError, match="CUDA is not available"):
        provider.validate_environment()


def test_validate_environment_cpu_never_raises(monkeypatch):
    """CPU mode should always pass validation, even without CUDA."""
    _make_provider_module_no_cuda(monkeypatch)
    provider = _setup_provider(monkeypatch, device="cpu")

    provider.validate_environment()  # should not raise


def test_validate_environment_auto_without_cuda_passes(monkeypatch):
    """Auto mode should pass validation even without CUDA."""
    _make_provider_module_no_cuda(monkeypatch)
    provider = _setup_provider(monkeypatch, device="auto")

    provider.validate_environment()  # should not raise


def _chunk(index: int, text: str) -> ChunkRecord:
    return ChunkRecord(
        job_id="job-1",
        index=index,
        text=text,
        voice_id="suzy",
        plan_version=1,
        char_start=0,
        char_end=len(text),
        language="English",
    )


def test_generation_budget_tracks_expected_chunk_duration():
    """The token budget is an upper bound on audio length, not the model default.

    Qwen's default (2048 tokens ≈ 170s per sequence) let one degenerate sample
    hold a whole batch — the multi-minute stall that looked like a dead
    scheduler.
    """
    provider = QwenProvider(estimated_chars_per_second=18.0, synthesis_token_headroom=1.4)

    long_chunk = _chunk(0, "x" * 700)
    short_chunk = _chunk(1, "Hi.")

    # 700 chars ≈ 38.9s of audio ≈ 467 codec tokens, times the 1.4 headroom.
    assert provider._generation_budget([long_chunk, short_chunk]) == int(700 / 18 * 12 * 1.4)
    # Tiny chunks still get a usable floor rather than a single-digit budget.
    assert provider._generation_budget([short_chunk]) == 600


def test_provider_regenerates_only_the_chunk_that_hit_the_budget(monkeypatch):
    _make_provider_module_cuda(monkeypatch)
    provider = _setup_provider(monkeypatch)
    asyncio.run(provider.load_model("Qwen/Qwen3-TTS-12Hz-0.6B-Base"))
    model = _FakeQwenFactory.created_models[-1]

    def generate(*, text, language, voice_clone_prompt, **kwargs):
        model.generate_calls.append(
            {
                "text": text,
                "language": language,
                "voice_clone_prompt": voice_clone_prompt,
                **kwargs,
            }
        )
        if len(text) > 1:
            # The second sequence never emitted EOS and ran into the budget.
            return ([_LongWave(1.0), _LongWave(999.0)], 22050)
        return ([_LongWave(1.0)], 22050)

    model.generate_voice_clone = generate  # type: ignore[method-assign]

    prompt = VoicePrompt(
        voice_id="suzy",
        reference_text="Reference text",
        reference_audio_path="/tmp/suzy.wav",
    )
    chunks = [_chunk(0, "Hello there."), _chunk(1, "General Kenobi.")]

    results = asyncio.run(
        provider.synthesize_batch("Qwen/Qwen3-TTS-12Hz-0.6B-Base", chunks, [prompt, prompt])
    )

    # The batch is asked with the derived budget, not the model default.
    assert model.generate_calls[0]["max_new_tokens"] == 600
    # Only the degenerate chunk is re-asked, alone, with a single prompt and
    # double the budget (capped at the model default).
    assert model.generate_calls[1]["text"] == ["General Kenobi."]
    assert model.generate_calls[1]["max_new_tokens"] == 1200
    assert len(cast(list[object], model.generate_calls[1]["voice_clone_prompt"])) == 1
    assert all(result.truncated is False for result in results)


def test_provider_flags_a_chunk_that_is_still_truncated_after_the_retry(monkeypatch):
    _make_provider_module_cuda(monkeypatch)
    provider = _setup_provider(monkeypatch)
    asyncio.run(provider.load_model("Qwen/Qwen3-TTS-12Hz-0.6B-Base"))
    model = _FakeQwenFactory.created_models[-1]

    def generate(*, text, language, voice_clone_prompt, **kwargs):
        model.generate_calls.append(
            {
                "text": text,
                "language": language,
                "voice_clone_prompt": voice_clone_prompt,
                **kwargs,
            }
        )
        return ([_LongWave(999.0) for _ in text], 22050)

    model.generate_voice_clone = generate  # type: ignore[method-assign]

    prompt = VoicePrompt(
        voice_id="suzy",
        reference_text="Reference text",
        reference_audio_path="/tmp/suzy.wav",
    )
    chunks = [_chunk(0, "Hello there."), _chunk(1, "General Kenobi.")]

    results = asyncio.run(
        provider.synthesize_batch("Qwen/Qwen3-TTS-12Hz-0.6B-Base", chunks, [prompt, prompt])
    )

    assert [result.truncated for result in results] == [True, True]
