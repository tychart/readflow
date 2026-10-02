from __future__ import annotations

import asyncio
from collections import defaultdict
from time import time

from app.chunking.planner import ChunkPlanner
from app.core.config import RuntimeConfig
from app.core.hub import WebSocketHub
from app.jobs.manager import JobManager
from app.jobs.models import ChunkRecord, ChunkStatus, Job, JobStatus
from app.schemas.api import (
    AdminQueueResponse,
    QueueBatch,
    QueueChunkResponse,
    QueueChunkVersionResponse,
    WsEnvelope,
    chunk_to_response,
    job_to_summary,
)
from app.synthesis.model_manager import ModelManager
from app.synthesis.provider import ModelVRAMError, SynthesisOOMError
from app.synthesis.worker import SynthesisWorker
from app.telemetry.service import TelemetryService


class SchedulerService:
    MEMORY_STATS_INTERVAL = 3.0

    def __init__(
        self,
        config: RuntimeConfig,
        chunk_mime_type: str,
        job_manager: JobManager,
        planner: ChunkPlanner,
        worker: SynthesisWorker,
        model_manager: ModelManager,
        telemetry: TelemetryService,
        hub: WebSocketHub,
    ) -> None:
        self._config = config
        self._chunk_mime_type = chunk_mime_type
        self._job_manager = job_manager
        self._planner = planner
        self._worker = worker
        self._model_manager = model_manager
        self._telemetry = telemetry
        self._hub = hub
        self._stop_event = asyncio.Event()
        self._memory_broadcast_task: asyncio.Task[None] | None = None

    async def run_forever(self) -> None:
        self._start_memory_broadcast()
        try:
            while not self._stop_event.is_set():
                await self.run_once()
                await asyncio.sleep(self._config.planning_tick_seconds)
        finally:
            self._stop_memory_broadcast()

    async def shutdown(self) -> None:
        self._stop_event.set()
        self._stop_memory_broadcast()

    def _start_memory_broadcast(self) -> None:
        self._memory_broadcast_task = asyncio.create_task(self._memory_broadcast_loop())

    def _stop_memory_broadcast(self) -> None:
        if self._memory_broadcast_task is not None:
            self._memory_broadcast_task.cancel()
            self._memory_broadcast_task = None

    async def _memory_broadcast_loop(self) -> None:
        while not self._stop_event.is_set():
            try:
                mem_raw = await self._model_manager.memory_stats()
                await self._hub.broadcast(
                    WsEnvelope(
                        type="memory_stats",
                        payload={
                            "memory": {
                                "device": mem_raw[0],
                                "vram_total_mb": mem_raw[1],
                                "vram_used_mb": mem_raw[2],
                                "vram_reserved_mb": mem_raw[3],
                                "vram_free_mb": mem_raw[4],
                                "ram_total_mb": mem_raw[5],
                                "ram_free_mb": mem_raw[6],
                                "ram_used_mb": mem_raw[7],
                            },
                        },
                    ).model_dump()
                )
            except Exception:
                pass
            try:
                await asyncio.sleep(self.MEMORY_STATS_INTERVAL)
            except asyncio.CancelledError:
                break

    async def run_once(self) -> None:
        self._ensure_planned_chunks()
        renderable = self._rank_renderable_chunks()
        self._telemetry.set_queue_depth(self._job_manager.queue_depth())
        if renderable:
            await self._render_next_batch(renderable)
        await self._model_manager.maybe_unload_idle()
        await self._broadcast_scheduler_state()

    async def _broadcast_scheduler_state(self) -> None:
        """Push a lightweight scheduler tick to the admin views.

        The full queue (chunk text, priorities) is fetched over HTTP by the
        admin queue page; this only carries the counters plus the identity of
        the batch currently being rendered, so that view can refresh live
        without polling and without re-sending the whole queue every tick.
        """
        active_batch = self._active_batch()
        await self._hub.broadcast(
            WsEnvelope(
                type="scheduler_state",
                payload={
                    "queue_depth": self._job_manager.queue_depth(),
                    "batch_candidates": self._config.batch_candidates_small_model,
                    "active_batch": (
                        active_batch.model_dump() if active_batch is not None else None
                    ),
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

    def _priority_band(self, job: Job) -> int:
        """Return the scheduler's coarse priority band for a job.

        Bands are the first component of `_chunk_priority` and are what the
        scheduler orders jobs by: active listeners short on buffer first, then
        active listeners, then queued jobs, with paused jobs excluded last.
        """
        if job.status == JobStatus.PAUSED:
            return 99
        if job.is_active_listening and job.buffered_seconds < self._config.target_buffer_seconds:
            return 0
        if job.is_active_listening:
            return 1
        return 2

    def _priority_info(self, job: Job, chunk: ChunkRecord) -> tuple[int, str, str]:
        """Translate a priority band into an operator-facing label and reason."""
        band = self._priority_band(job)
        target = self._config.target_buffer_seconds
        if band == 99:
            return band, "Paused", "Paused job \u2014 excluded from scheduling."
        if band == 0:
            return (
                band,
                "Urgent",
                f"Active listener with {job.buffered_seconds:.1f}s buffered "
                f"(below {target}s target).",
            )
        if band == 1:
            return (
                band,
                "High",
                f"Active listener with {job.buffered_seconds:.1f}s buffered "
                f"(target of {target}s met).",
            )
        return band, "Normal", "Queued job with no active listener."

    def _group_chunks(
        self, chunks: list[ChunkRecord]
    ) -> dict[tuple[str, str, str], list[ChunkRecord]]:
        """Group chunks by the scheduler's batch key: model, language, voice.

        One batch is always drawn from a single group, so preserving insertion
        order here is what makes the highest-priority group win.
        """
        grouped: dict[tuple[str, str, str], list[ChunkRecord]] = defaultdict(list)
        for chunk in chunks:
            job = self._job_manager.get_job(chunk.job_id)
            grouped[(job.model_id, job.language, chunk.voice_id)].append(chunk)
        return dict(grouped)

    def _select_next_batch(
        self,
        ranked_chunks: list[ChunkRecord],
        vram_used_mb: int,
        vram_total_mb: int,
    ) -> tuple[tuple[str, str, str] | None, list[ChunkRecord]]:
        """Pick the next batch exactly as the scheduler would dispatch it.

        Shared by `_render_next_batch` and `queue_snapshot` so the admin queue
        view can mark the real "up next" chunks instead of re-deriving them.
        """
        grouped = self._group_chunks(ranked_chunks)
        if not grouped:
            return None, []
        group_key, chunks = next(iter(grouped.items()))
        batch_size = self._choose_batch_size(len(chunks), vram_used_mb, vram_total_mb)
        return group_key, chunks[:batch_size]

    def _chunk_priority(self, chunk: ChunkRecord) -> tuple[int, int, int]:
        job = self._job_manager.get_job(chunk.job_id)
        return (self._priority_band(job), chunk.index, len(chunk.text))

    async def _render_next_batch(self, ranked_chunks: list[ChunkRecord]) -> None:
        if not ranked_chunks:
            return
        stats = await self._model_manager.memory_stats()
        _device, vram_total, vram_used = stats[0], stats[1], stats[2]
        group_key, batch = self._select_next_batch(ranked_chunks, vram_used, vram_total)
        if group_key is None or not batch:
            return
        model_id = group_key[0]
        for chunk in batch:
            self._job_manager.mark_chunk_queued(chunk)
            self._job_manager.mark_chunk_rendering(chunk)
        # Broadcast once the batch is marked rendering so the admin queue view
        # can show it in flight; the end-of-tick broadcast sees it completed.
        await self._broadcast_scheduler_state()
        try:
            results = await self._worker.render_batch(model_id, batch)
        except SynthesisOOMError as exc:
            for chunk in batch:
                self._job_manager.mark_chunk_failed(chunk, str(exc))
            return
        except ModelVRAMError as exc:
            for chunk in batch:
                self._job_manager.mark_chunk_failed(chunk, f"Failed to load model: {exc}")
            return

        # `strict=False`: the worker shrinks a batch when it hits an OOM and
        # retries, so a short result list is expected here (leftovers are
        # requeued below).
        for chunk, result in zip(batch, results, strict=False):
            job = self._job_manager.mark_chunk_written(
                chunk,
                duration_seconds=result.duration_seconds,
                segment_path=result.segment_path,
                wav_path=result.wav_path,
            )
            message_type = "job_completed" if job.status == JobStatus.COMPLETED else "chunk_ready"
            # Per-chunk events carry the job *summary* plus the single chunk that
            # changed. Sending `job_to_detail` here meant re-serializing the whole
            # source text and every chunk record on each event: for a book that is
            # O(chunks x book size) of WebSocket traffic.
            await self._hub.broadcast(
                WsEnvelope(
                    type=message_type,
                    payload={
                        "job": job_to_summary(job).model_dump(),
                        "chunk": chunk_to_response(job, chunk).model_dump(),
                        "chunk_index": chunk.index,
                        "mime_type": self._chunk_mime_type,
                        "init_segment_url": f"/api/jobs/{job.id}/chunks/init",
                    },
                ).model_dump()
            )

        # The worker shrinks a batch when it hits an OOM and retries. Any chunk
        # it did not return is put back in the queue so it is rendered on a
        # later tick rather than left stuck in `RENDERING`.
        for chunk in batch[len(results) :]:
            self._job_manager.mark_chunk_planned(chunk)

    def _choose_batch_size(self, available: int, vram_used_mb: int, vram_total_mb: int) -> int:
        candidates = list(self._config.batch_candidates_small_model)
        if vram_total_mb > 0 and vram_used_mb / vram_total_mb >= 0.8:
            candidates = [size for size in candidates if size <= 3] or [1]
        for size in candidates:
            if available >= size:
                return size
        return 1

    # ── Admin queue inspection ─────────────────────────────────────────

    def _pending_chunks_for_inspection(self) -> list[ChunkRecord]:
        """All schedulable chunks across jobs, in scheduler priority order.

        Unlike `JobManager.renderable_chunks()`, this also includes chunks that
        are already `QUEUED`/`RENDERING` so the admin view can show the batch in
        flight. Written, stale, failed, deprecated, and stale-plan-version chunks
        are excluded because the scheduler will never act on them.
        """
        chunks = [
            chunk
            for job in self._job_manager.list_jobs()
            for chunk in job.chunks
            if chunk.plan_version == job.plan_version
            and not chunk.deprecated
            and chunk.status in {ChunkStatus.PLANNED, ChunkStatus.QUEUED, ChunkStatus.RENDERING}
        ]
        return sorted(chunks, key=self._chunk_priority)

    def _active_batch(self) -> QueueBatch | None:
        """The batch currently in flight, derived from `RENDERING` status.

        No extra scheduler state is needed: chunks are flipped to `RENDERING`
        immediately before `render_batch` and to `WRITTEN` after, so the
        rendering set *is* the active batch.
        """
        rendering = [
            chunk
            for job in self._job_manager.list_jobs()
            for chunk in job.chunks
            if chunk.status == ChunkStatus.RENDERING and chunk.plan_version == job.plan_version
        ]
        if not rendering:
            return None
        grouped = self._group_chunks(rendering)
        (model_id, language, voice_id), chunks = next(iter(grouped.items()))
        return QueueBatch(
            chunk_count=len(chunks),
            model_id=model_id,
            language=language,
            voice_id=voice_id,
            started_at=min(chunk.updated_at for chunk in chunks),
        )

    def _batch_summary(self, batch: list[ChunkRecord]) -> QueueBatch | None:
        """Summarize an already-selected batch (no start time)."""
        if not batch:
            return None
        job = self._job_manager.get_job(batch[0].job_id)
        return QueueBatch(
            chunk_count=len(batch),
            model_id=job.model_id,
            language=job.language,
            voice_id=batch[0].voice_id,
            started_at=None,
        )

    def queue_snapshot(self) -> AdminQueueResponse:
        """Build the admin queue read-model.

        Deliberately synchronous and free of provider calls. The real provider
        runs synthesis on a worker thread, so awaiting `memory_stats()` here
        would queue behind an in-flight batch and block for the entire synthesis
        (the admin tab looked empty because its request never returned). That
        await also yielded the event loop mid-snapshot, letting the scheduler
        mutate chunk statuses between collection and serialization, which
        produced self-inconsistent responses (e.g. `queue_depth: 0` alongside a
        chunk already marked `written`). Everything below runs in one turn.

        Ordering, priority bands, and the predicted next batch all come from the
        same helpers the real scheduler uses, so the admin view cannot drift
        from what the scheduler will actually do.
        """
        pending = self._pending_chunks_for_inspection()
        renderable = self._rank_renderable_chunks()
        # The next batch is a prediction. It is sized without live VRAM figures
        # (that would require the blocking provider call described above); the
        # real dispatch still applies the VRAM-aware downshift in
        # `_render_next_batch`.
        _next_key, next_batch = self._select_next_batch(renderable, 0, 0)
        next_batch_ids = {(chunk.job_id, chunk.index, chunk.version) for chunk in next_batch}

        items: list[QueueChunkResponse] = []
        for rank, chunk in enumerate(pending, start=1):
            job = self._job_manager.get_job(chunk.job_id)
            band, label, reason = self._priority_info(job, chunk)
            versions = sorted(
                (item for item in job.chunks if item.index == chunk.index),
                key=lambda item: item.version,
            )
            items.append(
                QueueChunkResponse(
                    job_id=job.id,
                    job_title=job.title,
                    job_status=job.status,
                    job_is_active_listening=job.is_active_listening,
                    job_buffered_seconds=job.buffered_seconds,
                    job_target_buffer_seconds=self._config.target_buffer_seconds,
                    index=chunk.index,
                    version=chunk.version,
                    status=chunk.status,
                    plan_version=chunk.plan_version,
                    voice_id=chunk.voice_id,
                    language=chunk.language,
                    model_id=job.model_id,
                    text=chunk.text,
                    char_start=chunk.char_start,
                    char_end=chunk.char_end,
                    char_count=len(chunk.text),
                    estimated_duration_seconds=max(
                        1.0, len(chunk.text) / self._config.estimated_chars_per_second
                    ),
                    priority_band=band,
                    priority_label=label,
                    priority_reason=reason,
                    rank=rank,
                    is_rendering=chunk.status == ChunkStatus.RENDERING,
                    in_next_batch=(chunk.job_id, chunk.index, chunk.version) in next_batch_ids,
                    created_at=chunk.created_at,
                    updated_at=chunk.updated_at,
                    error=chunk.error,
                    versions=[
                        QueueChunkVersionResponse(
                            version=item.version,
                            status=item.status,
                            deprecated=item.deprecated,
                        )
                        for item in versions
                    ],
                )
            )

        return AdminQueueResponse(
            generated_at=time(),
            queue_depth=self._job_manager.queue_depth(),
            active_batch=self._active_batch(),
            next_batch=self._batch_summary(next_batch),
            items=items,
        )
