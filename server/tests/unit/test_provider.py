from __future__ import annotations

import asyncio
from typing import Any, ClassVar, cast

from app.jobs.models import ChunkRecord
from app.synthesis.provider import QwenProvider
from app.voices.registry import VoicePrompt


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
    def memory_allocated() -> int:
        return 64 * 1024 * 1024

    @staticmethod
    def memory_reserved() -> int:
        return 96 * 1024 * 1024

    @staticmethod
    def empty_cache() -> None:
        return None


class _FakeTorch:
    bfloat16 = object()
    cuda = _FakeCuda()


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
        self, *, text: list[str], language: str, voice_clone_prompt: list[object]
    ) -> tuple[list[object], int]:
        self.generate_calls.append(
            {
                "text": text,
                "language": language,
                "voice_clone_prompt": voice_clone_prompt,
            }
        )
        return (["wave-1", "wave-2"], 22050)


class _FakeQwenFactory:
    created_models: ClassVar[list[_FakeQwenModel]] = []

    @classmethod
    def from_pretrained(cls, *args, **kwargs) -> _FakeQwenModel:
        model = _FakeQwenModel()
        cls.created_models.append(model)
        return model


async def _run_sync_in_place(callback, *args):
    return callback(*args)


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
