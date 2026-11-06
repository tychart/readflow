"""Listening-progress commands over the storage seam.

The client reports what it actually played; the server stores it keyed by chunk
version and derives everything else. No read status is ever sent by the client.
"""

from __future__ import annotations

from collections.abc import Iterable
from time import time

from app.core.identity import DEFAULT_USER_ID
from app.db.protocols import Database, UnitOfWork
from app.jobs.models import ChunkStatus, Job
from app.library.models import JobProgress
from app.library.progress import (
    ProgressView,
    progress_view,
    valid_heard,
)


class ProgressService:
    def __init__(
        self,
        database: Database,
        *,
        user_id: str = DEFAULT_USER_ID,
        estimated_chars_per_second: float = 18.0,
    ) -> None:
        self._db = database
        self._user_id = user_id
        self._chars_per_second = estimated_chars_per_second

    # ── reads ───────────────────────────────────────────────────────────────

    def views(self, jobs: Iterable[Job]) -> dict[str, ProgressView]:
        jobs = list(jobs)
        with self._db.transaction() as uow:
            rows = {row.job_id: row for row in uow.progress.list(self._user_id)}
        return {job.id: self._view(job, rows.get(job.id)) for job in jobs}

    def view(self, job: Job) -> ProgressView:
        with self._db.transaction() as uow:
            row = uow.progress.get(self._user_id, job.id)
        return self._view(job, row)

    def _view(self, job: Job, progress: JobProgress | None) -> ProgressView:
        return progress_view(job, progress, estimated_chars_per_second=self._chars_per_second)

    # ── playback reports ────────────────────────────────────────────────────

    def record(
        self,
        job_id: str,
        *,
        position_seconds: float,
        heard_chunk_indexes: Iterable[int] = (),
    ) -> tuple[Job, JobProgress]:
        """Store a position report and union any newly heard chunks.

        `heard_chunk_indexes` is additive on purpose: the client only reports
        what it has heard since the last flush, so a dropped report cannot lose
        listening history. Indexes are stored with the version that was live at
        the time, which invalidates them automatically if the chunk is
        reprocessed later.
        """
        now = time()
        with self._db.transaction() as uow:
            job = self._require_job(uow, job_id)
            progress = self._ensure(uow, job)
            if progress.audio_epoch != job.audio_epoch:
                # A full re-render replaced the audio; old heard marks describe
                # a take that no longer exists.
                progress.heard.clear()
                progress.audio_epoch = job.audio_epoch
            progress.position_seconds = max(0.0, position_seconds)
            for index in heard_chunk_indexes:
                version = job.active_chunk_version.get(index)
                if version is not None:
                    progress.heard[index] = version
            progress.updated_at = now
            uow.progress.save(progress)
            return job, progress

    # ── manual marks ────────────────────────────────────────────────────────

    def mark_job(
        self, job_id: str, *, read: bool, from_chunk: int | None = None
    ) -> tuple[Job, JobProgress]:
        """Mark a whole job, or everything from `from_chunk` onward."""
        with self._db.transaction() as uow:
            job = self._require_job(uow, job_id)
            progress = self._apply_mark(uow, job, read=read, from_chunk=from_chunk)
            return job, progress

    def mark_many(self, job_ids: Iterable[str], *, read: bool) -> None:
        """Bulk mark (selection mode) in one transaction.

        Validates every id before changing anything: a stale selection must not
        half-apply (the in-memory adapter does not roll back attribute edits).
        """
        with self._db.transaction() as uow:
            jobs = [self._require_job(uow, job_id) for job_id in dict.fromkeys(job_ids)]
            for job in jobs:
                self._apply_mark(uow, job, read=read, from_chunk=None)

    def _apply_mark(
        self, uow: UnitOfWork, job: Job, *, read: bool, from_chunk: int | None
    ) -> JobProgress:
        now = time()
        progress = self._ensure(uow, job)
        if progress.audio_epoch != job.audio_epoch:
            progress.heard.clear()
            progress.audio_epoch = job.audio_epoch

        indexes = self._mark_indexes(job, from_chunk)
        if read:
            for index in indexes:
                version = job.active_chunk_version.get(index)
                if version is not None:
                    progress.heard[index] = version
            if from_chunk is None:
                # Declaring a job read also means "I am done listening": move the
                # restore position to the end so reopening does not restart it.
                progress.position_seconds = self._end_seconds(job)
        else:
            for index in indexes:
                progress.heard.pop(index, None)
            if from_chunk is not None:
                # Resume where the unmarked range starts, not in the middle of
                # audio the listener just said they had not heard.
                chunk = job.active_chunk(from_chunk)
                if chunk is not None:
                    progress.position_seconds = min(progress.position_seconds, chunk.start_seconds)
            else:
                progress.position_seconds = 0.0
        progress.updated_at = now
        uow.progress.save(progress)
        return progress

    def mark_chunk(self, job_id: str, chunk_index: int, *, heard: bool) -> tuple[Job, JobProgress]:
        now = time()
        with self._db.transaction() as uow:
            job = self._require_job(uow, job_id)
            progress = self._ensure(uow, job)
            if progress.audio_epoch != job.audio_epoch:
                progress.heard.clear()
                progress.audio_epoch = job.audio_epoch
            version = job.active_chunk_version.get(chunk_index)
            if version is None:
                raise KeyError(f"Chunk {chunk_index} does not exist")
            if heard:
                progress.heard[chunk_index] = version
            else:
                progress.heard.pop(chunk_index, None)
            progress.updated_at = now
            uow.progress.save(progress)
            return job, progress

    # ── helpers ─────────────────────────────────────────────────────────────

    def _ensure(self, uow: UnitOfWork, job: Job) -> JobProgress:
        progress = uow.progress.get(self._user_id, job.id)
        if progress is None:
            progress = JobProgress(
                user_id=self._user_id,
                job_id=job.id,
                audio_epoch=job.audio_epoch,
                updated_at=time(),
            )
            uow.progress.add(progress)
        return progress

    def _require_job(self, uow: UnitOfWork, job_id: str) -> Job:
        job = uow.jobs.get(self._user_id, job_id)
        if job is None:
            raise KeyError(f"Unknown job '{job_id}'")
        return job

    @staticmethod
    def _end_seconds(job: Job) -> float:
        return max(
            (
                chunk.start_seconds + chunk.duration_seconds
                for chunk in job.active_chunks()
                if chunk.status == ChunkStatus.WRITTEN
            ),
            default=0.0,
        )

    @staticmethod
    def _mark_indexes(job: Job, from_chunk: int | None) -> list[int]:
        indexes = [
            chunk.index for chunk in job.active_chunks() if chunk.status != ChunkStatus.FAILED
        ]
        if from_chunk is None:
            return indexes
        if from_chunk not in {chunk.index for chunk in job.active_chunks()}:
            raise KeyError(f"Chunk {from_chunk} does not exist")
        return [index for index in indexes if index >= from_chunk]


__all__ = ["ProgressService", "valid_heard"]
