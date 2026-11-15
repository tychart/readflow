from __future__ import annotations

from collections.abc import Callable, Sequence
from uuid import uuid4

from app.chunking.normalize import normalize_source_text
from app.chunking.planner import ChunkPlan
from app.core.identity import DEFAULT_USER_ID
from app.core.time import utc_now
from app.db.protocols import Database, UnitOfWork
from app.jobs.models import (
    TERMINAL_JOB_STATUSES,
    ChunkRecord,
    ChunkStatus,
    Job,
    JobStatus,
    JobSummary,
)
from app.jobs.recovery import (
    RecoveryPlan,
    RecoveryResult,
    plan_startup_recovery,
)
from app.library.progress import heard_seconds

# Chunk states a partial voice change can re-point at the new voice. `WRITTEN`
# keeps its rendered audio and `RENDERING` is reconciled when the batch returns.
_REVOICEABLE_STATUSES = frozenset(
    {
        ChunkStatus.PLANNED,
        ChunkStatus.QUEUED,
        ChunkStatus.STALE,
        ChunkStatus.FAILED,
        ChunkStatus.REPROCESSING,
        ChunkStatus.MAX_RETRIES_EXCEEDED,
    }
)


class JobManager:
    """Command service for jobs and chunks.

    Every public method is one database transaction: it loads the job aggregate
    through a unit of work, applies the domain rule, and saves. Nothing above
    this class touches storage, and nothing in this class touches a concrete
    database — see `app.db.protocols`.

    The manager is user-scoped (`user_id`). There is one seeded local user until
    authentication exists, so the default argument keeps call sites honest while
    the queries are already per-user.
    """

    def __init__(self, database: Database, *, user_id: str = DEFAULT_USER_ID) -> None:
        self._db = database
        self._user_id = user_id

    # ── reads ───────────────────────────────────────────────────────────────

    async def _require_job(self, uow: UnitOfWork, job_id: str) -> Job:
        job = await uow.jobs.get(self._user_id, job_id)
        if job is None:
            raise KeyError(f"Unknown job '{job_id}'")
        return job

    async def _require_chunk_job(self, uow: UnitOfWork, job_id: str) -> Job:
        """A job the worker can still write to, including one in the trash.

        Trashing stops *new* dispatch, but a batch already on the GPU may come
        back; writing its audio keeps a restored job consistent. A purged job is
        genuinely gone and still raises.
        """
        job = await uow.jobs.get(self._user_id, job_id, include_deleted=True)
        if job is None:
            raise KeyError(f"Unknown job '{job_id}'")
        return job

    @staticmethod
    def _resolve_chunk(job: Job, chunk: ChunkRecord) -> ChunkRecord:
        """Return the aggregate's own instance for `chunk`.

        Callers legitimately hold a chunk reference across a synthesis await. A
        real database returns a fresh aggregate, so the mutation must be applied
        to the instance that belongs to the loaded job, not to the caller's
        detached one. In memory these are the same object; this keeps the code
        correct for both adapters.
        """
        for candidate in job.chunks:
            if candidate.index == chunk.index and candidate.version == chunk.version:
                return candidate
        raise KeyError(f"Job '{job.id}' has no chunk {chunk.index} v{chunk.version}")

    async def list_jobs(self) -> list[Job]:
        async with self._db.transaction() as uow:
            jobs = await uow.jobs.list(self._user_id)
        return sorted(jobs, key=lambda job: job.submitted_at, reverse=True)

    async def summaries(self) -> list[JobSummary]:
        """Flat projections of every live job, without chunks or source text."""
        async with self._db.transaction() as uow:
            return await uow.jobs.summaries(self._user_id)

    # ── system scope (scheduler only; never reachable from a handler) ───────

    async def summaries_all(self, *, include_deleted: bool = False) -> list[JobSummary]:
        """Every job in the install, as one read.

        This is the scheduler's read model: one call replaces the per-chunk
        aggregate loads that used to dominate a tick. It sees other users' jobs
        because one GPU serves the whole machine, so it must stay out of request
        handlers.
        """
        async with self._db.transaction() as uow:
            return await uow.jobs.summaries_all(include_deleted=include_deleted)

    async def planned_chunks(self) -> list[ChunkRecord]:
        """Dispatchable chunks across every job, live takes only."""
        async with self._db.transaction() as uow:
            return await uow.jobs.planned_chunks()

    async def rendering_chunks(self) -> list[ChunkRecord]:
        """In-flight chunks across every job (the active batch)."""
        async with self._db.transaction() as uow:
            return await uow.jobs.rendering_chunks()

    async def source_text_any(self, job_id: str) -> str:
        """Source text without an ownership check (scheduler planning only)."""
        async with self._db.transaction() as uow:
            return await uow.jobs.source_text_any(job_id)

    async def get_job(self, job_id: str) -> Job:
        async with self._db.transaction() as uow:
            return await self._require_job(uow, job_id)

    async def source_text(self, job_id: str) -> str:
        """The canonical (already normalized) source text of one job."""
        async with self._db.transaction() as uow:
            return await uow.jobs.source_text(self._user_id, job_id)

    # ── lifecycle ───────────────────────────────────────────────────────────

    async def create_job(
        self,
        *,
        source_text: str,
        source_kind: str,
        model_id: str,
        voice_id: str,
        language: str = "English",
        title: str | None = None,
        folder_id: str | None = None,
    ) -> Job:
        """Create a job, appended to the end of its folder's manual order."""
        normalized_text = normalize_source_text(source_text)
        now = utc_now()
        async with self._db.transaction() as uow:
            if folder_id is not None and await uow.folders.get(self._user_id, folder_id) is None:
                raise KeyError(f"Unknown folder '{folder_id}'")
            job = Job(
                id=str(uuid4()),
                title=title or self._derive_title(normalized_text),
                source_kind=source_kind,
                source_char_count=len(normalized_text),
                model_id=model_id,
                voice_id=voice_id,
                language=language,
                user_id=self._user_id,
                folder_id=folder_id,
                position=await uow.jobs.next_position(self._user_id, folder_id),
                submitted_at=now,
                updated_at=now,
            )
            # The source text is its own row: list and scheduler reads must not
            # pay for megabytes they never look at.
            await uow.jobs.add(job, source_text=normalized_text)
            return job

    async def delete_job(self, job_id: str) -> None:
        async with self._db.transaction() as uow:
            await uow.jobs.delete(self._user_id, job_id)

    async def activate_job(self, job_id: str) -> Job:
        """Record that someone is listening to this job.

        A finished job is still listened to: its audio is local (the status must
        stay COMPLETED), but the active-listener flag is what makes the
        scheduler warm the folder's next job, so it is set either way.
        """
        async with self._db.transaction() as uow:
            job = await self._require_job(uow, job_id)
            job.is_active_listening = True
            job.playback_state.last_event_at = utc_now()
            if job.status not in TERMINAL_JOB_STATUSES:
                job.playback_state.is_playing = True
                job.status = JobStatus.PLAYING
            job.updated_at = utc_now()
            await uow.jobs.save(job)
            return job

    async def pause_job(self, job_id: str) -> Job:
        async with self._db.transaction() as uow:
            job = await self._require_job(uow, job_id)
            job.is_active_listening = False
            job.playback_state.is_playing = False
            job.playback_state.last_event_at = utc_now()
            if job.status not in TERMINAL_JOB_STATUSES:
                job.status = JobStatus.PAUSED
            job.updated_at = utc_now()
            await uow.jobs.save(job)
            return job

    async def resume_job(self, job_id: str) -> Job:
        async with self._db.transaction() as uow:
            job = await self._require_job(uow, job_id)
            if job.status == JobStatus.COMPLETED:
                return job
            job.status = JobStatus.QUEUED
            job.updated_at = utc_now()
            await uow.jobs.save(job)
            return job

    async def set_render_to_end(self, job_id: str, enabled: bool = True) -> Job:
        """Opt this job out of (or back into) the scheduler's lookahead cap.

        The manual escape hatch for "keep rendering this book": it only affects
        `render_ahead_seconds`. A paused job still does not render, because pause
        is the one intentional stop.
        """
        async with self._db.transaction() as uow:
            job = await self._require_job(uow, job_id)
            job.render_to_end = enabled
            job.updated_at = utc_now()
            await uow.jobs.save(job)
            return job

    async def expire_stale_listeners(
        self, timeout_seconds: float, *, summaries: Sequence[JobSummary] | None = None
    ) -> list[JobSummary]:
        """Forget listeners that stopped reporting playback positions.

        `is_active_listening` used to be sticky until an explicit pause or job
        completion, so a closed tab kept its job in the urgent priority band
        (and, with a lookahead cap configured, frozen at that cap forever).

        The candidates come from summaries (one cheap read, or the list the
        caller already has), and only a job that actually expired gets its own
        transaction. Returns the changed summaries so the caller can broadcast
        them without loading a single aggregate.
        """
        if timeout_seconds <= 0:
            return []
        now = utc_now()
        candidates = summaries if summaries is not None else await self.summaries()
        expired: list[JobSummary] = []
        for summary in candidates:
            if not summary.is_active_listening:
                continue
            if now - summary.playback_state.last_event_at <= timeout_seconds:
                continue
            async with self._db.transaction() as uow:
                job = await uow.jobs.get(self._user_id, summary.id)
                if job is None:
                    continue
                job.is_active_listening = False
                if job.status == JobStatus.PLAYING:
                    job.status = JobStatus.QUEUED
                job.updated_at = now
                await uow.jobs.save(job)
                expired.append(job.summary())
        return expired

    async def set_voice(self, job_id: str, voice_id: str, *, rerender_written: bool = False) -> Job:
        """Re-voice the chunks that have not been rendered yet.

        A voice change is not a discard: every chunk the scheduler can still act
        on is re-pointed at the new voice and put back in the queue, so it is
        re-rendered rather than orphaned. Previously this only flipped those
        chunks to `STALE`; nothing ever re-planned them (the planner cursor only
        moves forward), so their text was silently dropped.

        Already-`WRITTEN` chunks keep the voice they were actually rendered
        with, which is why a partial change can leave a job with two voices.
        Pass `rerender_written=True` to invalidate the whole job for one
        consistent take; that also bumps `audio_epoch` so the reader rebuilds
        its media stream.

        A chunk is never mutated while the worker is synthesizing it. An
        in-flight chunk keeps the batch it belongs to and is reconciled when it
        comes back: for a partial change it is pinned to the current plan
        generation and written as the old voice, and for a full re-render it is
        requeued with the new voice (see `_requeue_superseded_chunk`).
        """
        async with self._db.transaction() as uow:
            job = await self._require_job(uow, job_id)
            if job.voice_id == voice_id and not rerender_written:
                return job
            job.voice_id = voice_id
            job.plan_version += 1
            now = utc_now()
            requeued = False
            for chunk in job.chunks:
                if chunk.deprecated:
                    continue
                if chunk.status == ChunkStatus.RENDERING:
                    if not rerender_written:
                        # The worker already fetched the old voice prompt for
                        # this batch; pin the chunk to the current generation so
                        # it is written as-is instead of being requeued.
                        chunk.plan_version = job.plan_version
                        chunk.updated_at = now
                    # A full re-render leaves the old plan version in place; the
                    # chunk is requeued with the new voice once the batch
                    # returns.
                    continue
                if rerender_written or chunk.status in _REVOICEABLE_STATUSES:
                    self._apply_voice(job, chunk, now)
                    requeued = True
            if rerender_written:
                job.audio_epoch += 1
                job.completed_seconds = 0.0
                job.playback_state.current_time_seconds = 0.0
                job.playback_state.is_playing = False
            await self._refresh_derived(uow, job)
            if requeued or rerender_written:
                # A finished job with work to redo must leave the terminal state
                # or the reader treats it as local and stops watching for the
                # replacement chunks.
                if job.status in {JobStatus.COMPLETED, JobStatus.FAILED}:
                    job.status = JobStatus.QUEUED
                self._settle_status(job)
            job.updated_at = now
            await uow.jobs.save(job)
            return job

    def _apply_voice(self, job: Job, chunk: ChunkRecord, now: float) -> None:
        """Re-point one queued chunk at a voice and return it to the queue."""
        chunk.voice_id = job.voice_id
        chunk.plan_version = job.plan_version
        chunk.status = ChunkStatus.PLANNED
        chunk.attempts = 0
        chunk.error = None
        chunk.reprocessing = False
        # Any previously packaged take for this index is now superseded; the
        # reader only links a segment while the chunk is `WRITTEN`.
        chunk.duration_seconds = 0.0
        chunk.start_seconds = 0.0
        chunk.segment_path = None
        chunk.wav_path = None
        chunk.updated_at = now

    def _requeue_superseded_chunk(self, job: Job, chunk: ChunkRecord) -> bool:
        """Requeue a chunk that came back under an older plan version.

        Only reachable for a chunk that was already in flight when a voice
        change (or full re-render) bumped `job.plan_version`. Writing its
        old-voice audio now would leave the job inconsistent, so it goes back
        into the queue with the job's current voice instead.
        """
        if chunk.deprecated or chunk.plan_version == job.plan_version:
            return False
        self._apply_voice(job, chunk, utc_now())
        return True

    async def add_planned_chunk(self, job_id: str, plan: ChunkPlan) -> ChunkRecord:
        """Store one planned chunk and advance the planner cursor.

        The manager owns every mutation of the job: the planner only proposes a
        `ChunkPlan`. That keeps "planning advanced" and "chunk exists" atomic.
        """
        async with self._db.transaction() as uow:
            job = await self._require_job(uow, job_id)
            chunk = ChunkRecord(
                job_id=job_id,
                index=job.next_chunk_index,
                text=plan.text,
                voice_id=job.voice_id,
                language=job.language,
                plan_version=job.plan_version,
                char_start=plan.char_start,
                char_end=plan.char_end,
            )
            job.chunks.append(chunk)
            job.next_chunk_index += 1
            job.active_chunk_version[chunk.index] = chunk.version
            # Planning resumes where this span ended; reaching the end of the
            # source text exhausts it (`plan_next` would return None anyway).
            job.planner_cursor.offset = (
                -1 if plan.char_end >= job.source_char_count else plan.char_end
            )
            job.planner_cursor.chunks_emitted += 1
            await self._refresh_derived(uow, job)
            job.updated_at = utc_now()
            await uow.jobs.save(job)
            return chunk

    async def finish_planning(self, job_id: str) -> Job:
        """Mark the planner as having reached the end of the source text."""
        async with self._db.transaction() as uow:
            job = await self._require_job(uow, job_id)
            job.planner_cursor.offset = -1
            await self._refresh_derived(uow, job)
            self._settle_status(job)
            await uow.jobs.save(job)
            return job

    async def mark_chunk_rendering(self, chunk: ChunkRecord) -> None:
        async with self._db.transaction() as uow:
            job = await self._require_chunk_job(uow, chunk.job_id)
            stored = self._resolve_chunk(job, chunk)
            stored.status = ChunkStatus.RENDERING
            stored.updated_at = utc_now()
            if job.status != JobStatus.PAUSED:
                job.status = JobStatus.RENDERING
            job.updated_at = utc_now()
            await uow.jobs.save(job)

    async def mark_chunk_planned(self, chunk: ChunkRecord) -> Job:
        """Return a chunk to the queue untouched.

        Used when a batch is only partially rendered (the worker retries an OOM
        with fewer chunks) or could not even load the model, so the dropped
        chunks are retried on a later tick instead of being left stuck in
        `RENDERING`.
        """
        return await self._requeue_chunk(chunk)

    async def mark_chunk_retry(self, chunk: ChunkRecord, error: str) -> Job:
        """Requeue a chunk after a failed attempt, counting the attempt.

        Keeps the job alive: only the chunk is requeued, and the job continues
        rendering its other chunks until the attempt budget is spent.
        """
        async with self._db.transaction() as uow:
            job = await self._require_chunk_job(uow, chunk.job_id)
            stored = self._resolve_chunk(job, chunk)
            stored.attempts += 1
            stored.error = error
            return await self._requeue_chunk_locked(uow, job, stored)

    async def _requeue_chunk(self, chunk: ChunkRecord) -> Job:
        async with self._db.transaction() as uow:
            job = await self._require_chunk_job(uow, chunk.job_id)
            stored = self._resolve_chunk(job, chunk)
            return await self._requeue_chunk_locked(uow, job, stored)

    async def _requeue_chunk_locked(self, uow: UnitOfWork, job: Job, chunk: ChunkRecord) -> Job:
        chunk.status = ChunkStatus.PLANNED
        chunk.updated_at = utc_now()
        self._requeue_superseded_chunk(job, chunk)
        await self._refresh_derived(uow, job)
        self._settle_status(job)
        job.updated_at = utc_now()
        await uow.jobs.save(job)
        return job

    async def mark_chunk_written(
        self,
        chunk: ChunkRecord,
        *,
        duration_seconds: float,
        segment_path: str,
        wav_path: str,
    ) -> Job:
        async with self._db.transaction() as uow:
            job = await self._require_chunk_job(uow, chunk.job_id)
            stored = self._resolve_chunk(job, chunk)
            # A chunk that came back after its plan generation was superseded is
            # requeued with the job's current voice rather than written as stale
            # audio (see `_requeue_superseded_chunk`).
            if self._requeue_superseded_chunk(job, stored):
                await self._refresh_derived(uow, job)
                job.updated_at = utc_now()
                await uow.jobs.save(job)
                return job
            stored.status = ChunkStatus.WRITTEN
            stored.duration_seconds = duration_seconds
            stored.segment_path = segment_path
            stored.wav_path = wav_path
            stored.error = None
            stored.updated_at = utc_now()
            await self._refresh_derived(uow, job)
            self._settle_status(job)
            job.updated_at = utc_now()
            await uow.jobs.save(job)
            return job

    async def mark_chunk_failed(self, chunk: ChunkRecord, error: str) -> Job:
        """Mark a single chunk failed after its attempt budget is spent.

        Deliberately does NOT fail the whole job. One unrenderable chunk should
        leave a recoverable gap (visible in the reader and admin queue) while
        the rest of the job keeps rendering, rather than turning the job
        terminal and stopping all work on it.
        """
        async with self._db.transaction() as uow:
            job = await self._require_chunk_job(uow, chunk.job_id)
            stored = self._resolve_chunk(job, chunk)
            stored.status = ChunkStatus.FAILED
            stored.error = error
            stored.updated_at = utc_now()
            self._requeue_superseded_chunk(job, stored)
            await self._refresh_derived(uow, job)
            self._settle_status(job)
            job.updated_at = utc_now()
            await uow.jobs.save(job)
            return job

    def _settle_status(self, job: Job) -> None:
        """Recompute a job's coarse status from its chunks.

        Exactly one place decides this, so the transitions cannot drift. It is
        what keeps a job from sitting in `RENDERING` with nothing in flight —
        the reader and the admin queue both read `rendering` as "the GPU is
        working on this", and a failed batch or a batch the worker shrank used
        to leave the status there forever.

        Pause and the terminal states are never rewritten here: pause is sticky,
        and a completed/failed job is only revived by an explicit action.
        """
        if job.status in {JobStatus.PAUSED, JobStatus.COMPLETED, JobStatus.FAILED}:
            return
        if job.planner_cursor.exhausted and not job.has_unfinished_chunks():
            job.status = JobStatus.COMPLETED
            job.is_active_listening = False
        elif job.is_active_listening:
            job.status = JobStatus.PLAYING
        else:
            job.status = JobStatus.QUEUED

    async def _refresh_derived(self, uow: UnitOfWork, job: Job) -> None:
        """Recompute the derived state, then keep the progress row consistent.

        The computation itself lives on the domain object
        (`Job.recompute_derived`), because it is a property of the aggregate, not
        of storage: a freshly built job in a test can be made consistent the
        same way the manager does it.
        """
        job.recompute_derived()
        await self._sync_progress_heard_seconds(uow, job)

    async def _sync_progress_heard_seconds(self, uow: UnitOfWork, job: Job) -> None:
        """Keep the progress row's `heard_seconds` consistent with the takes.

        The sum is stored rather than derived so `remaining_seconds` needs no
        chunk access. A chunk's duration, version or epoch changing is what
        invalidates it, and every one of those paths ends in `_refresh_derived`.
        The row is only written when the value actually moved.
        """
        progress = await uow.progress.get(job.user_id, job.id)
        if progress is None:
            return
        expected = heard_seconds(job, progress)
        if progress.heard_seconds != expected:
            progress.heard_seconds = expected
            await uow.progress.save(progress)

    async def exportable_wav_paths(self, job: Job) -> list[str]:
        """WAV paths of the downloadable run: live takes, written, from index 0.

        The export must follow the *active* take of each index. Walking every
        record (including superseded ones) exported the rejected audio and, once
        an index had two written versions, stopped the download at that index.
        """
        paths: list[str] = []
        for expected_index, chunk in enumerate(job.active_chunks()):
            if chunk.index != expected_index:
                break
            if chunk.status != ChunkStatus.WRITTEN or not chunk.wav_path:
                break
            paths.append(chunk.wav_path)
        return paths

    async def queue_depth(self) -> int:
        """Chunks the scheduler can still act on.

        Summed from the stored `pending_chunks` rollup, so answering "how much
        work is left" costs one column read instead of every chunk of every job.
        """
        return sum(job.pending_chunks for job in await self.summaries())

    async def add_versioned_chunk(
        self,
        job_id: str,
        *,
        text: str,
        char_start: int,
        char_end: int,
        voice_id: str,
        parent_index: int,
    ) -> Job:
        """Add a new take for `parent_index` and make it the live version.

        A reprocess is real work, so a finished job leaves the terminal state
        here rather than relying on the caller to remember: the reader stops
        polling a completed job, so it would never see the replacement chunk.
        """
        async with self._db.transaction() as uow:
            job = await self._require_job(uow, job_id)
            existing = job.active_chunk(parent_index)
            if existing is None:
                # Validate before appending: a rejected parent index used to
                # leave an orphan record behind when activation failed.
                raise KeyError(f"Chunk {parent_index} does not exist")
            self._reactivate_locked(job)
            version = job.get_latest_chunk_version(parent_index) + 1
            chunk = ChunkRecord(
                job_id=job_id,
                index=parent_index,
                text=text,
                voice_id=voice_id,
                language=job.language,
                plan_version=job.plan_version,
                char_start=char_start,
                char_end=char_end,
                version=version,
                parent_chunk_index=parent_index,
                status=ChunkStatus.PLANNED,
                reprocessing=True,
            )
            job.chunks.append(chunk)
            job.activate_chunk_version(parent_index, version)
            await self._refresh_derived(uow, job)
            self._settle_status(job)
            job.updated_at = utc_now()
            await uow.jobs.save(job)
            return job

    async def set_active_chunk_version(self, job_id: str, chunk_index: int, version: int) -> Job:
        """Make an already-rendered take the live one for `chunk_index`.

        Switching takes changes what the reader plays and what the download
        exports, so the derived state is recomputed. An unknown version is a
        client error, not a silent no-op: `Job.activate_chunk_version` raises.

        `audio_epoch` is bumped because the audible take changed: the reader
        keys its media stream on the epoch, and without the bump a session that
        already buffered the old take would keep playing it. Positions are left
        alone — this is a take swap, not a re-render of the whole job.
        """
        async with self._db.transaction() as uow:
            job = await self._require_job(uow, job_id)
            job.activate_chunk_version(chunk_index, version)
            job.audio_epoch += 1
            await self._refresh_derived(uow, job)
            self._settle_status(job)
            job.updated_at = utc_now()
            await uow.jobs.save(job)
            return job

    async def reactivate_job(self, job_id: str) -> Job:
        """Reactivate a completed or failed job so it can be reprocessed."""
        async with self._db.transaction() as uow:
            job = await self._require_job(uow, job_id)
            self._reactivate_locked(job)
            await uow.jobs.save(job)
            return job

    def _reactivate_locked(self, job: Job) -> None:
        if job.status not in {JobStatus.COMPLETED, JobStatus.FAILED}:
            return
        job.status = JobStatus.QUEUED
        job.is_active_listening = False
        job.playback_state.is_playing = False
        job.updated_at = utc_now()

    # ── startup reconciliation ─────────────────────────────────────────────

    async def recover_after_restart(
        self,
        audio_exists: Callable[[ChunkRecord], bool] | None = None,
    ) -> RecoveryResult:
        """Repair the state a crashed process left behind.

        Runs once at startup, before the scheduler autostarts, so no tick can
        observe an interrupted chunk as in-flight. The decision is
        `app.jobs.recovery.plan_startup_recovery` (pure); this only applies it,
        one transaction per job, so one malformed job cannot block the rest.

        A completed job whose audio is intact is untouched. A completed job
        whose audio vanished *is* revived: its chunks go back in the queue, so
        leaving it terminal would hide real work.

        Trashed jobs are included on purpose. A job that was mid-render when the
        process died keeps a `RENDERING` chunk, and `renderable_chunks()` only
        dispatches `PLANNED` ones — so restoring it later would leave it stuck
        forever. Repairing it here costs one write and keeps restore honest.
        """
        async with self._db.transaction() as uow:
            job_ids = [summary.id for summary in await uow.jobs.summaries_all(include_deleted=True)]
        recovered: list[str] = []
        for job_id in job_ids:
            async with self._db.transaction() as uow:
                job = await uow.jobs.get_any(job_id, include_deleted=True)
                if job is None:
                    continue
                plan = plan_startup_recovery(job, audio_exists)
                if not plan.needed:
                    continue
                await self._apply_recovery_plan(uow, job, plan)
                recovered.append(job.id)
        return RecoveryResult(examined=len(job_ids), recovered=tuple(recovered))

    async def _apply_recovery_plan(self, uow: UnitOfWork, job: Job, plan: RecoveryPlan) -> None:
        now = utc_now()
        reset_audio = {id(chunk) for chunk in plan.reset_audio}
        for chunk in plan.requeue:
            stored = self._resolve_chunk(job, chunk)
            stored.status = ChunkStatus.PLANNED
            if id(chunk) in reset_audio:
                # The file is gone, so the duration and paths must go with it:
                # keeping them would leave a written-looking take that cannot
                # be served.
                stored.duration_seconds = 0.0
                stored.start_seconds = 0.0
                stored.segment_path = None
                stored.wav_path = None
            stored.updated_at = now
        if plan.clear_listener:
            job.is_active_listening = False
            job.playback_state.is_playing = False
        if job.status in TERMINAL_JOB_STATUSES and job.has_unfinished_chunks():
            # A terminal job with queued work is not terminal any more.
            job.status = JobStatus.QUEUED
        await self._refresh_derived(uow, job)
        self._settle_status(job)
        job.updated_at = now
        await uow.jobs.save(job)

    def _derive_title(self, source_text: str) -> str:
        first_line = source_text.strip().splitlines()[0] if source_text.strip() else "Untitled Job"
        return first_line[:80]
