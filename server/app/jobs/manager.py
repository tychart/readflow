from __future__ import annotations

from collections.abc import Iterable
from time import time
from uuid import uuid4

from app.chunking.normalize import normalize_source_text
from app.chunking.planner import ChunkPlan
from app.core.identity import DEFAULT_USER_ID
from app.db.protocols import Database, UnitOfWork
from app.jobs.models import (
    PENDING_CHUNK_STATUSES,
    ChunkRecord,
    ChunkStatus,
    Job,
    JobStatus,
)

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

    def _require_job(self, uow: UnitOfWork, job_id: str) -> Job:
        job = uow.jobs.get(self._user_id, job_id)
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

    def list_jobs(self) -> list[Job]:
        with self._db.transaction() as uow:
            jobs = uow.jobs.list(self._user_id)
        return sorted(jobs, key=lambda job: job.submitted_at, reverse=True)

    def get_job(self, job_id: str) -> Job:
        with self._db.transaction() as uow:
            return self._require_job(uow, job_id)

    # ── lifecycle ───────────────────────────────────────────────────────────

    def create_job(
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
        now = time()
        with self._db.transaction() as uow:
            if folder_id is not None and uow.folders.get(self._user_id, folder_id) is None:
                raise KeyError(f"Unknown folder '{folder_id}'")
            job = Job(
                id=str(uuid4()),
                title=title or self._derive_title(normalized_text),
                source_kind=source_kind,
                source_text=normalized_text,
                model_id=model_id,
                voice_id=voice_id,
                language=language,
                user_id=self._user_id,
                folder_id=folder_id,
                position=uow.jobs.next_position(self._user_id, folder_id),
                submitted_at=now,
                updated_at=now,
            )
            uow.jobs.add(job)
            return job

    def delete_job(self, job_id: str) -> None:
        with self._db.transaction() as uow:
            uow.jobs.delete(self._user_id, job_id)

    def activate_job(self, job_id: str) -> Job:
        with self._db.transaction() as uow:
            job = self._require_job(uow, job_id)
            if job.status in {JobStatus.COMPLETED, JobStatus.FAILED}:
                return job
            job.is_active_listening = True
            job.playback_state.is_playing = True
            job.playback_state.last_event_at = time()
            if job.status != JobStatus.COMPLETED:
                job.status = JobStatus.PLAYING
            job.updated_at = time()
            uow.jobs.save(job)
            return job

    def pause_job(self, job_id: str) -> Job:
        with self._db.transaction() as uow:
            job = self._require_job(uow, job_id)
            if job.status in {JobStatus.COMPLETED, JobStatus.FAILED}:
                return job
            job.is_active_listening = False
            job.playback_state.is_playing = False
            job.playback_state.last_event_at = time()
            job.status = JobStatus.PAUSED
            job.updated_at = time()
            uow.jobs.save(job)
            return job

    def resume_job(self, job_id: str) -> Job:
        with self._db.transaction() as uow:
            job = self._require_job(uow, job_id)
            if job.status == JobStatus.COMPLETED:
                return job
            job.status = JobStatus.QUEUED
            job.updated_at = time()
            uow.jobs.save(job)
            return job

    def update_playback(self, job_id: str, current_time_seconds: float, is_playing: bool) -> Job:
        """Record the listener's position.

        `current_time_seconds` is in **job-timeline** seconds (0 = the start of
        the first chunk), not the player's stream-normalized MSE clock. The
        buffer is derived from the same timeline, and subtracting a stream
        position after a seek/reload made `buffered_seconds` look permanently
        full (it is what kept a lookahead cap from ever being released), so the
        reader adds its anchor offset before reporting.
        """
        with self._db.transaction() as uow:
            job = self._require_job(uow, job_id)
            if job.status in {JobStatus.COMPLETED, JobStatus.FAILED}:
                return job
            job.playback_state.current_time_seconds = current_time_seconds
            job.playback_state.is_playing = is_playing
            job.playback_state.last_event_at = time()
            job.completed_seconds = max(job.completed_seconds, current_time_seconds)
            # The playable run is the cached contiguous duration, so this stays
            # O(1) on a path the reader hits ~20x/s during playback.
            job.buffered_seconds = max(0.0, job.contiguous_written_seconds - current_time_seconds)
            if is_playing and job.status != JobStatus.PAUSED:
                # A position report while playing is proof of an active
                # listener, so the flag does not depend on the reader hitting
                # /activate after a reload. Explicit pause still wins: that path
                # sets PAUSED first.
                job.is_active_listening = True
                job.status = JobStatus.PLAYING
            job.updated_at = time()
            uow.jobs.save(job)
            return job

    def set_render_to_end(self, job_id: str, enabled: bool = True) -> Job:
        """Opt this job out of (or back into) the scheduler's lookahead cap.

        The manual escape hatch for "keep rendering this book": it only affects
        `render_ahead_seconds`. A paused job still does not render, because pause
        is the one intentional stop.
        """
        with self._db.transaction() as uow:
            job = self._require_job(uow, job_id)
            job.render_to_end = enabled
            job.updated_at = time()
            uow.jobs.save(job)
            return job

    def expire_stale_listeners(self, timeout_seconds: float) -> list[Job]:
        """Forget listeners that stopped reporting playback positions.

        `is_active_listening` used to be sticky until an explicit pause or job
        completion, so a closed tab kept its job in the urgent priority band
        (and, with a lookahead cap configured, frozen at that cap forever).
        Returns the jobs that changed so the caller can broadcast them.
        """
        if timeout_seconds <= 0:
            return []
        now = time()
        expired: list[Job] = []
        with self._db.transaction() as uow:
            for job in uow.jobs.list(self._user_id):
                if not job.is_active_listening:
                    continue
                if job.status in {JobStatus.PAUSED, JobStatus.COMPLETED, JobStatus.FAILED}:
                    continue
                if now - job.playback_state.last_event_at <= timeout_seconds:
                    continue
                job.is_active_listening = False
                if job.status == JobStatus.PLAYING:
                    job.status = JobStatus.QUEUED
                job.updated_at = now
                uow.jobs.save(job)
                expired.append(job)
        return expired

    def set_voice(self, job_id: str, voice_id: str, *, rerender_written: bool = False) -> Job:
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
        with self._db.transaction() as uow:
            job = self._require_job(uow, job_id)
            if job.voice_id == voice_id and not rerender_written:
                return job
            job.voice_id = voice_id
            job.plan_version += 1
            now = time()
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
            self._refresh_derived(job)
            if requeued or rerender_written:
                # A finished job with work to redo must leave the terminal state
                # or the reader treats it as local and stops watching for the
                # replacement chunks.
                if job.status in {JobStatus.COMPLETED, JobStatus.FAILED}:
                    job.status = JobStatus.QUEUED
                self._settle_status(job)
            job.updated_at = now
            uow.jobs.save(job)
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
        self._apply_voice(job, chunk, time())
        return True

    def add_planned_chunk(self, job_id: str, plan: ChunkPlan) -> ChunkRecord:
        """Store one planned chunk and advance the planner cursor.

        The manager owns every mutation of the job: the planner only proposes a
        `ChunkPlan`. That keeps "planning advanced" and "chunk exists" atomic.
        """
        with self._db.transaction() as uow:
            job = self._require_job(uow, job_id)
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
                -1 if plan.char_end >= len(job.source_text) else plan.char_end
            )
            job.planner_cursor.chunks_emitted += 1
            job.updated_at = time()
            uow.jobs.save(job)
            return chunk

    def finish_planning(self, job_id: str) -> Job:
        """Mark the planner as having reached the end of the source text."""
        with self._db.transaction() as uow:
            job = self._require_job(uow, job_id)
            job.planner_cursor.offset = -1
            job.updated_at = time()
            self._settle_status(job)
            uow.jobs.save(job)
            return job

    def mark_chunk_rendering(self, chunk: ChunkRecord) -> None:
        with self._db.transaction() as uow:
            job = self._require_job(uow, chunk.job_id)
            stored = self._resolve_chunk(job, chunk)
            stored.status = ChunkStatus.RENDERING
            stored.updated_at = time()
            if job.status != JobStatus.PAUSED:
                job.status = JobStatus.RENDERING
            job.updated_at = time()
            uow.jobs.save(job)

    def mark_chunk_planned(self, chunk: ChunkRecord) -> Job:
        """Return a chunk to the queue untouched.

        Used when a batch is only partially rendered (the worker retries an OOM
        with fewer chunks) or could not even load the model, so the dropped
        chunks are retried on a later tick instead of being left stuck in
        `RENDERING`.
        """
        return self._requeue_chunk(chunk)

    def mark_chunk_retry(self, chunk: ChunkRecord, error: str) -> Job:
        """Requeue a chunk after a failed attempt, counting the attempt.

        Keeps the job alive: only the chunk is requeued, and the job continues
        rendering its other chunks until the attempt budget is spent.
        """
        with self._db.transaction() as uow:
            job = self._require_job(uow, chunk.job_id)
            stored = self._resolve_chunk(job, chunk)
            stored.attempts += 1
            stored.error = error
            return self._requeue_chunk_locked(uow, job, stored)

    def _requeue_chunk(self, chunk: ChunkRecord) -> Job:
        with self._db.transaction() as uow:
            job = self._require_job(uow, chunk.job_id)
            stored = self._resolve_chunk(job, chunk)
            return self._requeue_chunk_locked(uow, job, stored)

    def _requeue_chunk_locked(self, uow: UnitOfWork, job: Job, chunk: ChunkRecord) -> Job:
        chunk.status = ChunkStatus.PLANNED
        chunk.updated_at = time()
        self._requeue_superseded_chunk(job, chunk)
        self._settle_status(job)
        job.updated_at = time()
        uow.jobs.save(job)
        return job

    def mark_chunk_written(
        self,
        chunk: ChunkRecord,
        *,
        duration_seconds: float,
        segment_path: str,
        wav_path: str,
    ) -> Job:
        with self._db.transaction() as uow:
            job = self._require_job(uow, chunk.job_id)
            stored = self._resolve_chunk(job, chunk)
            # A chunk that came back after its plan generation was superseded is
            # requeued with the job's current voice rather than written as stale
            # audio (see `_requeue_superseded_chunk`).
            if self._requeue_superseded_chunk(job, stored):
                job.updated_at = time()
                uow.jobs.save(job)
                return job
            stored.status = ChunkStatus.WRITTEN
            stored.duration_seconds = duration_seconds
            stored.segment_path = segment_path
            stored.wav_path = wav_path
            stored.error = None
            stored.updated_at = time()
            self._refresh_derived(job)
            self._settle_status(job)
            job.updated_at = time()
            uow.jobs.save(job)
            return job

    def mark_chunk_failed(self, chunk: ChunkRecord, error: str) -> Job:
        """Mark a single chunk failed after its attempt budget is spent.

        Deliberately does NOT fail the whole job. One unrenderable chunk should
        leave a recoverable gap (visible in the reader and admin queue) while
        the rest of the job keeps rendering, rather than turning the job
        terminal and stopping all work on it.
        """
        with self._db.transaction() as uow:
            job = self._require_job(uow, chunk.job_id)
            stored = self._resolve_chunk(job, chunk)
            stored.status = ChunkStatus.FAILED
            stored.error = error
            stored.updated_at = time()
            self._requeue_superseded_chunk(job, stored)
            self._refresh_derived(job)
            self._settle_status(job)
            job.updated_at = time()
            uow.jobs.save(job)
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

    def _refresh_derived(self, job: Job) -> None:
        """Recompute everything derived from the chunk list, in one pass.

        Counts, timeline positions, the playable-run duration and
        `buffered_seconds` all describe the **live** takes. Superseded versions
        stay in `job.chunks` as history, and including them used to double-count
        a reprocessed chunk, inflate `buffered_seconds` with audio nobody will
        hear, and skew `total_chunks_completed` past `total_chunks_emitted`.
        """
        running_start = 0.0
        contiguous = 0.0
        contiguous_open = True
        completed = 0
        for chunk in job.active_chunks():
            if chunk.status != ChunkStatus.WRITTEN:
                # Start times place later written chunks as if the gap were
                # zero-length (the gap-aware timeline), but the *playable* run
                # stops at the first hole.
                contiguous_open = False
                continue
            completed += 1
            chunk.start_seconds = running_start
            running_start += chunk.duration_seconds
            if contiguous_open:
                contiguous += chunk.duration_seconds
        job.total_chunks_completed = completed
        job.contiguous_written_seconds = contiguous
        job.buffered_seconds = max(0.0, contiguous - job.playback_state.current_time_seconds)
        job.completed_seconds = max(job.completed_seconds, job.playback_state.current_time_seconds)

    def exportable_wav_paths(self, job: Job) -> list[str]:
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

    def renderable_chunks(self) -> Iterable[ChunkRecord]:
        """Planned chunks the scheduler may dispatch.

        Paused jobs are skipped here, not merely deprioritised. A paused job
        normally still has plan-ahead chunks sitting in `PLANNED`, and sending
        those to the GPU silently undid the pause (finishing the batch then
        rewrote the job status). Pause is the one intentional stop.
        """
        with self._db.transaction() as uow:
            jobs = uow.jobs.list(self._user_id)
        for job in jobs:
            if job.status == JobStatus.PAUSED:
                continue
            for chunk in job.chunks:
                if (
                    chunk.status == ChunkStatus.PLANNED
                    and chunk.plan_version == job.plan_version
                    and not chunk.deprecated
                ):
                    yield chunk

    def has_renderable_chunks(self) -> bool:
        """True when the scheduler has dispatchable work (paused jobs excluded)."""
        return any(True for _ in self.renderable_chunks())

    def queue_depth(self) -> int:
        """Chunks the scheduler can still act on (superseded takes excluded)."""
        with self._db.transaction() as uow:
            jobs = uow.jobs.list(self._user_id)
        return sum(
            1
            for job in jobs
            for chunk in job.chunks
            if chunk.status in PENDING_CHUNK_STATUSES and not chunk.deprecated
        )

    def add_versioned_chunk(
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
        with self._db.transaction() as uow:
            job = self._require_job(uow, job_id)
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
            self._refresh_derived(job)
            self._settle_status(job)
            job.updated_at = time()
            uow.jobs.save(job)
            return job

    def set_active_chunk_version(self, job_id: str, chunk_index: int, version: int) -> Job:
        """Make an already-rendered take the live one for `chunk_index`.

        Switching takes changes what the reader plays and what the download
        exports, so the derived state is recomputed. An unknown version is a
        client error, not a silent no-op: `Job.activate_chunk_version` raises.

        `audio_epoch` is bumped because the audible take changed: the reader
        keys its media stream on the epoch, and without the bump a session that
        already buffered the old take would keep playing it. Positions are left
        alone — this is a take swap, not a re-render of the whole job.
        """
        with self._db.transaction() as uow:
            job = self._require_job(uow, job_id)
            job.activate_chunk_version(chunk_index, version)
            job.audio_epoch += 1
            self._refresh_derived(job)
            self._settle_status(job)
            job.updated_at = time()
            uow.jobs.save(job)
            return job

    def reactivate_job(self, job_id: str) -> Job:
        """Reactivate a completed or failed job so it can be reprocessed."""
        with self._db.transaction() as uow:
            job = self._require_job(uow, job_id)
            self._reactivate_locked(job)
            uow.jobs.save(job)
            return job

    def _reactivate_locked(self, job: Job) -> None:
        if job.status not in {JobStatus.COMPLETED, JobStatus.FAILED}:
            return
        job.status = JobStatus.QUEUED
        job.is_active_listening = False
        job.playback_state.is_playing = False
        job.updated_at = time()

    def _derive_title(self, source_text: str) -> str:
        first_line = source_text.strip().splitlines()[0] if source_text.strip() else "Untitled Job"
        return first_line[:80]
