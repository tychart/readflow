"""`JobSummary` is a projection, not a second source of truth.

Two things can go wrong with a stored read model, and both are silent:

1. `Job` gains a field and the projection quietly forgets it (or renames it), so
   every list endpoint loses information nobody notices until the UI breaks.
2. The rollups drift from the chunks they summarise, so progress, the queue
   depth and the remaining-audio estimate start telling different stories.

The tests here pin both: the field list against the dataclass, the rollups
against a full re-scan of the chunks on a deliberately messy fixture (a gap, a
reprocessed take, a take switch, a failed chunk and a voice change), and every
derived answer from the summary against the same answer from the aggregate.
"""

from __future__ import annotations

import dataclasses

from app.chunking.planner import ChunkPlan
from app.db.memory import MemoryDatabase
from app.jobs.manager import JobManager
from app.jobs.models import (
    PENDING_CHUNK_STATUSES,
    SUMMARY_FIELDS,
    UNFINISHED_CHUNK_STATUSES,
    ChunkStatus,
    Job,
    JobSummary,
)
from app.library.models import JobProgress
from app.library.playback import ordered_folder_jobs, up_next_job_ids
from app.library.progress import (
    heard_seconds,
    progress_fraction,
    progress_view,
    read_status,
    remaining_seconds,
)
from tests.unit.library_helpers import MODEL, build_messy_job


def test_summary_fields_match_the_dataclass() -> None:
    declared = tuple(field.name for field in dataclasses.fields(JobSummary))
    assert SUMMARY_FIELDS == declared


def test_every_summary_field_is_read_from_the_aggregate() -> None:
    """The projection must not invent a field `Job` does not have."""
    job_fields = {field.name for field in dataclasses.fields(Job)}
    assert set(SUMMARY_FIELDS) <= job_fields


def _recomputed_rollups(job: Job) -> dict[str, object]:
    """Straightforward re-scan of the chunks, written independently."""
    live = job.active_chunks()
    written = [chunk for chunk in live if chunk.status == ChunkStatus.WRITTEN]
    contiguous = 0.0
    for chunk in live:
        if chunk.status != ChunkStatus.WRITTEN:
            break
        contiguous += chunk.duration_seconds
    return {
        "total_chunks_completed": len(written),
        "contiguous_written_seconds": contiguous,
        "written_seconds": sum(chunk.duration_seconds for chunk in written),
        "last_written_index": max((chunk.index for chunk in written), default=None),
        "unfinished_chunks": sum(1 for chunk in live if chunk.status in UNFINISHED_CHUNK_STATUSES),
        "unwritten_chars": sum(
            len(chunk.text) for chunk in live if chunk.status != ChunkStatus.WRITTEN
        ),
        "pending_chunks": sum(
            1
            for chunk in live
            if chunk.status in PENDING_CHUNK_STATUSES and chunk.plan_version == job.plan_version
        ),
    }


async def test_rollups_match_a_rescan_of_the_chunks(services_free_manager=None) -> None:
    manager = JobManager(MemoryDatabase())
    job = await build_messy_job(manager)

    for name, expected in _recomputed_rollups(job).items():
        assert getattr(job, name) == expected, name


async def test_rollups_survive_every_mutation_of_the_fixture() -> None:
    """The single writer keeps them correct at each step, not just at the end."""
    manager = JobManager(MemoryDatabase())
    job = await manager.create_job(
        source_text="alpha beta gamma",
        source_kind="text",
        model_id=MODEL,
        voice_id="suzy",
    )
    chunk = await manager.add_planned_chunk(
        job.id, ChunkPlan(text="alpha", char_start=0, char_end=5)
    )
    assert job.pending_chunks == 1
    assert job.unfinished_chunks == 1
    assert job.unwritten_chars == len("alpha")

    await manager.mark_chunk_written(
        chunk, duration_seconds=4.0, segment_path="/tmp/0.m4s", wav_path="/tmp/0.wav"
    )
    assert job.pending_chunks == 0
    assert job.unfinished_chunks == 0
    assert job.unwritten_chars == 0
    assert job.written_seconds == 4.0
    assert job.last_written_index == 0


async def test_summary_freezes_mutable_state() -> None:
    manager = JobManager(MemoryDatabase())
    job = await build_messy_job(manager)
    summary = job.summary()

    job.active_chunk_version[99] = 3
    job.playback_state.is_playing = True
    job.planner_cursor.offset = 123

    assert 99 not in summary.active_chunk_version
    assert summary.playback_state.is_playing is False
    assert summary.planner_cursor.offset != 123


async def test_summary_and_aggregate_agree_on_every_derived_answer() -> None:
    manager = JobManager(MemoryDatabase())
    job = await build_messy_job(manager)
    progress = JobProgress(
        user_id="local",
        job_id=job.id,
        audio_epoch=job.audio_epoch,
        heard={0: job.active_chunk_version[0]},
    )
    progress.heard_seconds = heard_seconds(job, progress)
    summary = job.summary()

    for heard in ({0}, {0, 1}, set()):
        assert progress_fraction(job, heard) == progress_fraction(summary, heard)
        assert read_status(job, heard, 5.0) == read_status(summary, heard, 5.0)

    assert remaining_seconds(
        job, progress.heard_seconds, chars_per_second=18.0
    ) == remaining_seconds(summary, progress.heard_seconds, chars_per_second=18.0)

    job_view = progress_view(job, progress, estimated_chars_per_second=18.0)
    summary_view = progress_view(summary, progress, estimated_chars_per_second=18.0)
    assert job_view == summary_view


async def test_summary_ordering_matches_the_aggregates() -> None:
    database = MemoryDatabase()
    manager = JobManager(database)
    first = await build_messy_job(manager)
    # A second job in the same folder, so ordering has something to order.
    async with database.transaction() as uow:
        await uow.folders.add(_folder("folder-1"))
        job = await uow.jobs.get("local", first.id)
        assert job is not None
        job.folder_id = "folder-1"
        job.position = 1
        await uow.jobs.save(job)
    await manager.create_job(
        source_text="second job text",
        source_kind="text",
        model_id=MODEL,
        voice_id="suzy",
        folder_id="folder-1",
    )
    async with database.transaction() as uow:
        second = next(job for job in await uow.jobs.list("local") if job.id != first.id)
        second.position = 0
        await uow.jobs.save(second)

    aggregates = await manager.list_jobs()
    summaries = await manager.summaries()
    assert [job.id for job in ordered_folder_jobs(aggregates, "folder-1")] == [
        job.id for job in ordered_folder_jobs(summaries, "folder-1")
    ]


async def test_upcoming_warming_is_the_same_from_summaries() -> None:
    database = MemoryDatabase()
    manager = JobManager(database)
    warmed = await build_messy_job(manager)
    async with database.transaction() as uow:
        await uow.folders.add(_folder("folder-1"))
        job = await uow.jobs.get("local", warmed.id)
        assert job is not None
        job.folder_id = "folder-1"
        job.position = 0
        job.is_active_listening = True
        await uow.jobs.save(job)
    await manager.create_job(
        source_text="next book",
        source_kind="text",
        model_id=MODEL,
        voice_id="suzy",
        folder_id="folder-1",
    )

    aggregates = await manager.list_jobs()
    summaries = await manager.summaries()
    assert up_next_job_ids(aggregates, prebuffer_seconds=120) == up_next_job_ids(
        summaries, prebuffer_seconds=120
    )


def _folder(folder_id: str):
    from app.library.models import Folder

    return Folder(id=folder_id, name=folder_id, user_id="local")
