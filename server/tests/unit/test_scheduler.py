import asyncio

from app.jobs.models import JobStatus
from app.synthesis.worker import RenderedChunkResult


def test_scheduler_prioritizes_active_listening_jobs_and_writes_media(services):
    active = services.job_manager.create_job(
        source_text="This active job should get rendered first. " * 8,
        source_kind="text",
        model_id=services.settings.runtime.default_model_id,
        voice_id="suzy",
        title="Active",
    )
    passive = services.job_manager.create_job(
        source_text="This passive job can wait a bit. " * 8,
        source_kind="text",
        model_id=services.settings.runtime.default_model_id,
        voice_id="howard",
        title="Passive",
    )
    services.job_manager.activate_job(active.id)

    asyncio.run(services.scheduler.run_once())

    active_after = services.job_manager.get_job(active.id)
    passive_after = services.job_manager.get_job(passive.id)

    assert active_after.total_chunks_completed >= 1
    assert passive_after.total_chunks_completed == 0
    assert active_after.status in {JobStatus.PLAYING, JobStatus.QUEUED, JobStatus.COMPLETED}
    assert services.media_store.init_segment_path(active.id).exists()


def test_scheduler_reduces_batch_size_when_memory_is_high(services):
    job = services.job_manager.create_job(
        source_text=("alpha beta gamma delta. " * 80).strip(),
        source_kind="text",
        model_id=services.settings.runtime.default_model_id,
        voice_id="suzy",
        title="Large batch",
    )
    services.job_manager.activate_job(job.id)
    services.settings.runtime.vram_soft_limit_mb = 1

    async def fake_memory_stats():
        return (5000, 4200)

    services.model_manager.memory_stats = fake_memory_stats

    asyncio.run(services.scheduler.run_once())

    snapshot = services.telemetry.snapshot()
    assert snapshot["recent_batches"][0]["batch_size"] <= 3


def test_scheduler_batches_one_voice_at_a_time(services):
    first = services.job_manager.create_job(
        source_text="Short first job. " * 12,
        source_kind="text",
        model_id=services.settings.runtime.default_model_id,
        voice_id="suzy",
        title="First",
    )
    second = services.job_manager.create_job(
        source_text="Short second job. " * 12,
        source_kind="text",
        model_id=services.settings.runtime.default_model_id,
        voice_id="howard",
        title="Second",
    )
    services.job_manager.activate_job(first.id)
    services.job_manager.activate_job(second.id)
    services.settings.runtime.batch_candidates_small_model = [2, 1]

    captured_batches: list[list[str]] = []

    async def fake_render_batch(model_id: str, chunks):
        del model_id
        captured_batches.append([chunk.voice_id for chunk in chunks])
        return [
            RenderedChunkResult(
                chunk_index=chunk.index,
                segment_path=f"/tmp/{chunk.job_id}-{chunk.index}.m4s",
                init_segment_path=f"/tmp/{chunk.job_id}-init.mp4",
                duration_seconds=1.0,
                reserved_vram_mb=0,
                allocated_vram_mb=0,
            )
            for chunk in chunks
        ]

    services.worker.render_batch = fake_render_batch

    asyncio.run(services.scheduler.run_once())

    assert captured_batches
    assert len(captured_batches[0]) == 1
    assert len(set(captured_batches[0])) == 1
