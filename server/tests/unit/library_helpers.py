"""Shared builders for library/progress tests.

Not a `test_*` module on purpose: pytest must not collect it.
"""

from __future__ import annotations

from app.chunking.planner import ChunkPlan
from app.jobs.manager import JobManager
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
        source_char_count=len("One. Two. Three."),
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
    # Rollups are the manager's job in production; a fixture has to make the
    # aggregate consistent the same way so derived-progress tests are meaningful.
    job.recompute_derived()
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


async def build_messy_job(manager: JobManager) -> Job:
    """A job with every shape the rollups have to survive.

    Built through the real manager so the fixture exercises the same write paths
    production uses:

    - chunk 0 written
    - chunk 1 written, then reprocessed (a second take becomes live)
    - chunk 2 failed
    - chunk 3 planned but never rendered (a gap in the playable run)
    - the voice changed, so the pending chunk was re-pointed
    """
    job = await manager.create_job(
        source_text="alpha beta gamma delta epsilon zeta eta theta",
        source_kind="text",
        model_id=MODEL,
        voice_id="suzy",
        title="Messy",
    )
    chunks = [
        await manager.add_planned_chunk(
            job.id,
            ChunkPlan(text=f"chunk {index} text", char_start=index * 5, char_end=index * 5 + 5),
        )
        for index in range(4)
    ]

    await manager.mark_chunk_written(
        chunks[0], duration_seconds=10.0, segment_path="/tmp/0.m4s", wav_path="/tmp/0.wav"
    )
    await manager.mark_chunk_written(
        chunks[1], duration_seconds=7.5, segment_path="/tmp/1.m4s", wav_path="/tmp/1.wav"
    )
    # A reprocess appends a take and makes it live; the old take stays as history.
    await manager.add_versioned_chunk(
        job.id,
        text="chunk 1 rewritten",
        char_start=5,
        char_end=10,
        voice_id="suzy",
        parent_index=1,
    )
    rewritten = (await manager.get_job(job.id)).active_chunk(1)
    assert rewritten is not None
    await manager.mark_chunk_written(
        rewritten,
        duration_seconds=9.0,
        segment_path="/tmp/1_v1.m4s",
        wav_path="/tmp/1_v1.wav",
    )
    await manager.mark_chunk_failed(chunks[2], "synthesis exploded")
    # Switching the live take back bumps the audio epoch.
    await manager.set_active_chunk_version(job.id, 1, 0)
    # A voice change re-points work that has not rendered yet.
    await manager.set_voice(job.id, "howard")
    return await manager.get_job(job.id)
