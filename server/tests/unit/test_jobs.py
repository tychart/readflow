from app.jobs.manager import JobManager
from app.jobs.models import ChunkStatus, JobStatus


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


def test_completed_jobs_ignore_playback_lifecycle_mutations():
    manager = JobManager()
    job = manager.create_job(
        source_text="One finished chunk.",
        source_kind="text",
        model_id="Qwen/Qwen3-TTS-12Hz-0.6B-Base",
        voice_id="suzy",
    )
    chunk = manager.add_planned_chunk(
        job.id,
        text="One finished chunk.",
        char_start=0,
        char_end=18,
        plan_version=job.plan_version,
        voice_id="suzy",
    )
    chunk.status = ChunkStatus.WRITTEN
    chunk.duration_seconds = 3.0
    chunk.segment_path = "/tmp/job-1-0.m4s"
    job.planner_cursor.offset = -1

    completed = manager.mark_chunk_written(
        chunk,
        duration_seconds=3.0,
        segment_path="/tmp/job-1-0.m4s",
    )
    assert completed.status == JobStatus.COMPLETED

    manager.activate_job(job.id)
    manager.pause_job(job.id)
    manager.update_playback(job.id, current_time_seconds=2.5, is_playing=True)

    finished = manager.get_job(job.id)
    assert finished.status == JobStatus.COMPLETED
    assert finished.playback_state.current_time_seconds == 0.0
    assert finished.playback_state.is_playing is False
