import pytest

from app.chunking.planner import ChunkPlan
from app.db.memory import MemoryDatabase
from app.jobs.manager import JobManager
from app.jobs.models import ChunkRecord, ChunkStatus, Job, JobStatus


def test_voice_switch_rebuilds_pending_chunks_in_place():
    """A voice change must requeue unrendered chunks, not orphan them.

    The old implementation flipped planned chunks to `STALE` and nothing ever
    re-planned them (the planner cursor only moves forward), so their text was
    silently dropped.
    """
    manager = JobManager(MemoryDatabase())
    job = manager.create_job(
        source_text="One. Two. Three.",
        source_kind="text",
        model_id="Qwen/Qwen3-TTS-12Hz-0.6B-Base",
        voice_id="suzy",
    )
    written = manager.add_planned_chunk(
        job.id,
        ChunkPlan(text="One.", char_start=0, char_end=4),
    )
    pending = manager.add_planned_chunk(
        job.id,
        ChunkPlan(text="Two.", char_start=5, char_end=9),
    )
    failed = manager.add_planned_chunk(
        job.id,
        ChunkPlan(text="Three.", char_start=10, char_end=16),
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
    manager = JobManager(MemoryDatabase())
    job = manager.create_job(
        source_text="One. Two.",
        source_kind="text",
        model_id="Qwen/Qwen3-TTS-12Hz-0.6B-Base",
        voice_id="suzy",
    )
    inflight = manager.add_planned_chunk(
        job.id,
        ChunkPlan(text="One.", char_start=0, char_end=4),
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
    manager = JobManager(MemoryDatabase())
    job = manager.create_job(
        source_text="One finished chunk.",
        source_kind="text",
        model_id="Qwen/Qwen3-TTS-12Hz-0.6B-Base",
        voice_id="suzy",
    )
    chunk = manager.add_planned_chunk(
        job.id,
        ChunkPlan(text="One finished chunk.", char_start=0, char_end=18),
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
    manager = JobManager(MemoryDatabase())
    job = manager.create_job(
        source_text="One. Two.",
        source_kind="text",
        model_id="Qwen/Qwen3-TTS-12Hz-0.6B-Base",
        voice_id="suzy",
    )
    inflight = manager.add_planned_chunk(
        job.id,
        ChunkPlan(text="One.", char_start=0, char_end=4),
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
        voice_id="suzy",
        parent_index=chunks[0].index,
    )

    planned = manager.add_planned_chunk(
        job.id,
        ChunkPlan(text="Next.", char_start=1, char_end=2),
    )

    assert planned.index == 1


def test_completed_jobs_ignore_playback_lifecycle_mutations():
    manager = JobManager(MemoryDatabase())
    job = manager.create_job(
        source_text="One finished chunk.",
        source_kind="text",
        model_id="Qwen/Qwen3-TTS-12Hz-0.6B-Base",
        voice_id="suzy",
    )
    chunk = manager.add_planned_chunk(
        job.id,
        ChunkPlan(text="One finished chunk.", char_start=0, char_end=18),
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
    assert manager.get_job(job.id).is_active_listening is True
    manager.pause_job(job.id)
    assert manager.get_job(job.id).is_active_listening is False
    manager.update_playback(job.id, current_time_seconds=2.5, is_playing=True)

    finished = manager.get_job(job.id)
    assert finished.status == JobStatus.COMPLETED
    assert finished.playback_state.current_time_seconds == 0.0
    assert finished.playback_state.is_playing is False
    # The listener is still tracked (folder warming), but the job stays
    # finished and its playback state is not reopened.
    assert finished.is_active_listening is True

    finished.playback_state.last_event_at = 0.0
    assert [job.id for job in manager.expire_stale_listeners(60)] == [job.id]
    expired = manager.get_job(job.id)
    assert expired.status == JobStatus.COMPLETED
    assert expired.is_active_listening is False


def test_create_job_stores_canonical_source_text():
    manager = JobManager(MemoryDatabase())

    job = manager.create_job(
        source_text="  First  line.\r\n\r\n\r\n\r\nSecond\tline.  ",
        source_kind="text",
        model_id="Qwen/Qwen3-TTS-12Hz-0.6B-Base",
        voice_id="suzy",
    )

    assert job.source_text == "First line.\n\nSecond line."


def _job_with_chunks(count: int) -> tuple[JobManager, Job, list[ChunkRecord]]:
    manager = JobManager(MemoryDatabase())
    job = manager.create_job(
        source_text="One. Two. Three.",
        source_kind="text",
        model_id="Qwen/Qwen3-TTS-12Hz-0.6B-Base",
        voice_id="suzy",
    )
    chunks = [
        manager.add_planned_chunk(
            job.id,
            ChunkPlan(text=f"Chunk {index}.", char_start=index, char_end=index + 1),
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


def test_pause_excludes_planned_chunks_from_dispatch_and_stays_paused():
    """Pause must actually stop rendering, including the plan-ahead window.

    A paused job always has planned chunks sitting there, so merely
    deprioritising it kept the GPU busy and the batch write then rewrote the
    status back to QUEUED — pause never held.
    """
    manager, job, chunks = _job_with_chunks(1)
    manager.pause_job(job.id)

    assert list(manager.renderable_chunks()) == []
    assert manager.has_renderable_chunks() is False

    manager.mark_chunk_rendering(chunks[0])
    manager.mark_chunk_written(
        chunks[0],
        duration_seconds=1.0,
        segment_path="/tmp/one.m4s",
        wav_path="/tmp/one.wav",
    )

    assert manager.get_job(job.id).status == JobStatus.PAUSED


def test_a_requeued_batch_does_not_leave_the_job_stuck_in_rendering():
    """`rendering` claims the GPU is working on the job.

    A failed batch — or one the worker shrank on an OOM — requeued its chunks
    but left the job status at RENDERING forever, because nothing reset it. The
    admin queue and the reader both read that status literally, which is how a
    long job could look busy all day while nothing was rendering.
    """
    manager, job, chunks = _job_with_chunks(2)
    manager.mark_chunk_rendering(chunks[0])
    assert manager.get_job(job.id).status == JobStatus.RENDERING

    manager.mark_chunk_retry(chunks[0], "ffmpeg exploded")
    assert manager.get_job(job.id).status == JobStatus.QUEUED

    manager.mark_chunk_rendering(chunks[0])
    manager.mark_chunk_planned(chunks[0])
    assert manager.get_job(job.id).status == JobStatus.QUEUED


def test_a_job_whose_last_chunk_fails_stops_reporting_rendering():
    manager, job, chunks = _job_with_chunks(1)
    job.planner_cursor.offset = -1
    manager.mark_chunk_rendering(chunks[0])

    manager.mark_chunk_failed(chunks[0], "permanent")

    updated = manager.get_job(job.id)
    assert updated.status == JobStatus.COMPLETED
    assert updated.chunks[0].status == ChunkStatus.FAILED


def test_settling_never_revives_a_paused_job():
    manager, job, chunks = _job_with_chunks(1)
    manager.pause_job(job.id)
    manager.mark_chunk_rendering(chunks[0])
    manager.mark_chunk_retry(chunks[0], "transient")

    assert manager.get_job(job.id).status == JobStatus.PAUSED


def test_settling_keeps_an_active_listener_playing():
    manager, job, chunks = _job_with_chunks(1)
    manager.activate_job(job.id)
    manager.mark_chunk_rendering(chunks[0])
    manager.mark_chunk_retry(chunks[0], "transient")

    assert manager.get_job(job.id).status == JobStatus.PLAYING


# ── Live takes vs. superseded takes ────────────────────────────────────
#
# A reprocess appends a second record for the same index and keeps the old one
# as history. Every derived quantity (counts, timeline, playable run, download)
# must follow the live take; counting history records used to double-count a
# re-rendered chunk, truncate the download at that index, and report more
# completed chunks than the job has.


def _job_with_three_written_chunks() -> tuple[JobManager, Job, list[ChunkRecord]]:
    manager = JobManager(MemoryDatabase())
    job = manager.create_job(
        source_text="One. Two. Three. Four.",
        source_kind="text",
        model_id="Qwen/Qwen3-TTS-12Hz-0.6B-Base",
        voice_id="suzy",
    )
    chunks = [
        manager.add_planned_chunk(
            job.id, ChunkPlan(text=f"Chunk {index}.", char_start=index, char_end=index + 1)
        )
        for index in range(3)
    ]
    for index, chunk in enumerate(chunks):
        manager.mark_chunk_written(
            chunk,
            duration_seconds=10.0,
            segment_path=f"/tmp/{index}.m4s",
            wav_path=f"/tmp/{index}.wav",
        )
    return manager, job, chunks


def test_reprocessing_a_chunk_keeps_derived_state_on_the_live_take():
    manager, job, chunks = _job_with_three_written_chunks()
    assert job.total_chunks_completed == 3
    assert job.contiguous_written_seconds == 30.0
    assert job.total_chunks_emitted == 3

    manager.add_versioned_chunk(
        job.id,
        text="Chunk 1 again.",
        char_start=1,
        char_end=2,
        voice_id="suzy",
        parent_index=1,
    )

    # The reprocessed index is pending again, so the playable run stops at it.
    assert job.total_chunks_emitted == 3
    assert len(job.chunks) == 4  # the old take is kept as history
    assert job.total_chunks_completed == 2
    assert job.contiguous_written_seconds == 10.0
    # Later written chunks are still placed on the timeline (zero-width gap).
    assert chunks[2].start_seconds == 10.0

    live = job.active_chunk(1)
    assert live is not None and live.version == 1
    manager.mark_chunk_written(
        live, duration_seconds=12.0, segment_path="/tmp/1v1.m4s", wav_path="/tmp/1v1.wav"
    )

    assert job.total_chunks_completed == 3
    assert job.contiguous_written_seconds == 32.0
    assert chunks[2].start_seconds == 22.0


def test_export_follows_the_live_take_and_is_not_truncated():
    """A reprocess used to export the rejected audio and stop there."""
    manager, job, _chunks = _job_with_three_written_chunks()

    manager.add_versioned_chunk(
        job.id,
        text="Chunk 1 again.",
        char_start=1,
        char_end=2,
        voice_id="suzy",
        parent_index=1,
    )
    live = job.active_chunk(1)
    assert live is not None
    manager.mark_chunk_written(
        live, duration_seconds=12.0, segment_path="/tmp/1v1.m4s", wav_path="/tmp/1v1.wav"
    )

    assert manager.exportable_wav_paths(job) == ["/tmp/0.wav", "/tmp/1v1.wav", "/tmp/2.wav"]


def test_switching_the_active_take_moves_the_export_and_the_timeline():
    manager, job, chunks = _job_with_three_written_chunks()
    manager.add_versioned_chunk(
        job.id,
        text="Chunk 1 again.",
        char_start=1,
        char_end=2,
        voice_id="suzy",
        parent_index=1,
    )
    live = job.active_chunk(1)
    assert live is not None
    manager.mark_chunk_written(
        live, duration_seconds=12.0, segment_path="/tmp/1v1.m4s", wav_path="/tmp/1v1.wav"
    )

    manager.set_active_chunk_version(job.id, 1, 0)

    # Exactly one live record per index, and the older, shorter take wins:
    # `chunks[1]` is version 0 and `live` is the re-rendered version 1.
    assert chunks[1].deprecated is False
    assert live.deprecated is True
    assert job.active_chunk_version == {0: 0, 1: 0, 2: 0}
    assert manager.exportable_wav_paths(job) == ["/tmp/0.wav", "/tmp/1.wav", "/tmp/2.wav"]
    assert job.contiguous_written_seconds == 30.0
    assert chunks[2].start_seconds == 20.0


def test_unknown_chunk_version_is_rejected():
    manager, job, _chunks = _job_with_three_written_chunks()

    with pytest.raises(KeyError):
        manager.set_active_chunk_version(job.id, 1, 99)

    # The rejected call must not have changed which take is live.
    assert job.active_chunk_version[1] == 0
    assert [chunk.deprecated for chunk in job.chunks] == [False, False, False]


def test_queue_depth_ignores_superseded_takes():
    manager, job, _chunks = _job_with_three_written_chunks()
    _pending = manager.add_planned_chunk(
        job.id, ChunkPlan(text="Pending.", char_start=3, char_end=4)
    )
    assert manager.queue_depth() == 1

    _marker = manager.add_versioned_chunk(
        job.id,
        text="Pending again.",
        char_start=3,
        char_end=4,
        voice_id="suzy",
        parent_index=3,
    )
    # One live pending chunk, not two records.
    assert manager.queue_depth() == 1


def test_buffered_seconds_use_the_playable_run_not_audio_after_a_gap():
    """Audio beyond an unwritten chunk is rendered, but not listenable."""
    manager = JobManager(MemoryDatabase())
    job = manager.create_job(
        source_text="One. Two. Three.",
        source_kind="text",
        model_id="Qwen/Qwen3-TTS-12Hz-0.6B-Base",
        voice_id="suzy",
    )
    chunks = [
        manager.add_planned_chunk(
            job.id, ChunkPlan(text=f"Chunk {index}.", char_start=index, char_end=index + 1)
        )
        for index in range(3)
    ]
    for chunk in (chunks[0], chunks[2]):
        manager.mark_chunk_written(
            chunk,
            duration_seconds=10.0,
            segment_path=f"/tmp/{chunk.index}.m4s",
            wav_path=f"/tmp/{chunk.index}.wav",
        )

    # 20s of audio exists, but only the first 10s play without a hole.
    assert job.contiguous_written_seconds == 10.0
    assert job.buffered_seconds == 10.0

    manager.update_playback(job.id, current_time_seconds=4.0, is_playing=True)
    assert job.buffered_seconds == 6.0


def test_switching_the_active_take_invalidates_the_buffered_stream():
    """The reader keys its media stream on `audio_epoch`.

    Without a bump, a session that already buffered the old take keeps playing
    it and the switch looks like a no-op.
    """
    manager, job, _chunks = _job_with_three_written_chunks()
    manager.add_versioned_chunk(
        job.id,
        text="Chunk 1 again.",
        char_start=1,
        char_end=2,
        voice_id="suzy",
        parent_index=1,
    )
    epoch_before = job.audio_epoch
    playhead_before = job.playback_state.current_time_seconds

    manager.set_active_chunk_version(job.id, 1, 0)

    assert job.audio_epoch == epoch_before + 1
    # A take swap is not a re-render: the listener keeps their position.
    assert job.playback_state.current_time_seconds == playhead_before


def test_reprocessing_a_missing_chunk_is_rejected_without_leaving_a_record():
    manager, job, _chunks = _job_with_three_written_chunks()
    before = len(job.chunks)

    with pytest.raises(KeyError):
        manager.add_versioned_chunk(
            job.id,
            text="Ghost take.",
            char_start=0,
            char_end=1,
            voice_id="suzy",
            parent_index=99,
        )

    assert len(job.chunks) == before
    assert 99 not in job.active_chunk_version


def test_trashing_a_job_still_allows_an_in_flight_batch_to_land():
    """Trash stops new work, but a batch already on the GPU may come back.

    Writing its audio keeps a restored job consistent. Purging removes the job,
    and the scheduler treats that KeyError as "drop the result".
    """
    from app.db.memory import MemoryDatabase
    from app.library.models import TrashKind
    from app.library.service import LibraryService
    from app.library.tree import LibraryItem

    database = MemoryDatabase()
    manager = JobManager(database)
    library = LibraryService(database)
    job = manager.create_job(
        source_text="One. Two.",
        source_kind="text",
        model_id="Qwen/Qwen3-TTS-12Hz-0.6B-Base",
        voice_id="suzy",
    )
    chunk = manager.add_planned_chunk(job.id, ChunkPlan(text="One.", char_start=0, char_end=4))
    manager.mark_chunk_rendering(chunk)

    entries = library.delete([LibraryItem(kind="job", id=job.id)])
    assert entries[0].kind == TrashKind.JOB

    updated = manager.mark_chunk_written(
        chunk, duration_seconds=1.0, segment_path="a", wav_path="b"
    )
    assert chunk.status == ChunkStatus.WRITTEN
    assert updated.id == job.id

    library.purge([entries[0].id])
    with pytest.raises(KeyError):
        manager.mark_chunk_written(chunk, duration_seconds=2.0, segment_path="c", wav_path="d")
