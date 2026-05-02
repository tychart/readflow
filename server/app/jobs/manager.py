from __future__ import annotations

from collections.abc import Iterable
from time import time
from uuid import uuid4

from app.jobs.models import ChunkRecord, ChunkStatus, Job, JobStatus


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
        job = Job(
            id=str(uuid4()),
            title=title or self._derive_title(source_text),
            source_kind=source_kind,
            source_text=source_text,
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
        job.is_active_listening = True
        job.playback_state.is_playing = True
        job.playback_state.last_event_at = time()
        if job.status != JobStatus.COMPLETED:
            job.status = JobStatus.PLAYING
        job.updated_at = time()
        return job

    def pause_job(self, job_id: str) -> Job:
        job = self.get_job(job_id)
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

    def set_voice(self, job_id: str, voice_id: str) -> Job:
        job = self.get_job(job_id)
        job.voice_id = voice_id
        job.plan_version += 1
        for chunk in job.chunks:
            if chunk.status in {ChunkStatus.PLANNED, ChunkStatus.QUEUED}:
                chunk.status = ChunkStatus.STALE
                chunk.updated_at = time()
        job.updated_at = time()
        return job

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
            index=len(job.chunks),
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

    def mark_chunk_written(
        self,
        chunk: ChunkRecord,
        *,
        duration_seconds: float,
        segment_path: str,
    ) -> Job:
        chunk.status = ChunkStatus.WRITTEN
        chunk.duration_seconds = duration_seconds
        chunk.segment_path = segment_path
        chunk.updated_at = time()
        job = self.get_job(chunk.job_id)
        job.total_chunks_completed = len(job.written_chunks())
        self._recalculate_timeline(job)
        if job.planner_cursor.exhausted and not job.pending_chunks():
            job.status = JobStatus.COMPLETED
            job.is_active_listening = False
        elif job.is_active_listening:
            job.status = JobStatus.PLAYING
        else:
            job.status = JobStatus.QUEUED
        job.updated_at = time()
        return job

    def mark_chunk_failed(self, chunk: ChunkRecord, error: str) -> Job:
        chunk.status = ChunkStatus.FAILED
        chunk.error = error
        chunk.updated_at = time()
        job = self.get_job(chunk.job_id)
        job.status = JobStatus.FAILED
        job.failed_reason = error
        job.updated_at = time()
        return job

    def renderable_chunks(self) -> Iterable[ChunkRecord]:
        for job in self.list_jobs():
            for chunk in job.chunks:
                if chunk.status == ChunkStatus.PLANNED and chunk.plan_version == job.plan_version:
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
