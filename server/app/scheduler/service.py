from __future__ import annotations

import asyncio
from collections import defaultdict

from app.chunking.planner import ChunkPlanner
from app.core.config import RuntimeConfig
from app.core.hub import WebSocketHub
from app.jobs.manager import JobManager
from app.jobs.models import ChunkRecord, ChunkStatus, Job, JobStatus
from app.schemas.api import WsEnvelope, job_to_detail
from app.synthesis.model_manager import ModelManager
from app.synthesis.provider import SynthesisOOMError
from app.synthesis.worker import SynthesisWorker
from app.telemetry.service import TelemetryService


class SchedulerService:
    def __init__(
        self,
        config: RuntimeConfig,
        job_manager: JobManager,
        planner: ChunkPlanner,
        worker: SynthesisWorker,
        model_manager: ModelManager,
        telemetry: TelemetryService,
        hub: WebSocketHub,
    ) -> None:
        self._config = config
        self._job_manager = job_manager
        self._planner = planner
        self._worker = worker
        self._model_manager = model_manager
        self._telemetry = telemetry
        self._hub = hub
        self._stop_event = asyncio.Event()

    async def run_forever(self) -> None:
        while not self._stop_event.is_set():
            await self.run_once()
            await asyncio.sleep(self._config.planning_tick_seconds)

    async def shutdown(self) -> None:
        self._stop_event.set()

    async def run_once(self) -> None:
        self._ensure_planned_chunks()
        renderable = self._rank_renderable_chunks()
        self._telemetry.set_queue_depth(self._job_manager.queue_depth())
        if renderable:
            await self._render_next_batch(renderable)
        await self._model_manager.maybe_unload_idle()
        await self._hub.broadcast(
            WsEnvelope(
                type="scheduler_state",
                payload={
                    "queue_depth": self._job_manager.queue_depth(),
                    "batch_candidates": self._config.batch_candidates_small_model,
                },
            ).model_dump()
        )

    def _ensure_planned_chunks(self) -> None:
        for job in self._job_manager.list_jobs():
            if job.status == JobStatus.PAUSED or job.status == JobStatus.COMPLETED:
                continue
            while self._needs_more_planning(job):
                planned = self._planner.plan_next(job)
                if planned is None:
                    break
                self._job_manager.add_planned_chunk(
                    job.id,
                    text=planned.text,
                    char_start=planned.char_start,
                    char_end=planned.char_end,
                    plan_version=job.plan_version,
                    voice_id=job.voice_id,
                )

    def _needs_more_planning(self, job: Job) -> bool:
        active_planned = sum(
            1
            for chunk in job.chunks
            if chunk.status in {ChunkStatus.PLANNED, ChunkStatus.QUEUED, ChunkStatus.RENDERING}
            and chunk.plan_version == job.plan_version
        )
        if job.is_active_listening:
            return job.buffered_seconds < self._config.max_prebuffer_seconds and active_planned < 5
        return active_planned < self._config.inactive_job_ahead_chunks

    def _rank_renderable_chunks(self) -> list[ChunkRecord]:
        chunks = list(self._job_manager.renderable_chunks())
        return sorted(chunks, key=self._chunk_priority)

    def _chunk_priority(self, chunk: ChunkRecord) -> tuple[int, int, int]:
        job = self._job_manager.get_job(chunk.job_id)
        if job.status == JobStatus.PAUSED:
            band = 99
        elif job.is_active_listening and job.buffered_seconds < self._config.target_buffer_seconds:
            band = 0
        elif job.is_active_listening:
            band = 1
        else:
            band = 2
        return (band, chunk.index, len(chunk.text))

    async def _render_next_batch(self, ranked_chunks: list[ChunkRecord]) -> None:
        if not ranked_chunks:
            return
        grouped: dict[tuple[str, str], list[ChunkRecord]] = defaultdict(list)
        for chunk in ranked_chunks:
            job = self._job_manager.get_job(chunk.job_id)
            grouped[(job.model_id, self._length_bucket(chunk))].append(chunk)
        (model_id, _bucket), chunks = next(iter(grouped.items()))
        reserved_vram, _allocated = await self._model_manager.memory_stats()
        batch_size = self._choose_batch_size(len(chunks), reserved_vram)
        batch = chunks[:batch_size]
        for chunk in batch:
            self._job_manager.mark_chunk_queued(chunk)
            self._job_manager.mark_chunk_rendering(chunk)
        try:
            results = await self._worker.render_batch(model_id, batch)
        except SynthesisOOMError as exc:
            for chunk in batch:
                self._job_manager.mark_chunk_failed(chunk, str(exc))
            return

        for chunk, result in zip(batch, results, strict=True):
            job = self._job_manager.mark_chunk_written(
                chunk,
                duration_seconds=result.duration_seconds,
                segment_path=result.segment_path,
            )
            message_type = "job_completed" if job.status == JobStatus.COMPLETED else "chunk_ready"
            await self._hub.broadcast(
                WsEnvelope(
                    type=message_type,
                    payload={
                        "job": job_to_detail(job).model_dump(),
                        "chunk_index": chunk.index,
                    },
                ).model_dump()
            )
            await self._hub.broadcast(
                WsEnvelope(
                    type="job_updated", payload={"job": job_to_detail(job).model_dump()}
                ).model_dump()
            )

    def _length_bucket(self, chunk: ChunkRecord) -> str:
        length = len(chunk.text)
        if length < 150:
            return "short"
        if length < 500:
            return "medium"
        return "long"

    def _choose_batch_size(self, available: int, reserved_vram_mb: int) -> int:
        candidates = list(self._config.batch_candidates_small_model)
        if reserved_vram_mb >= self._config.vram_soft_limit_mb:
            candidates = [size for size in candidates if size <= 3] or [1]
        for size in candidates:
            if available >= size:
                return size
        return 1
