from __future__ import annotations

import asyncio
import logging
from collections import defaultdict
from time import time
from typing import TypedDict

from app.chunking.planner import ChunkPlanner
from app.core.config import RuntimeConfig
from app.core.hub import WebSocketHub
from app.jobs.manager import JobManager
from app.jobs.models import ChunkRecord, ChunkStatus, Job, JobStatus, ModelState
from app.schemas.api import (
    AdminQueueResponse,
    QueueBatch,
    QueueChunkResponse,
    QueueChunkVersionResponse,
    QueueJobGroup,
    WsEnvelope,
    chunk_to_response,
    job_to_summary,
)
from app.synthesis.model_manager import ModelManager
from app.synthesis.worker import SynthesisWorker
from app.telemetry.service import TelemetryService

logger = logging.getLogger(__name__)

# Chunks the scheduler can still act on. Shared so priority ranking and the
# admin queue read-model cannot disagree about what "pending" means.
_PENDING_STATUSES = frozenset({ChunkStatus.PLANNED, ChunkStatus.QUEUED, ChunkStatus.RENDERING})

# Upper bound on rows returned per job by `queue_snapshot`; pending chunks are
# always kept and the rest of the budget goes to the most recent history.
QUEUE_SNAPSHOT_CHUNK_LIMIT = 200


class SchedulerLiveness(TypedDict):
    """Live health of the scheduling loop, surfaced in the admin views."""

    running: bool
    last_tick_at: float | None
    last_error: str | None
    consecutive_errors: int
    warning: str | None


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
        # Liveness, surfaced through /admin/state and the scheduler_state tick.
        self._running = False
        self._last_tick_at: float | None = None
        self._last_error: str | None = None
        self._consecutive_errors = 0
        # Set while dispatch is intentionally paused (e.g. the VRAM hard limit),
        # cleared once a batch is dispatched again.
        self._warning: str | None = None

    def liveness_snapshot(self) -> SchedulerLiveness:
        return {
            "running": self._running,
            "last_tick_at": self._last_tick_at,
            "last_error": self._last_error,
            "consecutive_errors": self._consecutive_errors,
            "warning": self._warning,
        }

    async def run_forever(self) -> None:
        """Run the scheduling loop, surviving any single tick's failure.

        One malformed batch, a provider error, or an ffmpeg failure used to
        escape `run_once` and silently kill this task for the life of the
        process — rendering stopped permanently while HTTP kept serving. A
        failure is now logged, recorded, and retried on the next tick.
        """
        self._running = True
        self._start_memory_broadcast()
        try:
            while not self._stop_event.is_set():
                try:
                    await self.run_once()
                    self._consecutive_errors = 0
                except asyncio.CancelledError:
                    raise
                except Exception as exc:
                    self._consecutive_errors += 1
                    self._last_error = f"{type(exc).__name__}: {exc}"
                    self._telemetry.record_event(
                        "scheduler_error",
                        {"error": self._last_error, "count": self._consecutive_errors},
                    )
                    logger.exception("Scheduler tick failed; continuing")
                # Back off after repeated failures so a persistent error cannot
                # spin the loop (and flood the log) at the tick rate.
                delay = self._config.planning_tick_seconds
                if self._consecutive_errors:
                    exponent = min(self._consecutive_errors, 6)
                    delay = min(5.0, delay * (2**exponent))
                await asyncio.sleep(delay)
        finally:
            self._running = False
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
        self._last_tick_at = time()
        if self._model_manager.state == ModelState.ERROR:
            # A load or synthesis previously timed out; the worker thread may
            # still be stuck. Do not dispatch into it — wait for an operator to
            # reset the provider. Keep broadcasting so the failure is visible
            # instead of the queue silently freezing.
            await self._broadcast_scheduler_state()
            return
        self._ensure_planned_chunks()
        renderable = self._rank_renderable_chunks()
        self._telemetry.set_queue_depth(self._job_manager.queue_depth())
        if renderable:
            await self._render_next_batch(renderable)
        # Keep the model resident while there is work to do; only let it idle
        # out once the queue is genuinely empty.
        await self._model_manager.maybe_unload_idle(
            has_pending_work=self._job_manager.queue_depth() > 0
        )
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
                    **self.liveness_snapshot(),
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
        if active_planned >= self._config.plan_ahead_chunks:
            return False
        if job.is_active_listening and job.buffered_seconds >= self._config.max_prebuffer_seconds:
            return False
        return True

    def _rank_renderable_chunks(self) -> list[ChunkRecord]:
        chunks = list(self._job_manager.renderable_chunks())
        return sorted(chunks, key=self._chunk_priority)

    def _priority_band(self, job: Job) -> int:
        """Return the scheduler's coarse priority band for a job.

        Bands are the first component of `_chunk_priority` and are what the
        scheduler orders jobs by:

        - 0: an active listener below `target_buffer_seconds` \u2014 about to run
          dry, preempts everything else.
        - 1: an active listener between the target and the ideal buffer
          (`max_prebuffer_seconds`). It is not about to dry up, but keeping it
          comfortably ahead is what lets the user raise playback speed or skip
          without hitting the render ceiling.
        - 2: background work \u2014 queued jobs and listeners already at or above
          the ideal buffer. These round-robin together, so a fully-prebuffered
          listener stops monopolising the GPU.
        - 99: paused, excluded.
        """
        if job.status == JobStatus.PAUSED:
            return 99
        if job.is_active_listening:
            if job.buffered_seconds < self._config.target_buffer_seconds:
                return 0
            if job.buffered_seconds < self._config.max_prebuffer_seconds:
                return 1
        return 2

    def _priority_info(self, job: Job, chunk: ChunkRecord) -> tuple[int, str, str]:
        """Translate a priority band into an operator-facing label and reason."""
        band = self._priority_band(job)
        target = self._config.target_buffer_seconds
        ideal = self._config.max_prebuffer_seconds
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
                "Filling",
                f"Active listener with {job.buffered_seconds:.1f}s buffered "
                f"(target {target}s met, below the {ideal}s ideal buffer).",
            )
        if job.is_active_listening:
            return (
                band,
                "Buffered",
                f"Active listener with {job.buffered_seconds:.1f}s buffered "
                f"(ideal {ideal}s met) \u2014 shares the lowest band with background work.",
            )
        return band, "Background", "Queued job with no active listener."

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
        vram_reserved_mb: int,
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
        batch_size = self._choose_batch_size(len(chunks), vram_reserved_mb, vram_total_mb)
        return group_key, chunks[:batch_size]

    def _chunk_priority(self, chunk: ChunkRecord) -> tuple[int, int, int]:
        job = self._job_manager.get_job(chunk.job_id)
        return (self._priority_band(job), chunk.index, len(chunk.text))

    async def _render_next_batch(self, ranked_chunks: list[ChunkRecord]) -> None:
        if not ranked_chunks:
            return
        stats = await self._model_manager.memory_stats()
        # stats[1] is total VRAM, stats[3] is reserved (what nvidia-smi shows).
        vram_total, vram_reserved = stats[1], stats[3]
        if self._hard_limit_exceeded(vram_reserved):
            self._set_warning(
                f"VRAM hard limit reached ({vram_reserved} MB >= "
                f"{self._config.vram_hard_limit_mb} MB); dispatch paused. "
                "Evict the model or raise the hard limit in Admin."
            )
            return
        group_key, batch = self._select_next_batch(ranked_chunks, vram_reserved, vram_total)
        if group_key is None or not batch:
            return
        self._clear_warning()
        model_id = group_key[0]
        for chunk in batch:
            self._job_manager.mark_chunk_queued(chunk)
            self._job_manager.mark_chunk_rendering(chunk)
        # Broadcast once the batch is marked rendering so the admin queue view
        # can show it in flight; the end-of-tick broadcast sees it completed.
        await self._broadcast_scheduler_state()
        try:
            results = await self._worker.render_batch(model_id, batch)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            # Never let one bad batch kill the loop. The chunks are retried
            # within their attempt budget; once that is spent only those chunks
            # are marked failed and the job keeps rendering its other chunks.
            logger.exception("Batch render failed for %d chunk(s)", len(batch))
            self._handle_batch_failure(batch, exc)
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

    def _handle_batch_failure(self, batch: list[ChunkRecord], error: Exception) -> None:
        """Requeue or fail the chunks of a batch that raised.

        Retries are bounded by `chunk_max_attempts`; when the budget is spent
        the chunk is marked failed and skipped. Either way the job is left
        alive — a single poison chunk must not stop a whole book.
        """
        message = f"{type(error).__name__}: {error}"
        for chunk in batch:
            if chunk.attempts + 1 >= self._config.chunk_max_attempts:
                self._job_manager.mark_chunk_failed(chunk, message)
            else:
                self._job_manager.mark_chunk_retry(chunk, message)
        self._telemetry.record_event("batch_failed", {"error": message, "chunk_count": len(batch)})

    def _hard_limit_exceeded(self, vram_reserved_mb: int) -> bool:
        hard = self._config.vram_hard_limit_mb
        return hard > 0 and vram_reserved_mb >= hard

    def _set_warning(self, message: str) -> None:
        if self._warning == message:
            return
        self._warning = message
        logger.warning("%s", message)
        self._telemetry.record_event("scheduler_warning", {"warning": message})

    def _clear_warning(self) -> None:
        self._warning = None

    def _choose_batch_size(self, available: int, vram_reserved_mb: int, vram_total_mb: int) -> int:
        candidates = list(self._config.batch_candidates_small_model)
        # The configured soft limit is the real budget (falling back to physical
        # VRAM when it is 0/unset). Downshift as usage approaches it so a batch
        # cannot push the process over the limit.
        budget = self._config.vram_soft_limit_mb or vram_total_mb
        if budget > 0 and vram_reserved_mb / budget >= 0.8:
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
            and chunk.status in _PENDING_STATUSES
        ]
        return sorted(chunks, key=self._chunk_priority)

    def active_batch(self) -> QueueBatch | None:
        """Public accessor for the batch currently in flight."""
        return self._active_batch()

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

    def _active_chunks(self, job: Job) -> list[ChunkRecord]:
        """Non-deprecated chunks of a job (one per index), in index order."""
        return sorted(
            (chunk for chunk in job.chunks if not chunk.deprecated),
            key=lambda chunk: chunk.index,
        )

    def _unplanned_chars(self, job: Job) -> int:
        """Characters of the canonical source text the planner has not reached."""
        offset = job.planner_cursor.offset
        if offset < 0:
            return 0
        return max(0, len(job.source_text) - offset)

    def _limit_chunks(
        self, active: list[ChunkRecord], pending: list[ChunkRecord]
    ) -> tuple[list[ChunkRecord], bool]:
        """Bound the rows returned per job while never dropping pending work.

        Every pending chunk is kept; remaining slots are filled with the most
        recent history so a whole book does not serialize on every refresh.
        """
        if len(active) <= QUEUE_SNAPSHOT_CHUNK_LIMIT:
            return active, False
        pending_ids = {id(chunk) for chunk in pending}
        others = [chunk for chunk in active if id(chunk) not in pending_ids]
        slots = max(0, QUEUE_SNAPSHOT_CHUNK_LIMIT - len(pending))
        chosen = pending + (others[-slots:] if slots else [])
        chosen.sort(key=lambda chunk: chunk.index)
        return chosen, True

    def _chunk_response(
        self,
        job: Job,
        chunk: ChunkRecord,
        *,
        rank: int,
        next_batch_ids: set[tuple[str, int, int]],
    ) -> QueueChunkResponse:
        band, label, reason = self._priority_info(job, chunk)
        versions = sorted(
            (item for item in job.chunks if item.index == chunk.index),
            key=lambda item: item.version,
        )
        return QueueChunkResponse(
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
            duration_seconds=chunk.duration_seconds,
            start_seconds=chunk.start_seconds,
            priority_band=band,
            priority_label=label,
            priority_reason=reason,
            rank=rank,
            is_pending=chunk.status in _PENDING_STATUSES,
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

    def _job_group(
        self,
        job: Job,
        pending_ranks: dict[tuple[str, int, int], int],
        next_batch_ids: set[tuple[str, int, int]],
    ) -> QueueJobGroup:
        active = self._active_chunks(job)
        pending = [chunk for chunk in active if chunk.status in _PENDING_STATUSES]
        chosen, truncated = self._limit_chunks(active, pending)
        return QueueJobGroup(
            job_id=job.id,
            job_title=job.title,
            job_status=job.status,
            job_is_active_listening=job.is_active_listening,
            job_buffered_seconds=job.buffered_seconds,
            job_target_buffer_seconds=self._config.target_buffer_seconds,
            model_id=job.model_id,
            language=job.language,
            voice_id=job.voice_id,
            total_chunks=len(active),
            written_chunks=sum(1 for chunk in active if chunk.status == ChunkStatus.WRITTEN),
            pending_chunks=len(pending),
            failed_chunks=sum(
                1
                for chunk in active
                if chunk.status in {ChunkStatus.FAILED, ChunkStatus.MAX_RETRIES_EXCEEDED}
            ),
            unplanned_chars=self._unplanned_chars(job),
            chunks_truncated=truncated,
            chunks=[
                self._chunk_response(
                    job,
                    chunk,
                    rank=pending_ranks.get((chunk.job_id, chunk.index, chunk.version), 0),
                    next_batch_ids=next_batch_ids,
                )
                for chunk in chosen
            ],
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
        pending_ranks = {
            (chunk.job_id, chunk.index, chunk.version): rank
            for rank, chunk in enumerate(pending, start=1)
        }

        return AdminQueueResponse(
            generated_at=time(),
            queue_depth=self._job_manager.queue_depth(),
            active_batch=self._active_batch(),
            next_batch=self._batch_summary(next_batch),
            jobs=[
                self._job_group(job, pending_ranks, next_batch_ids)
                for job in self._job_manager.list_jobs()
            ],
        )
