from app.jobs.manager import JobManager
from app.jobs.models import ChunkRecord, ChunkStatus, Job, JobStatus


def test_voice_switch_rebuilds_pending_chunks_in_place():
    """A voice change must requeue unrendered chunks, not orphan them.

    The old implementation flipped planned chunks to `STALE` and nothing ever
    re-planned them (the planner cursor only moves forward), so their text was
    silently dropped.
    """
    manager = JobManager()
    job = manager.create_job(
        source_text="One. Two. Three.",
        source_kind="text",
        model_id="Qwen/Qwen3-TTS-12Hz-0.6B-Base",
        voice_id="suzy",
    )
    written = manager.add_planned_chunk(
        job.id,
        text="One.",
        char_start=0,
        char_end=4,
        plan_version=job.plan_version,
        voice_id="suzy",
    )
    pending = manager.add_planned_chunk(
        job.id,
        text="Two.",
        char_start=5,
        char_end=9,
        plan_version=job.plan_version,
        voice_id="suzy",
    )
    failed = manager.add_planned_chunk(
        job.id,
        text="Three.",
        char_start=10,
        char_end=16,
        plan_version=job.plan_version,
        voice_id="suzy",
    )

    manager.mark_chunk_written(
        written, duration_seconds=1.0, segment_path="/tmp/0.m4s", wav_path="/tmp/0.wav"
    )
    failed.status = ChunkStatus.FAILED
    failed.attempts = 3
    failed.error = "boom"

    updated = manager.set_voice(job.id, "howard")

    assert updated.plan_version == 2
    assert updated.audio_epoch == 0
    # Already-rendered audio is untouched.
    assert written.status == ChunkStatus.WRITTEN
    assert written.voice_id == "suzy"
    assert written.segment_path == "/tmp/0.m4s"
    # Pending chunks are re-pointed at the new voice and back in the queue.
    assert pending.status == ChunkStatus.PLANNED
    assert pending.voice_id == "howard"
    assert pending.plan_version == 2
    # Failed chunks are retried with the new voice and a fresh attempt budget.
    assert failed.status == ChunkStatus.PLANNED
    assert failed.voice_id == "howard"
    assert failed.attempts == 0
    assert failed.error is None
    assert {id(chunk) for chunk in manager.renderable_chunks()} == {id(pending), id(failed)}


def test_partial_voice_switch_reactivates_a_completed_job_with_a_failed_gap():
    manager, job, chunks = _job_with_chunks(2)
    manager.mark_chunk_failed(chunks[1], "permanent")
    job.planner_cursor.offset = -1
    manager.mark_chunk_written(chunks[0], duration_seconds=1.0, segment_path="a", wav_path="b")
    assert manager.get_job(job.id).status == JobStatus.COMPLETED

    updated = manager.set_voice(job.id, "howard")

    # Re-queueing the failed chunk is real work, so the job must not stay
    # terminal (the reader stops watching completed jobs).
    assert updated.status == JobStatus.QUEUED
    assert chunks[1].status == ChunkStatus.PLANNED
    assert chunks[1].voice_id == "howard"


def test_voice_switch_leaves_a_job_with_nothing_to_rebuild_alone():
    manager, job, chunks = _job_with_chunks(1)
    job.planner_cursor.offset = -1
    manager.mark_chunk_written(chunks[0], duration_seconds=1.0, segment_path="a", wav_path="b")

    updated = manager.set_voice(job.id, "howard")

    assert updated.voice_id == "howard"
    assert updated.status == JobStatus.COMPLETED
    # The already-rendered chunk keeps its audio and voice.
    assert chunks[0].status == ChunkStatus.WRITTEN
    assert chunks[0].voice_id == "suzy"


def test_voice_switch_lets_the_in_flight_batch_finish_in_the_old_voice():
    manager = JobManager()
    job = manager.create_job(
        source_text="One. Two.",
        source_kind="text",
        model_id="Qwen/Qwen3-TTS-12Hz-0.6B-Base",
        voice_id="suzy",
    )
    inflight = manager.add_planned_chunk(
        job.id,
        text="One.",
        char_start=0,
        char_end=4,
        plan_version=job.plan_version,
        voice_id="suzy",
    )
    manager.mark_chunk_rendering(inflight)

    updated = manager.set_voice(job.id, "howard")

    assert inflight.status == ChunkStatus.RENDERING
    assert inflight.voice_id == "suzy"
    # Pinned to the current generation so it is written as-is, not requeued.
    assert inflight.plan_version == updated.plan_version

    manager.mark_chunk_written(
        inflight, duration_seconds=1.0, segment_path="/tmp/0.m4s", wav_path="/tmp/0.wav"
    )
    assert inflight.status == ChunkStatus.WRITTEN
    assert inflight.voice_id == "suzy"
    assert inflight.segment_path == "/tmp/0.m4s"


def test_full_rerender_invalidates_written_audio_and_bumps_audio_epoch():
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
    manager.mark_chunk_written(
        chunk, duration_seconds=3.0, segment_path="/tmp/0.m4s", wav_path="/tmp/0.wav"
    )
    job = manager.get_job(job.id)
    job.status = JobStatus.COMPLETED
    job.playback_state.current_time_seconds = 3.0
    job.playback_state.is_playing = True

    updated = manager.set_voice(job.id, "howard", rerender_written=True)

    assert updated.audio_epoch == 1
    assert updated.status == JobStatus.QUEUED
    assert chunk.status == ChunkStatus.PLANNED
    assert chunk.voice_id == "howard"
    assert chunk.segment_path is None
    assert chunk.wav_path is None
    assert chunk.duration_seconds == 0.0
    assert updated.total_chunks_completed == 0
    assert updated.playback_state.current_time_seconds == 0.0
    assert updated.playback_state.is_playing is False


def test_full_rerender_requeues_an_in_flight_chunk_with_the_new_voice():
    manager = JobManager()
    job = manager.create_job(
        source_text="One. Two.",
        source_kind="text",
        model_id="Qwen/Qwen3-TTS-12Hz-0.6B-Base",
        voice_id="suzy",
    )
    inflight = manager.add_planned_chunk(
        job.id,
        text="One.",
        char_start=0,
        char_end=4,
        plan_version=job.plan_version,
        voice_id="suzy",
    )
    manager.mark_chunk_rendering(inflight)

    manager.set_voice(job.id, "howard", rerender_written=True)
    # The worker returns the old-voice audio, which must be discarded.
    manager.mark_chunk_written(
        inflight, duration_seconds=1.0, segment_path="/tmp/0.m4s", wav_path="/tmp/0.wav"
    )

    assert inflight.status == ChunkStatus.PLANNED
    assert inflight.voice_id == "howard"
    assert inflight.segment_path is None
    assert manager.get_job(job.id).total_chunks_completed == 0


def test_planned_chunk_index_ignores_versioned_records():
    """`len(job.chunks)` overcounted after a reprocess and skipped numbers."""
    manager, job, chunks = _job_with_chunks(1)
    manager.add_versioned_chunk(
        job.id,
        text="Chunk 0.",
        char_start=0,
        char_end=1,
        plan_version=job.plan_version,
        voice_id="suzy",
        parent_index=chunks[0].index,
    )

    planned = manager.add_planned_chunk(
        job.id,
        text="Next.",
        char_start=1,
        char_end=2,
        plan_version=job.plan_version,
        voice_id="suzy",
    )

    assert planned.index == 1


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
