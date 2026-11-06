from __future__ import annotations

import asyncio
import logging
from collections import defaultdict
from time import monotonic, time
from typing import TypedDict

from app.chunking.planner import ChunkPlanner
from app.core.config import RuntimeConfig
from app.core.hub import WebSocketHub
from app.jobs.manager import JobManager
from app.jobs.models import ChunkRecord, ChunkStatus, Job, JobStatus, ModelState
from app.scheduler.recovery import DispatchBlock, RecoveryAction, plan_recovery
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
from app.synthesis.provider import ModelVRAMError
from app.synthesis.worker import RenderedChunkResult, SynthesisWorker
from app.telemetry.memory import MemoryStats
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


class SchedulerResidency(TypedDict):
    """Model/voice the scheduler is currently committed to."""

    resident_model_id: str | None
    resident_voice_id: str | None
    model_residency_batches: int
    voice_residency_batches: int


class SchedulerService:
    MEMORY_STATS_INTERVAL = 3.0
    # A CUDA query can block behind the in-flight batch, so the live resource
    # tick gives it a hard deadline. Exceeding it is expected under load, not an
    # incident: the tick still publishes `memory: null` so stale readings are
    # cleared, and the failure is reported once instead of every interval.
    MEMORY_STATS_TIMEOUT = 2.0

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
        # cleared once a batch is dispatched again. `_warning_key` is the stable
        # identity of the cause: the human message carries live measurements
        # that change every tick, so deduplicating on the text would record a
        # telemetry event per tick and flush the rest of the event log.
        self._warning: str | None = None
        self._warning_key: str | None = None
        # Measured marginal allocated VRAM per chunk, learned from the last
        # completed batch. Used to size the next batch against the soft limit.
        self._vram_per_chunk_mb: float | None = None
        # True while the live memory probe is failing, so the loop logs the
        # transition once rather than dumping a traceback every interval.
        self._memory_probe_failing = False
        # Model/voice residency. A model swap is a full weight reload (and clears
        # the prompt cache), so the scheduler holds a model for a minimum number
        # of batches; voice switches are cheap and only get a short bias.
        self._resident_model_id: str | None = None
        self._resident_voice_id: str | None = None
        self._batches_on_model = 0
        self._batches_on_voice = 0
        # Stall tracking for the self-recovery policy: when dispatch was first
        # blocked with work pending, and how many escalating actions have been
        # taken since. Both reset as soon as a batch dispatches.
        self._blocked_since: float | None = None
        self._recovery_attempts = 0

    def liveness_snapshot(self) -> SchedulerLiveness:
        return {
            "running": self._running,
            "last_tick_at": self._last_tick_at,
            "last_error": self._last_error,
            "consecutive_errors": self._consecutive_errors,
            "warning": self._warning,
        }

    @property
    def vram_per_chunk_mb(self) -> float | None:
        """Measured marginal allocated VRAM per rendered chunk, if known."""
        return self._vram_per_chunk_mb

    def residency_snapshot(self) -> SchedulerResidency:
        """The model/voice the scheduler is currently committed to."""
        self._sync_residency()
        return {
            "resident_model_id": self._resident_model_id,
            "resident_voice_id": self._resident_voice_id,
            "model_residency_batches": self._config.model_residency_batches,
            "voice_residency_batches": self._config.voice_residency_batches,
        }

    @property
    def resident_model_id(self) -> str | None:
        return self._resident_model_id

    @property
    def resident_voice_id(self) -> str | None:
        return self._resident_voice_id

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

    async def _probe_memory_stats(self) -> MemoryStats | None:
        """One bounded memory snapshot for the live tick, or None when unavailable.

        The CUDA query runs on a thread, but it can still block behind the batch
        being synthesized, so a timeout here is a normal consequence of a busy
        GPU. Logging it once per failure streak keeps the log readable; the null
        reading itself is what tells the Admin view that the value is stale.
        """
        try:
            stats = await asyncio.wait_for(
                self._model_manager.memory_stats(), timeout=self.MEMORY_STATS_TIMEOUT
            )
        except TimeoutError:
            if not self._memory_probe_failing:
                self._memory_probe_failing = True
                logger.info(
                    "Memory probe exceeded %.1fs (GPU busy); publishing null readings "
                    "until it recovers",
                    self.MEMORY_STATS_TIMEOUT,
                )
            return None
        except Exception:
            if not self._memory_probe_failing:
                self._memory_probe_failing = True
                logger.warning("Memory statistics unavailable", exc_info=True)
            return None
        if self._memory_probe_failing:
            self._memory_probe_failing = False
            logger.info("Memory statistics recovered")
        return stats

    async def _memory_broadcast_loop(self) -> None:
        while not self._stop_event.is_set():
            memory = await self._probe_memory_stats()
            try:
                await self._hub.broadcast(
                    WsEnvelope(
                        type="memory_stats",
                        payload={"memory": memory.model_dump() if memory else None},
                    ).model_dump()
                )
            except Exception:
                logger.warning("Memory statistics broadcast failed", exc_info=True)
            try:
                await asyncio.sleep(self.MEMORY_STATS_INTERVAL)
            except asyncio.CancelledError:
                break

    async def run_once(self) -> None:
        self._last_tick_at = time()
        await self._expire_stale_listeners()
        self._ensure_planned_chunks()
        self._telemetry.set_queue_depth(self._job_manager.queue_depth())
        block = await self._dispatch_tick()
        await self._supervise_dispatch(block)
        # Keep the model resident while there is dispatchable work; only let it
        # idle out once the queue is genuinely empty. Paused jobs do not count:
        # they keep plan-ahead chunks in `PLANNED` but nothing will render them.
        await self._model_manager.maybe_unload_idle(
            has_pending_work=self._job_manager.has_renderable_chunks()
        )
        await self._broadcast_scheduler_state()

    async def _dispatch_tick(self) -> DispatchBlock | None:
        """Render at most one batch.

        Returns why nothing could be dispatched, or `None` when the tick either
        dispatched a batch or had nothing to do. Those are the two states that
        mean the scheduler is not stuck, which is what the recovery supervisor
        keys off.
        """
        if self._model_manager.state == ModelState.ERROR:
            # A load or synthesis previously timed out; the worker thread may
            # still be stuck. Do not dispatch into it — recovery resets the
            # provider (see `_supervise_dispatch`), and until then the failure
            # stays visible instead of the queue silently freezing. Only worth
            # recovering while something is actually waiting to render.
            if not self._job_manager.has_renderable_chunks():
                return None
            return DispatchBlock.PROVIDER_ERROR
        renderable = self._rank_renderable_chunks()
        if not renderable:
            return None
        return await self._render_next_batch(renderable)

    async def _supervise_dispatch(self, block: DispatchBlock | None) -> None:
        """Keep a blocked scheduler from freezing for good.

        Every blocking condition has to be escapable without an operator
        noticing hours later. The policy lives in `app/scheduler/recovery.py`;
        this only tracks how long dispatch has been blocked and applies the
        action it chooses, with the wait doubling after each attempt.
        """
        if block is None:
            self._blocked_since = None
            self._recovery_attempts = 0
            return
        now = monotonic()
        if self._blocked_since is None:
            self._blocked_since = now
            return
        blocked_seconds = now - self._blocked_since
        action = plan_recovery(
            block=block,
            blocked_seconds=blocked_seconds,
            attempts=self._recovery_attempts,
            stall_seconds=self._config.dispatch_stall_seconds,
        )
        if action is None:
            return
        self._recovery_attempts += 1
        await self._apply_recovery(action, block, blocked_seconds)

    async def _apply_recovery(
        self, action: RecoveryAction, block: DispatchBlock, blocked_seconds: float
    ) -> None:
        message = (
            f"Dispatch blocked ({block}) for {blocked_seconds:.0f}s; "
            f"attempt {self._recovery_attempts}: {action}"
        )
        logger.warning("%s", message)
        self._telemetry.record_event(
            "scheduler_recovery",
            {
                "action": action,
                "block": block,
                "blocked_seconds": round(blocked_seconds, 1),
                "attempt": self._recovery_attempts,
            },
        )
        try:
            if action == RecoveryAction.UNLOAD_MODEL:
                await self._model_manager.unload()
            else:
                await self._model_manager.reset_provider()
        except Exception:
            # Recovery failing must not kill the tick; the next attempt is
            # scheduled with a longer delay and the failure stays visible.
            logger.exception("Scheduler auto-recovery (%s) failed", action)
            return
        # The admin views render `model_state` from this event, so an automatic
        # unload/reset has to be announced the same way the Admin endpoints
        # announce a manual one.
        await self._hub.broadcast(
            WsEnvelope(
                type="model_state", payload={"state": self._model_manager.state}
            ).model_dump()
        )

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
                    "vram_per_chunk_mb": self._vram_per_chunk_mb,
                    **self.residency_snapshot(),
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
        # The default is to render every job to the end: an explicit pause is the
        # only intentional stop. `render_ahead_seconds` is an opt-in lookahead cap
        # (0 = unlimited) and `render_to_end` is a per-job opt-out of it.
        lookahead_seconds = self._config.render_ahead_seconds
        if (
            lookahead_seconds > 0
            and not job.render_to_end
            and job.buffered_seconds >= lookahead_seconds
        ):
            return False
        return True

    async def _expire_stale_listeners(self) -> None:
        """Drop active-listener status for jobs that stopped reporting.

        Without this the flag was sticky for the life of the process, so a tab
        that was closed mid-book kept its job in the urgent band.
        """
        expired = self._job_manager.expire_stale_listeners(
            self._config.active_listener_timeout_seconds
        )
        for job in expired:
            await self._hub.broadcast(
                WsEnvelope(
                    type="job_updated", payload={"job": job_to_summary(job).model_dump()}
                ).model_dump()
            )

    def _rank_renderable_chunks(self) -> list[ChunkRecord]:
        chunks = list(self._job_manager.renderable_chunks())
        return self._ordered_for_dispatch(chunks)

    def _ordered_for_dispatch(self, chunks: list[ChunkRecord]) -> list[ChunkRecord]:
        """Order chunks for dispatch.

        The rule the user asked for is: take turns by *amount of work*, not by
        absolute chunk index, but never reorder chunks inside one job. So the
        sort key uses a **per-job ordinal** (0 = that job's next chunk) instead
        of the global `chunk.index`. That way a job at chunk 500 and a job at
        chunk 10 both contribute their next chunk first, while chunk 501 can
        never precede chunk 500 of the same job.

        Groups (same model/language/voice) are served one at a time, in order of
        their best `(band, job submission time)`; within a group, chunks are
        interleaved round-robin across jobs by ordinal, so a batch splits evenly
        between same-priority jobs. Batching different voices together is not
        possible, hence the group-major order.
        """
        if not chunks:
            return []
        # (submitted_at, id) gives a fully deterministic oldest-first order.
        job_order = {job.id: (job.submitted_at, job.id) for job in self._job_manager.list_jobs()}

        # Per-job ordinal: position among that job's chunks in this list, by index.
        ordinal: dict[int, int] = {}
        per_job: dict[str, list[ChunkRecord]] = defaultdict(list)
        for chunk in chunks:
            per_job[chunk.job_id].append(chunk)
        for job_chunks in per_job.values():
            job_chunks.sort(key=lambda item: item.index)
            for position, chunk in enumerate(job_chunks):
                ordinal[id(chunk)] = position

        def chunk_key(chunk: ChunkRecord) -> tuple[int, int, float, str, int]:
            job = self._job_manager.get_job(chunk.job_id)
            submitted_at, job_id = job_order.get(job.id, (0.0, ""))
            return (
                self._priority_band(job),
                ordinal[id(chunk)],
                submitted_at,
                job_id,
                chunk.index,
            )

        groups: dict[tuple[str, str, str], list[ChunkRecord]] = defaultdict(list)
        for chunk in chunks:
            job = self._job_manager.get_job(chunk.job_id)
            groups[(job.model_id, job.language, chunk.voice_id)].append(chunk)

        def group_priority(
            item: tuple[tuple[str, str, str], list[ChunkRecord]],
        ) -> tuple[int, float, str]:
            # Ignore ordinals here: a group is drained before the next one starts.
            _key, group = item
            return min(
                (
                    self._priority_band(self._job_manager.get_job(chunk.job_id)),
                    *job_order.get(chunk.job_id, (0.0, "")),
                )
                for chunk in group
            )

        ordered: list[ChunkRecord] = []
        for _key, group in sorted(groups.items(), key=group_priority):
            ordered.extend(sorted(group, key=chunk_key))
        return ordered

    def _priority_band(self, job: Job) -> int:
        """Return the scheduler's coarse priority band for a job.

        Bands are the first component of `_chunk_priority` and are what the
        scheduler orders jobs by:

        - 0: an active listener below `target_buffer_seconds` \u2014 about to run
          dry, preempts everything else.
        - 1: an active listener between the target and the comfortable buffer
          (`max_prebuffer_seconds`). It is not about to dry up, but keeping it
          comfortably ahead is what lets the user raise playback speed or skip
          without hitting the render ceiling.
        - 2: background work \u2014 queued jobs and listeners already at or above
          the comfortable buffer. These round-robin together, so a
          fully-prebuffered listener stops monopolising the GPU.

        These bands are *priority only*. Rendering is bounded by
        `render_ahead_seconds` (0 = unlimited), never by the band threshold, so
        being above the comfortable buffer cannot stop a job from finishing.
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
                f"(target {target}s met, below the {ideal}s comfortable buffer).",
            )
        if job.is_active_listening:
            return (
                band,
                "Buffered",
                f"Active listener with {job.buffered_seconds:.1f}s buffered "
                f"(comfortable buffer {ideal}s met) \u2014 shares the lowest band with "
                "background work; still renders to the end.",
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

    def _sync_residency(self) -> None:
        """Drop residency state when the loaded model no longer matches it.

        Evicting or erroring out unloads the model, so a previously resident
        model id would otherwise be advertised (and preferred) while nothing is
        actually loaded. Skip the LOADING window: the new weights are not
        recorded on the manager yet, and resetting there would drop the counter
        mid-load.
        """
        if self._model_manager.state in {ModelState.LOADING, ModelState.BUSY}:
            return
        loaded = self._model_manager.loaded_model_id
        if loaded != self._resident_model_id:
            self._resident_model_id = loaded
            self._batches_on_model = 0
            self._resident_voice_id = None
            self._batches_on_voice = 0

    def _choose_group_key(
        self,
        keys: list[tuple[str, str, str]],
        groups: dict[tuple[str, str, str], list[ChunkRecord]],
    ) -> tuple[str, str, str]:
        """Pick which (model, language, voice) group gets the next batch.

        Model residency is the expensive axis: swapping unloads and reloads the
        weights (and clears the prompt cache), so a resident model is held until
        either it has nothing left to render, the residency window elapses, or
        an active listener (band 0) on another model needs it now. At a rotation
        boundary the model with an active listener wins; otherwise the next
        model in priority order gets a turn so nobody starves.
        """
        self._sync_residency()
        by_model: dict[str, list[tuple[str, str, str]]] = {}
        for key in keys:
            by_model.setdefault(key[0], []).append(key)
        model_order = list(by_model)
        urgent_models = {
            key[0]
            for key, chunks in groups.items()
            if any(
                self._priority_band(self._job_manager.get_job(chunk.job_id)) == 0
                for chunk in chunks
            )
        }

        resident = self._resident_model_id
        if resident is None or resident not in by_model:
            eligible_models = model_order
        elif resident in urgent_models:
            # Keep serving the listener the resident model is already feeding.
            eligible_models = [resident]
        else:
            others = [model for model in model_order if model != resident]
            boundary = self._batches_on_model >= self._config.model_residency_batches
            if boundary:
                # Window elapsed: an active listener gets the GPU first, otherwise
                # the next model in priority order takes a turn. Both keep the
                # swap rate at most once per residency window.
                other_urgent = [model for model in others if model in urgent_models]
                eligible_models = other_urgent or others or [resident]
            else:
                eligible_models = [resident]

        chosen_model = eligible_models[0]
        model_keys = by_model[chosen_model]
        # Voice switches are cheap, so bias the current voice only briefly and
        # then rotate to the next voice group.
        if (
            self._resident_voice_id is not None
            and self._batches_on_voice < self._config.voice_residency_batches
        ):
            same_voice = [key for key in model_keys if key[2] == self._resident_voice_id]
            if same_voice:
                return same_voice[0]
        other_voices = [key for key in model_keys if key[2] != self._resident_voice_id]
        return (other_voices or model_keys)[0]

    def _note_batch_affinity(self, model_id: str, voice_id: str) -> None:
        """Record a dispatched batch against the residency counters."""
        if model_id != self._resident_model_id:
            self._resident_model_id = model_id
            self._batches_on_model = 1
            self._resident_voice_id = None
            self._batches_on_voice = 0
        else:
            self._batches_on_model += 1
        if voice_id != self._resident_voice_id:
            self._resident_voice_id = voice_id
            self._batches_on_voice = 1
        else:
            self._batches_on_voice += 1

    def _select_next_batch(
        self,
        ranked_chunks: list[ChunkRecord],
        vram_allocated_mb: int,
        vram_total_mb: int,
        *,
        vram_headroom_mb: int | None = None,
    ) -> tuple[tuple[str, str, str] | None, list[ChunkRecord]]:
        """Pick the next batch exactly as the scheduler would dispatch it.

        Shared by `_render_next_batch` and `queue_snapshot` so the admin queue
        view can mark the real "up next" chunks instead of re-deriving them.
        """
        grouped = self._group_chunks(ranked_chunks)
        if not grouped:
            return None, []
        group_key = self._choose_group_key(list(grouped), grouped)
        chunks = grouped[group_key]
        batch_size = self._choose_batch_size(
            len(chunks),
            vram_allocated_mb,
            vram_total_mb,
            vram_headroom_mb=vram_headroom_mb,
        )
        return group_key, chunks[:batch_size]

    async def _render_next_batch(self, ranked_chunks: list[ChunkRecord]) -> DispatchBlock | None:
        if not ranked_chunks:
            return None
        stats = await self._dispatch_memory_stats()
        if stats is None or (
            stats.device.startswith("cuda")
            and (stats.vram_allocated_mb is None or stats.vram_reserved_mb is None)
        ):
            # Monitoring can retain RAM when a GPU query fails, but dispatch
            # must not interpret missing allocator readings as zero usage. A
            # monitoring blip is not a stall, so it is not a recovery target.
            self._set_warning(
                "GPU memory statistics unavailable; dispatch paused until readings recover.",
                key="gpu_memory_unavailable",
            )
            return DispatchBlock.MONITORING
        # Keep scheduler limits scoped to ReadFlow's allocator, not device-wide
        # usage. These are different from the system totals shown in Admin.
        vram_total = stats.vram_total_mb or 0
        vram_allocated = stats.vram_allocated_mb or 0
        hard_limit = self._config.vram_hard_limit_mb
        live_vram = self._live_vram_mb(stats)
        if hard_limit > 0 and live_vram >= hard_limit:
            # Only memory that cannot be reclaimed counts against the hard
            # limit. Comparing the *reserved* pool here is what used to freeze
            # the scheduler for hours: the caching allocator never shrinks it,
            # so one peak batch pinned it above the limit permanently while
            # most of it was free cache. Recovery unloads the model, which is
            # the only way to give VRAM back while work is pending.
            self._set_warning(
                f"Live VRAM is at the hard limit ({live_vram} MiB >= {hard_limit} MiB); "
                "dispatch paused. The model is unloaded automatically if this does not "
                "clear, or raise the limit in Admin.",
                key="vram_hard_limit",
            )
            return DispatchBlock.MEMORY
        group_key, batch = self._select_next_batch(
            ranked_chunks,
            vram_allocated,
            vram_total,
            vram_headroom_mb=self._vram_headroom_mb(stats),
        )
        if group_key is None or not batch:
            return None
        self._clear_warning()
        self._note_batch_affinity(group_key[0], group_key[2])
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
        except ModelVRAMError as exc:
            # The model could not even be loaded, so no chunk was attempted.
            # Charging an attempt here let one low-VRAM moment mark an entire
            # book failed three chunks at a time; requeue them untouched and
            # let the stall supervisor decide when to try loading again.
            logger.warning("Not enough VRAM to load %s: %s", model_id, exc)
            self._set_warning(
                f"Not enough VRAM to load {model_id}; the batch is requeued and the "
                "scheduler retries automatically.",
                key="model_load_vram",
            )
            for chunk in batch:
                self._job_manager.mark_chunk_planned(chunk)
            return DispatchBlock.MEMORY
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
        self._record_vram_estimate(len(results), results, base_allocated_mb=vram_allocated)
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
        return None

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

    async def _dispatch_memory_stats(self) -> MemoryStats | None:
        """Admission readings for one dispatch, bounded by a deadline.

        Dispatch needs the readings, so unlike the live resource tick a failure
        here has to skip the batch. It must still not hang the tick: an
        unbounded query would freeze the whole scheduling loop, which is the
        class of bug this file exists to prevent.
        """
        try:
            return await asyncio.wait_for(
                self._model_manager.memory_stats(), timeout=self.MEMORY_STATS_TIMEOUT
            )
        except TimeoutError:
            logger.info("Memory probe exceeded %.1fs before dispatch", self.MEMORY_STATS_TIMEOUT)
        except Exception:
            logger.warning("Memory statistics unavailable before dispatch", exc_info=True)
        return None

    def _live_vram_mb(self, stats: MemoryStats) -> int:
        """VRAM that dispatch cannot get back without unloading something.

        That is live tensor memory plus whatever the device is using that
        ReadFlow does not own through the allocator (CUDA context, another
        process). `reserved - allocated` is deliberately excluded: it is the
        caching allocator's free pool, which `torch.cuda.empty_cache()` hands
        back, so counting it against the hard limit claimed a full GPU while
        most of the pool was unused.
        """
        allocated = stats.vram_allocated_mb or 0
        if stats.vram_used_mb is None or stats.vram_reserved_mb is None:
            return allocated
        return allocated + max(0, stats.vram_used_mb - stats.vram_reserved_mb)

    def _vram_headroom_mb(self, stats: MemoryStats) -> int | None:
        """Memory a new batch can use without evicting anything.

        Device free memory plus the allocator's own unreserved pool: blocks
        already reserved but not allocated are handed to the next batch instead
        of being requested from the driver. Bounding the batch this way avoids
        dispatching work that can only end in an OOM-and-shrink cycle during a
        long render.
        """
        if stats.vram_free_mb is None:
            return None
        reclaimable = 0
        if stats.vram_reserved_mb is not None and stats.vram_allocated_mb is not None:
            reclaimable = max(0, stats.vram_reserved_mb - stats.vram_allocated_mb)
        return stats.vram_free_mb + reclaimable

    def _set_warning(self, message: str, *, key: str | None = None) -> None:
        """Publish why dispatch is paused, recording each cause once.

        `key` is the stable identity of the cause (`message` by default). The
        VRAM figure in the message moves by a few MiB every tick, so comparing
        the rendered text recorded hundreds of identical telemetry events and
        pushed the rest of the event log out of its ring buffer.
        """
        identity = key or message
        self._warning = message
        if self._warning_key == identity:
            return
        self._warning_key = identity
        logger.warning("%s", message)
        self._telemetry.record_event("scheduler_warning", {"warning": message})

    def _clear_warning(self) -> None:
        self._warning = None
        self._warning_key = None

    def _choose_batch_size(
        self,
        available: int,
        vram_allocated_mb: int,
        vram_total_mb: int,
        *,
        vram_headroom_mb: int | None = None,
    ) -> int:
        """Largest candidate batch that fits both the soft limit and real headroom.

        `available` is the number of chunks waiting, not a memory figure: the
        candidate list is trimmed by the chunk count at the end.
        """
        candidates = list(self._config.batch_candidates_small_model)
        # The configured soft limit is the budget for the batch's peak allocated
        # working set (falling back to physical VRAM when it is 0/unset). Size
        # the batch from the measured per-chunk cost so the budget is respected
        # without being fooled by the sticky reserved pool.
        budget = self._config.vram_soft_limit_mb or vram_total_mb
        if budget > 0:
            if vram_allocated_mb >= budget:
                return 1
            if self._vram_per_chunk_mb:
                max_by_budget = int((budget - vram_allocated_mb) / self._vram_per_chunk_mb)
                candidates = [size for size in candidates if size <= max_by_budget] or [1]
        if vram_headroom_mb is not None and self._vram_per_chunk_mb:
            fit = int(vram_headroom_mb / self._vram_per_chunk_mb)
            candidates = [size for size in candidates if size <= fit] or [1]
        for size in candidates:
            if available >= size:
                return size
        return 1

    def _record_vram_estimate(
        self,
        rendered: int,
        results: list[RenderedChunkResult],
        *,
        base_allocated_mb: int,
    ) -> None:
        """Learn the marginal allocated VRAM cost of one chunk.

        `allocated` is used rather than `reserved`: the caching allocator's
        reserved pool only grows, so a single large batch would pin it at its
        peak forever and permanently shrink every later batch. The marginal
        cost is the batch's peak allocated memory minus the idle baseline,
        divided by the number of chunks that actually rendered.
        """
        if rendered <= 0 or not results:
            return
        peak_allocated_mb = max(result.allocated_vram_mb for result in results)
        marginal_mb = peak_allocated_mb - base_allocated_mb
        if marginal_mb > 0:
            self._vram_per_chunk_mb = marginal_mb / rendered

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
        return self._ordered_for_dispatch(chunks)

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
