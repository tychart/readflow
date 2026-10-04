from app.jobs.manager import JobManager
from app.jobs.models import ChunkRecord, ChunkStatus, Job, JobStatus


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
    chunk.wav_path = "/tmp/job-1-0.wav"
    job.planner_cursor.offset = -1

    completed = manager.mark_chunk_written(
        chunk,
        duration_seconds=3.0,
        segment_path="/tmp/job-1-0.m4s",
        wav_path="/tmp/job-1-0.wav",
    )
    assert completed.status == JobStatus.COMPLETED

    manager.activate_job(job.id)
    manager.pause_job(job.id)
    manager.update_playback(job.id, current_time_seconds=2.5, is_playing=True)

    finished = manager.get_job(job.id)
    assert finished.status == JobStatus.COMPLETED
    assert finished.playback_state.current_time_seconds == 0.0
    assert finished.playback_state.is_playing is False


def test_create_job_stores_canonical_source_text():
    manager = JobManager()

    job = manager.create_job(
        source_text="  First  line.\r\n\r\n\r\n\r\nSecond\tline.  ",
        source_kind="text",
        model_id="Qwen/Qwen3-TTS-12Hz-0.6B-Base",
        voice_id="suzy",
    )

    assert job.source_text == "First line.\n\nSecond line."


def _job_with_chunks(count: int) -> tuple[JobManager, Job, list[ChunkRecord]]:
    manager = JobManager()
    job = manager.create_job(
        source_text="One. Two. Three.",
        source_kind="text",
        model_id="Qwen/Qwen3-TTS-12Hz-0.6B-Base",
        voice_id="suzy",
    )
    chunks = [
        manager.add_planned_chunk(
            job.id,
            text=f"Chunk {index}.",
            char_start=index,
            char_end=index + 1,
            plan_version=job.plan_version,
            voice_id="suzy",
        )
        for index in range(count)
    ]
    return manager, job, chunks


def test_job_completes_only_when_every_chunk_is_written():
    """Completion must not fire while chunks are still queued.

    The old check used `versioned_pending_chunks()`, which is empty for normal
    (non-reprocessed) jobs, so reaching the end of the text marked the job
    completed after the first chunk written afterwards.
    """
    manager, job, chunks = _job_with_chunks(3)
    job.planner_cursor.offset = -1

    manager.mark_chunk_written(chunks[2], duration_seconds=1.0, segment_path="a", wav_path="b")
    assert manager.get_job(job.id).status != JobStatus.COMPLETED

    manager.mark_chunk_written(chunks[0], duration_seconds=1.0, segment_path="a", wav_path="b")
    assert manager.get_job(job.id).status != JobStatus.COMPLETED

    manager.mark_chunk_written(chunks[1], duration_seconds=1.0, segment_path="a", wav_path="b")
    assert manager.get_job(job.id).status == JobStatus.COMPLETED


def test_mark_chunk_retry_requeues_and_counts_attempts():
    manager, job, chunks = _job_with_chunks(1)
    chunk = chunks[0]

    manager.mark_chunk_retry(chunk, "transient")

    assert chunk.status == ChunkStatus.PLANNED
    assert chunk.attempts == 1
    assert chunk.error == "transient"
    assert manager.get_job(job.id).status != JobStatus.FAILED


def test_mark_chunk_failed_leaves_the_job_alive():
    manager, job, chunks = _job_with_chunks(2)

    manager.mark_chunk_failed(chunks[0], "permanent")

    updated = manager.get_job(job.id)
    assert updated.chunks[0].status == ChunkStatus.FAILED
    assert updated.status != JobStatus.FAILED
    assert updated.has_unfinished_chunks() is True
