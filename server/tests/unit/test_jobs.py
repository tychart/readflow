from app.jobs.manager import JobManager
from app.jobs.models import ChunkStatus


def test_voice_switch_invalidates_future_unstarted_chunks():
    manager = JobManager()
    job = manager.create_job(
        source_text="One. Two. Three.",
        source_kind="text",
        model_id="Qwen/Qwen3-TTS-12Hz-0.6B-Base",
        voice_id="suzy",
    )
    first = manager.add_planned_chunk(
        job.id,
        text="One.",
        char_start=0,
        char_end=4,
        plan_version=job.plan_version,
        voice_id="suzy",
    )
    second = manager.add_planned_chunk(
        job.id,
        text="Two.",
        char_start=5,
        char_end=9,
        plan_version=job.plan_version,
        voice_id="suzy",
    )

    manager.mark_chunk_rendering(first)
    updated = manager.set_voice(job.id, "howard")

    assert updated.plan_version == 2
    assert first.status == ChunkStatus.RENDERING
    assert second.status == ChunkStatus.STALE
    assert updated.voice_id == "howard"
