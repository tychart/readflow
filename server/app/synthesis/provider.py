from __future__ import annotations

import asyncio
import io
import math
import struct
import wave
from dataclasses import dataclass
from typing import Protocol

from app.jobs.models import ChunkRecord
from app.voices.registry import VoicePrompt


class SynthesisOOMError(RuntimeError):
    pass


@dataclass(slots=True)
class RawSynthesisResult:
    wav_bytes: bytes
    reserved_vram_mb: int
    allocated_vram_mb: int


class SynthesisProvider(Protocol):
    async def load_model(self, model_id: str) -> None: ...
    async def unload_model(self) -> None: ...
    async def synthesize_batch(
        self, model_id: str, chunks: list[ChunkRecord], prompts: list[VoicePrompt]
    ) -> list[RawSynthesisResult]: ...
    async def memory_stats(self) -> tuple[int, int]: ...


class FakeQwenProvider:
    def __init__(self) -> None:
        self._loaded = False

    async def load_model(self, model_id: str) -> None:
        await asyncio.sleep(0.01)
        self._loaded = True

    async def unload_model(self) -> None:
        await asyncio.sleep(0)
        self._loaded = False

    async def synthesize_batch(
        self, model_id: str, chunks: list[ChunkRecord], prompts: list[VoicePrompt]
    ) -> list[RawSynthesisResult]:
        if not self._loaded:
            raise RuntimeError("Model is not loaded")
        del model_id, prompts
        batch_size = len(chunks)
        total_chars = sum(len(chunk.text) for chunk in chunks)
        if batch_size > 6 or total_chars > 2400:
            raise SynthesisOOMError("Synthetic OOM triggered for oversized batch")
        await asyncio.sleep(0.01 * batch_size)
        reserved = 2600 + batch_size * 250 + total_chars // 12
        allocated = int(reserved * 0.84)
        return [
            RawSynthesisResult(
                wav_bytes=self._build_wave_bytes(chunk.index, chunk.text),
                reserved_vram_mb=reserved,
                allocated_vram_mb=allocated,
            )
            for chunk in chunks
        ]

    async def memory_stats(self) -> tuple[int, int]:
        if not self._loaded:
            return (0, 0)
        return (3100, 2500)

    def _build_wave_bytes(self, seed: int, text: str) -> bytes:
        sample_rate = 22050
        seconds = max(1.0, min(12.0, len(text) / 22.0))
        total_frames = int(sample_rate * seconds)
        frequency = 220.0 + (seed % 5) * 35.0
        amplitude = 12000
        buffer = io.BytesIO()
        with wave.open(buffer, "wb") as wav_file:
            wav_file.setnchannels(1)
            wav_file.setsampwidth(2)
            wav_file.setframerate(sample_rate)
            for frame in range(total_frames):
                sample = int(amplitude * math.sin(2 * math.pi * frequency * (frame / sample_rate)))
                wav_file.writeframes(struct.pack("<h", sample))
        return buffer.getvalue()


class QwenProvider:
    async def load_model(self, model_id: str) -> None:
        raise RuntimeError(
            f"Qwen provider is not wired yet for model '{model_id}'. "
            "Set READFLOW_TTS_PROVIDER=fake for development and tests."
        )

    async def unload_model(self) -> None:
        return None

    async def synthesize_batch(
        self, model_id: str, chunks: list[ChunkRecord], prompts: list[VoicePrompt]
    ) -> list[RawSynthesisResult]:
        raise RuntimeError(
            f"Qwen provider is not wired yet for model '{model_id}'. "
            "Set READFLOW_TTS_PROVIDER=fake for development and tests."
        )

    async def memory_stats(self) -> tuple[int, int]:
        return (0, 0)
