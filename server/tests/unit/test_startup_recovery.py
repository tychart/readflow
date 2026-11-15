"""Startup reconciliation repairs what a crashed process left behind.

The plan is a pure function (`plan_startup_recovery`) and the manager applies it
one transaction per job (`recover_after_restart`). These tests cover the states
a restart can actually produce, plus the two properties that matter most:
running it twice changes nothing, and a job whose audio is intact is untouched
even if it is finished.
"""

from __future__ import annotations

from app.chunking.planner import ChunkPlan
from app.db.memory import MemoryDatabase
from app.jobs.manager import JobManager
from app.jobs.models import ChunkStatus, Job, JobStatus
from app.jobs.recovery import plan_startup_recovery


def _manager() -> JobManager:
    return JobManager(MemoryDatabase())


async def _job_with_chunks(manager: JobManager, *, written: int = 2) -> tuple[Job, list]:
    job = await manager.create_job(
        source_text="alpha beta gamma delta epsilon",
        source_kind="text",
        model_id="Qwen/Qwen3-TTS-12Hz-0.6B-Base",
        voice_id="suzy",
    )
    chunks = [
        await manager.add_planned_chunk(
            job.id,
            ChunkPlan(text=f"chunk {index}", char_start=index * 5, char_end=index * 5 + 5),
        )
        for index in range(3)
    ]
    for chunk in chunks[:written]:
        await manager.mark_chunk_written(
            chunk,
            duration_seconds=10.0,
            segment_path=f"/tmp/{chunk.index}.m4s",
            wav_path=f"/tmp/{chunk.index}.wav",
        )
    return await manager.get_job(job.id), chunks


async def test_an_interrupted_render_is_requeued_without_charging_an_attempt() -> None:
    manager = _manager()
    job, _chunks = await _job_with_chunks(manager)
    interrupted = (await manager.get_job(job.id)).active_chunk(2)
    assert interrupted is not None
    interrupted.status = ChunkStatus.RENDERING
    interrupted.attempts = 1

    plan = plan_startup_recovery(await manager.get_job(job.id))

    assert [chunk.index for chunk in plan.requeue] == [2]
    assert plan.reset_audio == ()
    assert plan.needed is True


async def test_a_written_chunk_with_missing_audio_is_requeued_and_cleared() -> None:
    manager = _manager()
    job, _chunks = await _job_with_chunks(manager)

    # Only chunk 0's audio survived the restart.
    plan = plan_startup_recovery(await manager.get_job(job.id), lambda chunk: chunk.index == 0)

    assert [chunk.index for chunk in plan.requeue] == [1]
    assert [chunk.index for chunk in plan.reset_audio] == [1]


async def test_recovery_clears_listener_flags_and_requeues_rendering_chunks() -> None:
    manager = _manager()
    job, _chunks = await _job_with_chunks(manager)
    await manager.activate_job(job.id)
    stored = await manager.get_job(job.id)
    rendering = stored.active_chunk(2)
    assert rendering is not None
    rendering.status = ChunkStatus.RENDERING

    result = await manager.recover_after_restart()

    assert job.id in result.recovered
    recovered = await manager.get_job(job.id)
    assert recovered.is_active_listening is False
    assert recovered.playback_state.is_playing is False
    requeued = recovered.active_chunk(2)
    assert requeued is not None
    assert requeued.status == ChunkStatus.PLANNED
    # The job is schedulable again rather than stuck in `rendering`.
    assert recovered.status in {JobStatus.QUEUED, JobStatus.PLAYING}


async def test_recovery_restores_a_written_take_that_lost_its_audio() -> None:
    manager = _manager()
    job, _chunks = await _job_with_chunks(manager)

    await manager.recover_after_restart(lambda chunk: chunk.index != 1)

    recovered = await manager.get_job(job.id)
    lost = recovered.active_chunk(1)
    assert lost is not None
    assert lost.status == ChunkStatus.PLANNED
    assert lost.segment_path is None
    assert lost.wav_path is None
    assert lost.duration_seconds == 0.0
    # The rollups were recomputed: only chunk 0 is still rendered.
    assert recovered.total_chunks_completed == 1
    assert recovered.unwritten_chars == len("chunk 1") + len("chunk 2")


async def test_recovery_leaves_a_finished_job_with_intact_audio_alone() -> None:
    manager = _manager()
    job, _chunks = await _job_with_chunks(manager, written=3)
    await manager.finish_planning(job.id)
    finished = await manager.get_job(job.id)
    assert finished.status == JobStatus.COMPLETED
    updated_before = finished.updated_at

    result = await manager.recover_after_restart(lambda _chunk: True)

    assert result.recovered == ()
    assert (await manager.get_job(job.id)).updated_at == updated_before
    assert (await manager.get_job(job.id)).status == JobStatus.COMPLETED


async def test_a_completed_job_whose_audio_vanished_is_revived() -> None:
    """Leaving it terminal would hide real work, so it starts rendering again."""
    manager = _manager()
    job, _chunks = await _job_with_chunks(manager, written=3)
    await manager.finish_planning(job.id)
    assert (await manager.get_job(job.id)).status == JobStatus.COMPLETED

    await manager.recover_after_restart(lambda _chunk: False)

    revived = await manager.get_job(job.id)
    assert revived.status in {JobStatus.QUEUED, JobStatus.PLAYING}
    assert revived.total_chunks_completed == 0


async def test_recovery_is_idempotent() -> None:
    manager = _manager()
    job, _chunks = await _job_with_chunks(manager)
    stored = await manager.get_job(job.id)
    rendering = stored.active_chunk(2)
    assert rendering is not None
    rendering.status = ChunkStatus.RENDERING
    await manager.activate_job(job.id)

    first = await manager.recover_after_restart(lambda _chunk: chunk_index_exists(_chunk))
    second = await manager.recover_after_restart(lambda _chunk: chunk_index_exists(_chunk))

    assert job.id in first.recovered
    assert second.recovered == ()


def chunk_index_exists(chunk) -> bool:
    """Every chunk except the last one kept its audio in this fixture."""
    return chunk.index < 2


async def test_recovery_without_an_audio_check_only_repairs_interrupted_renders() -> None:
    manager = _manager()
    job, _chunks = await _job_with_chunks(manager)

    plan = plan_startup_recovery(await manager.get_job(job.id), None)

    assert plan.requeue == ()
    assert plan.reset_audio == ()
    assert plan.needed is False


async def test_a_trashed_job_is_repaired_too() -> None:
    """A job trashed mid-render must not come back stuck.

    `renderable_chunks()` only dispatches `PLANNED` chunks, so a `RENDERING` one
    left behind by a crash would never be picked up again after a restore.
    """
    manager = _manager()
    job, _chunks = await _job_with_chunks(manager)
    stored = await manager.get_job(job.id)
    rendering = stored.active_chunk(2)
    assert rendering is not None
    rendering.status = ChunkStatus.RENDERING
    stored.deleted_at = 1.0
    stored.trash_entry_id = "entry-1"

    result = await manager.recover_after_restart()

    assert job.id in result.recovered
    trashed = manager._db.transaction()
    async with trashed as uow:
        repaired = await uow.jobs.get_any(job.id, include_deleted=True)
    assert repaired is not None
    chunk = repaired.active_chunk(2)
    assert chunk is not None and chunk.status == ChunkStatus.PLANNED
    # Still in the trash: repair must not resurrect it into the library.
    assert repaired.deleted_at == 1.0
