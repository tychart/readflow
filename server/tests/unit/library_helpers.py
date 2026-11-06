"""Shared builders for library/progress tests.

Not a `test_*` module on purpose: pytest must not collect it.
"""

from __future__ import annotations

from app.jobs.models import ChunkRecord, ChunkStatus, Job, JobStatus
from app.library.models import Folder

MODEL = "Qwen/Qwen3-TTS-12Hz-0.6B-Base"


def build_chunk(
    job_id: str,
    index: int,
    *,
    version: int = 0,
    status: ChunkStatus = ChunkStatus.WRITTEN,
    duration: float = 10.0,
    text: str = "chunk text",
) -> ChunkRecord:
    chunk = ChunkRecord(
        job_id=job_id,
        index=index,
        text=text,
        voice_id="suzy",
        plan_version=1,
        char_start=0,
        char_end=len(text),
        version=version,
        status=status,
    )
    chunk.duration_seconds = duration if status == ChunkStatus.WRITTEN else 0.0
    return chunk


def build_job(
    job_id: str = "job-1",
    chunks: list[ChunkRecord] | None = None,
    *,
    folder_id: str | None = None,
    position: int = 0,
    planner_exhausted: bool = True,
    audio_epoch: int = 0,
    user_id: str = "local",
    title: str | None = None,
    submitted_at: float = 0.0,
) -> Job:
    chunks = chunks or []
    job = Job(
        id=job_id,
        title=title or job_id,
        source_kind="text",
        source_text="One. Two. Three.",
        model_id=MODEL,
        voice_id="suzy",
        user_id=user_id,
        folder_id=folder_id,
        position=position,
        audio_epoch=audio_epoch,
        submitted_at=submitted_at,
    )
    job.chunks = chunks
    job.next_chunk_index = max((chunk.index for chunk in chunks), default=-1) + 1
    job.active_chunk_version = {chunk.index: chunk.version for chunk in chunks}
    job.planner_cursor.offset = -1 if planner_exhausted else 0
    job.planner_cursor.chunks_emitted = len(chunks)
    if planner_exhausted and not job.has_unfinished_chunks() and chunks:
        job.status = JobStatus.COMPLETED
    return job


def build_folder(
    folder_id: str,
    *,
    name: str | None = None,
    parent_id: str | None = None,
    position: int = 0,
    user_id: str = "local",
) -> Folder:
    return Folder(
        id=folder_id,
        name=name or folder_id,
        user_id=user_id,
        parent_id=parent_id,
        position=position,
    )


def layout(chunks: list[ChunkRecord]) -> None:
    """Assign timeline start seconds the way JobManager does."""
    running = 0.0
    for chunk in sorted(chunks, key=lambda item: item.index):
        chunk.start_seconds = running
        if chunk.status == ChunkStatus.WRITTEN:
            running += chunk.duration_seconds
