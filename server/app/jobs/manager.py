from __future__ import annotations

from collections.abc import Iterable
from time import time
from uuid import uuid4

from app.chunking.normalize import normalize_source_text
from app.jobs.models import ChunkRecord, ChunkStatus, Job, JobStatus

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
    def __init__(self) -> None:
        self._jobs: dict[str, Job] = {}

    def create_job(
        self,
        *,
        source_text: str,
        source_kind: str,
        model_id: str,
        voice_id: str,
        language: str = "English",
        title: str | None = None,
    ) -> Job:
        now = time()
        normalized_text = normalize_source_text(source_text)
        job = Job(
            id=str(uuid4()),
            title=title or self._derive_title(normalized_text),
            source_kind=source_kind,
            source_text=normalized_text,
            model_id=model_id,
            voice_id=voice_id,
            language=language,
            submitted_at=now,
            updated_at=now,
        )
        self._jobs[job.id] = job
        return job

    def list_jobs(self) -> list[Job]:
        return sorted(self._jobs.values(), key=lambda job: job.submitted_at, reverse=True)

    def get_job(self, job_id: str) -> Job:
        try:
            return self._jobs[job_id]
        except KeyError as exc:
            raise KeyError(f"Unknown job '{job_id}'") from exc

    def delete_job(self, job_id: str) -> None:
        self._jobs.pop(job_id, None)

    def activate_job(self, job_id: str) -> Job:
        job = self.get_job(job_id)
        if job.status in {JobStatus.COMPLETED, JobStatus.FAILED}:
            return job
        job.is_active_listening = True
        job.playback_state.is_playing = True
        job.playback_state.last_event_at = time()
        if job.status != JobStatus.COMPLETED:
            job.status = JobStatus.PLAYING
        job.updated_at = time()
        return job

    def pause_job(self, job_id: str) -> Job:
        job = self.get_job(job_id)
        if job.status in {JobStatus.COMPLETED, JobStatus.FAILED}:
            return job
        job.is_active_listening = False
        job.playback_state.is_playing = False
        job.playback_state.last_event_at = time()
        job.status = JobStatus.PAUSED
        job.updated_at = time()
        return job

    def resume_job(self, job_id: str) -> Job:
        job = self.get_job(job_id)
        if job.status == JobStatus.COMPLETED:
            return job
        job.status = JobStatus.QUEUED
        job.updated_at = time()
        return job

    def update_playback(self, job_id: str, current_time_seconds: float, is_playing: bool) -> Job:
        job = self.get_job(job_id)
        if job.status in {JobStatus.COMPLETED, JobStatus.FAILED}:
            return job
        job.playback_state.current_time_seconds = current_time_seconds
        job.playback_state.is_playing = is_playing
        job.playback_state.last_event_at = time()
        job.completed_seconds = max(job.completed_seconds, current_time_seconds)
        job.buffered_seconds = max(
            0.0, self._contiguous_written_seconds(job) - current_time_seconds
        )
        if is_playing and job.status != JobStatus.PAUSED and job.status != JobStatus.COMPLETED:
            job.status = JobStatus.PLAYING
        job.updated_at = time()
        return job

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
        job = self.get_job(job_id)
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
                    # The worker already fetched the old voice prompt for this
                    # batch; pin the chunk to the current generation so it is
                    # written as-is instead of being requeued.
                    chunk.plan_version = job.plan_version
                    chunk.updated_at = now
                # A full re-render leaves the old plan version in place; the
                # chunk is requeued with the new voice once the batch returns.
                continue
            if rerender_written or chunk.status in _REVOICEABLE_STATUSES:
                self._apply_voice(job, chunk, now)
                requeued = True
        if rerender_written:
            job.audio_epoch += 1
            job.completed_seconds = 0.0
            job.buffered_seconds = 0.0
            job.total_chunks_completed = 0
            job.total_versioned_completed = 0
            job.playback_state.current_time_seconds = 0.0
            job.playback_state.is_playing = False
            if job.status in {JobStatus.COMPLETED, JobStatus.FAILED}:
                job.status = JobStatus.QUEUED
        elif requeued and job.status in {JobStatus.COMPLETED, JobStatus.FAILED}:
            # A finished job with a failed gap can still have work to redo, so
            # it must leave the terminal state or the reader treats it as local
            # and stops watching for the replacement chunks.
            job.status = JobStatus.QUEUED
        job.updated_at = now
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

    def add_planned_chunk(
        self,
        job_id: str,
        *,
        text: str,
        char_start: int,
        char_end: int,
        plan_version: int,
        voice_id: str,
    ) -> ChunkRecord:
        job = self.get_job(job_id)
        chunk = ChunkRecord(
            job_id=job_id,
            # Derive the index from the highest existing index rather than
            # `len(job.chunks)`: reprocessing appends a second record for an
            # existing index, which made `len` outrun the real index and made
            # the planner skip numbers (leaving a phantom gap).
            index=max((c.index for c in job.chunks), default=-1) + 1,
            text=text,
            voice_id=voice_id,
            language=job.language,
            plan_version=plan_version,
            char_start=char_start,
            char_end=char_end,
        )
        job.chunks.append(chunk)
        job.total_chunks_emitted = len(job.chunks)
        job.updated_at = time()
        return chunk

    def mark_chunk_queued(self, chunk: ChunkRecord) -> None:
        chunk.status = ChunkStatus.QUEUED
        chunk.updated_at = time()
        job = self.get_job(chunk.job_id)
        if job.status not in {JobStatus.PAUSED, JobStatus.COMPLETED}:
            job.status = JobStatus.RENDERING
        job.updated_at = time()

    def mark_chunk_rendering(self, chunk: ChunkRecord) -> None:
        chunk.status = ChunkStatus.RENDERING
        chunk.updated_at = time()
        job = self.get_job(chunk.job_id)
        job.status = JobStatus.RENDERING
        job.updated_at = time()

    def mark_chunk_planned(self, chunk: ChunkRecord) -> None:
        """Return a chunk to the queue.

        Used when a batch is only partially rendered (the worker retries an OOM
        with fewer chunks), so the dropped chunks are retried on a later tick
        instead of being left stuck in `RENDERING`.
        """
        chunk.status = ChunkStatus.PLANNED
        chunk.updated_at = time()
        job = self.get_job(chunk.job_id)
        self._requeue_superseded_chunk(job, chunk)
        job.updated_at = time()

    def mark_chunk_retry(self, chunk: ChunkRecord, error: str) -> Job:
        """Requeue a chunk after a failed attempt, counting the attempt.

        Keeps the job alive: only the chunk is requeued, and the job continues
        rendering its other chunks until the attempt budget is spent.
        """
        chunk.attempts += 1
        chunk.error = error
        chunk.status = ChunkStatus.PLANNED
        chunk.updated_at = time()
        job = self.get_job(chunk.job_id)
        self._requeue_superseded_chunk(job, chunk)
        job.updated_at = time()
        return job

    def mark_chunk_written(
        self,
        chunk: ChunkRecord,
        *,
        duration_seconds: float,
        segment_path: str,
        wav_path: str,
    ) -> Job:
        job = self.get_job(chunk.job_id)
        # A chunk that came back after its plan generation was superseded is
        # requeued with the job's current voice rather than written as stale
        # audio (see `_requeue_superseded_chunk`).
        if self._requeue_superseded_chunk(job, chunk):
            job.updated_at = time()
            return job
        chunk.status = ChunkStatus.WRITTEN
        chunk.duration_seconds = duration_seconds
        chunk.segment_path = segment_path
        chunk.wav_path = wav_path
        chunk.error = None
        chunk.updated_at = time()
        job.total_chunks_completed = len(job.written_chunks())
        job.total_versioned_completed = len(job.versioned_written_chunks())
        self._recalculate_timeline(job)
        # Complete only when the planner has nothing left to emit and no chunk
        # is still queued/rendering. `has_unfinished_chunks` (not the versioned
        # helper) is what makes this correct for ordinary, non-reprocessed jobs.
        if job.planner_cursor.exhausted and not job.has_unfinished_chunks():
            job.status = JobStatus.COMPLETED
            job.is_active_listening = False
        elif job.is_active_listening:
            job.status = JobStatus.PLAYING
        else:
            job.status = JobStatus.QUEUED
        job.updated_at = time()
        return job

    def mark_chunk_failed(self, chunk: ChunkRecord, error: str) -> Job:
        """Mark a single chunk failed after its attempt budget is spent.

        Deliberately does NOT fail the whole job. One unrenderable chunk should
        leave a recoverable gap (visible in the reader and admin queue) while
        the rest of the job keeps rendering, rather than turning the job
        terminal and stopping all work on it.
        """
        chunk.status = ChunkStatus.FAILED
        chunk.error = error
        chunk.updated_at = time()
        job = self.get_job(chunk.job_id)
        self._requeue_superseded_chunk(job, chunk)
        job.updated_at = time()
        return job

    def renderable_chunks(self) -> Iterable[ChunkRecord]:
        for job in self.list_jobs():
            for chunk in job.chunks:
                if (
                    chunk.status == ChunkStatus.PLANNED
                    and chunk.plan_version == job.plan_version
                    and not chunk.deprecated
                ):
                    yield chunk

    def queue_depth(self) -> int:
        return sum(
            1
            for job in self._jobs.values()
            for chunk in job.chunks
            if chunk.status in {ChunkStatus.PLANNED, ChunkStatus.QUEUED, ChunkStatus.RENDERING}
        )

    def _recalculate_timeline(self, job: Job) -> None:
        running_start = 0.0
        for chunk in sorted(job.chunks, key=lambda item: item.index):
            if chunk.status == ChunkStatus.WRITTEN:
                chunk.start_seconds = running_start
                running_start += chunk.duration_seconds
        job.buffered_seconds = max(0.0, running_start - job.playback_state.current_time_seconds)
        job.completed_seconds = max(job.completed_seconds, job.playback_state.current_time_seconds)

    def add_versioned_chunk(
        self,
        job_id: str,
        *,
        text: str,
        char_start: int,
        char_end: int,
        plan_version: int,
        voice_id: str,
        parent_index: int,
        retries: int = 0,
    ) -> Job:
        """Add a new version of a chunk. Marks lower versions as deprecated."""
        job = self.get_job(job_id)
        latest_version = job.get_latest_chunk_version(parent_index)
        new_version = latest_version + 1

        # Mark all existing versions of this chunk as deprecated
        job.mark_all_chunk_versions_deprecated(parent_index)

        # Create the new versioned chunk
        chunk = ChunkRecord(
            job_id=job_id,
            index=parent_index,
            text=text,
            voice_id=voice_id,
            language=job.language,
            plan_version=plan_version,
            char_start=char_start,
            char_end=char_end,
            version=new_version,
            parent_chunk_index=parent_index,
            status=ChunkStatus.PLANNED,
            reprocessing=True,
        )
        job.chunks.append(chunk)
        job.total_chunks_emitted = len(job.chunks)

        # Set as active version
        job.set_active_chunk_version(parent_index, new_version)
        job.total_versioned_chunks = len({c.index for c in job.chunks})
        job.updated_at = time()
        return job

    def set_active_chunk_version(self, job_id: str, chunk_index: int, version: int) -> Job:
        """Set the active version for a chunk index."""
        job = self.get_job(job_id)
        job.set_active_chunk_version(chunk_index, version)

        # Ensure the active version is not deprecated
        for chunk in job.chunks:
            if chunk.index == chunk_index and chunk.version == version:
                chunk.deprecated = False
                break

        job.updated_at = time()
        return job

    def reactivate_job(self, job_id: str) -> Job:
        """Reactivate a completed or failed job so it can be reprocessed."""
        job = self.get_job(job_id)
        if job.status not in {JobStatus.COMPLETED, JobStatus.FAILED}:
            return job
        job.status = JobStatus.QUEUED
        job.is_active_listening = False
        job.playback_state.is_playing = False
        job.updated_at = time()
        return job

    def _contiguous_written_seconds(self, job: Job) -> float:
        running = 0.0
        for chunk in sorted(job.chunks, key=lambda item: item.index):
            if chunk.status != ChunkStatus.WRITTEN:
                break
            running += chunk.duration_seconds
        return running

    def _derive_title(self, source_text: str) -> str:
        first_line = source_text.strip().splitlines()[0] if source_text.strip() else "Untitled Job"
        return first_line[:80]
