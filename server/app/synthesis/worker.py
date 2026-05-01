from __future__ import annotations

from dataclasses import dataclass
from time import monotonic

from app.core.config import RuntimeConfig
from app.jobs.models import ChunkRecord
from app.media.store import MediaStore
from app.synthesis.model_manager import ModelManager
from app.synthesis.provider import SynthesisOOMError, SynthesisProvider
from app.telemetry.service import TelemetryService
from app.voices.registry import VoiceRegistry


@dataclass(slots=True)
class RenderedChunkResult:
    chunk_index: int
    segment_path: str
    init_segment_path: str
    duration_seconds: float
    reserved_vram_mb: int
    allocated_vram_mb: int


class SynthesisWorker:
    def __init__(
        self,
        config: RuntimeConfig,
        provider: SynthesisProvider,
        model_manager: ModelManager,
        media_store: MediaStore,
        voice_registry: VoiceRegistry,
        telemetry: TelemetryService,
    ) -> None:
        self._config = config
        self._provider = provider
        self._model_manager = model_manager
        self._media_store = media_store
        self._voice_registry = voice_registry
        self._telemetry = telemetry

    async def render_batch(
        self, model_id: str, chunks: list[ChunkRecord]
    ) -> list[RenderedChunkResult]:
        if not chunks:
            return []
        await self._model_manager.ensure_loaded(model_id)
        prompts = [self._voice_registry.get_prompt(chunk.voice_id) for chunk in chunks]
        start = monotonic()
        self._model_manager.mark_busy()
        try:
            results = await self._provider.synthesize_batch(model_id, chunks, prompts)
        except SynthesisOOMError:
            self._telemetry.record_oom()
            if len(chunks) == 1:
                self._model_manager.mark_idle()
                raise
            retry_size = max(1, len(chunks) - 1)
            results = await self._provider.synthesize_batch(
                model_id, chunks[:retry_size], prompts[:retry_size]
            )
            chunks = chunks[:retry_size]
        packaged: list[RenderedChunkResult] = []
        for chunk, result in zip(chunks, results, strict=True):
            stored = self._media_store.package_wav_chunk(
                chunk.job_id, chunk.index, result.wav_bytes
            )
            packaged.append(
                RenderedChunkResult(
                    chunk_index=chunk.index,
                    segment_path=stored.segment_path,
                    init_segment_path=stored.init_segment_path,
                    duration_seconds=stored.duration_seconds,
                    reserved_vram_mb=result.reserved_vram_mb,
                    allocated_vram_mb=result.allocated_vram_mb,
                )
            )
        duration = monotonic() - start
        last = packaged[-1] if packaged else RenderedChunkResult(0, "", "", 0.0, 0, 0)
        self._telemetry.record_batch(
            batch_size=len(packaged),
            duration_seconds=duration,
            reserved_vram_mb=last.reserved_vram_mb,
            allocated_vram_mb=last.allocated_vram_mb,
        )
        self._model_manager.mark_idle()
        return packaged
