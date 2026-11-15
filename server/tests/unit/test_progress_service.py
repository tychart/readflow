from __future__ import annotations

import pytest

from app.chunking.planner import ChunkPlan
from app.db.memory import MemoryDatabase
from app.jobs.manager import JobManager
from app.library.progress_service import ProgressService


def _setup():
    database = MemoryDatabase()
    manager = JobManager(database)
    progress = ProgressService(database, estimated_chars_per_second=18.0)
    return database, manager, progress


def _written_job(manager: JobManager, *, durations: tuple[float, ...] = (10.0, 10.0, 10.0)):
    job = manager.create_job(
        source_text="aaaa bbbb cccc dddd",
        source_kind="text",
        model_id="Qwen/Qwen3-TTS-12Hz-0.6B-Base",
        voice_id="suzy",
        title="Three chunks",
    )
    for index, duration in enumerate(durations):
        start = index * 5
        chunk = manager.add_planned_chunk(
            job.id, ChunkPlan(text=f"chunk {index} text", char_start=start, char_end=start + 5)
        )
        manager.mark_chunk_written(
            chunk,
            duration_seconds=duration,
            segment_path=f"/tmp/{index}.m4s",
            wav_path=f"/tmp/{index}.wav",
        )
    manager.finish_planning(job.id)
    return manager.get_job(job.id)


def test_record_persists_position_and_heard_versions():
    database, manager, progress = _setup()
    job = _written_job(manager)

    returned_job, row = progress.record(job.id, position_seconds=12.5, heard_chunk_indexes=[0, 1])

    assert row.position_seconds == 12.5
    assert row.heard == {0: 0, 1: 0}
    assert returned_job.id == job.id
    with database.transaction() as uow:
        stored = uow.progress.get("local", job.id)
    assert stored is not None and stored.position_seconds == 12.5


def test_record_is_additive_and_ignores_unknown_chunks():
    _, manager, progress = _setup()
    job = _written_job(manager)

    progress.record(job.id, position_seconds=5.0, heard_chunk_indexes=[0])
    _, row = progress.record(job.id, position_seconds=15.0, heard_chunk_indexes=[2, 99])

    assert row.heard == {0: 0, 2: 0}
    assert row.position_seconds == 15.0


def test_record_clamps_negative_positions():
    _, manager, progress = _setup()
    job = _written_job(manager)
    _, row = progress.record(job.id, position_seconds=-4.0)
    assert row.position_seconds == 0.0


def test_record_clears_heard_marks_after_a_full_rerender():
    _, manager, progress = _setup()
    job = _written_job(manager)
    progress.record(job.id, position_seconds=30.0, heard_chunk_indexes=[0, 1, 2])

    # A full re-render bumps audio_epoch and invalidates the old take.
    job = manager.set_voice(job.id, "howard", rerender_written=True)
    assert job.audio_epoch == 1

    _, row = progress.record(job.id, position_seconds=1.0, heard_chunk_indexes=[0])
    assert row.heard == {0: 0}
    assert row.audio_epoch == 1


def test_mark_job_read_marks_every_chunk_and_moves_to_the_end():
    _, manager, progress = _setup()
    job = _written_job(manager)

    updated, row = progress.mark_job(job.id, read=True)

    assert row.heard == {0: 0, 1: 0, 2: 0}
    assert row.position_seconds == 30.0
    view = progress.view(updated)
    assert view.read_status == "read"
    assert view.fraction == 1.0
    assert view.heard_chunks == (0, 1, 2)


def test_mark_job_unread_clears_everything():
    _, manager, progress = _setup()
    job = _written_job(manager)
    progress.mark_job(job.id, read=True)

    updated, row = progress.mark_job(job.id, read=False)

    assert row.heard == {}
    assert row.position_seconds == 0.0
    assert progress.view(updated).read_status == "unread"


def test_mark_unread_from_a_chunk_clears_the_tail_and_rewinds_position():
    _, manager, progress = _setup()
    job = _written_job(manager)
    progress.mark_job(job.id, read=True)

    _, row = progress.mark_job(job.id, read=False, from_chunk=1)

    assert row.heard == {0: 0}
    # Chunk 1 starts at 10s; the position is clamped there, not left at 30s.
    assert row.position_seconds == 10.0


def test_mark_read_from_a_chunk_keeps_earlier_progress():
    _, manager, progress = _setup()
    job = _written_job(manager)

    _, row = progress.mark_job(job.id, read=True, from_chunk=1)

    assert row.heard == {1: 0, 2: 0}
    assert row.position_seconds == 0.0


def test_mark_from_an_unknown_chunk_is_rejected():
    _, manager, progress = _setup()
    job = _written_job(manager)
    with pytest.raises(KeyError):
        progress.mark_job(job.id, read=True, from_chunk=99)


def test_mark_single_chunk_heard_and_unheard():
    _, manager, progress = _setup()
    job = _written_job(manager)

    _, row = progress.mark_chunk(job.id, 1, heard=True)
    assert row.heard == {1: 0}
    _, row = progress.mark_chunk(job.id, 1, heard=False)
    assert row.heard == {}

    with pytest.raises(KeyError):
        progress.mark_chunk(job.id, 42, heard=True)


def test_mark_many_opens_one_transaction_for_a_selection():
    database, manager, progress = _setup()
    first = _written_job(manager)
    second = _written_job(manager)

    progress.mark_many([first.id, second.id], read=True)

    with database.transaction() as uow:
        rows = uow.progress.list("local")
    assert len(rows) == 2
    assert all(row.heard for row in rows)


def test_views_batches_the_rows_for_the_library():
    _, manager, progress = _setup()
    first = _written_job(manager)
    second = _written_job(manager)
    progress.mark_job(first.id, read=True)

    views = progress.views(manager.list_jobs())

    assert views[first.id].read_status == "read"
    assert views[second.id].read_status == "unread"


def test_unknown_job_is_rejected():
    _, _, progress = _setup()
    with pytest.raises(KeyError):
        progress.record("missing", position_seconds=1.0)


def test_mark_many_validates_every_job_before_marking(services=None):
    database, manager, progress = _setup()
    job = _written_job(manager)

    with pytest.raises(KeyError):
        progress.mark_many([job.id, "missing"], read=True)

    with database.transaction() as uow:
        row = uow.progress.get("local", job.id)
    assert row is None or row.heard == {}


def _unfinished_job(manager: JobManager):
    """Three rendered chunks, planning still open (so the job is not terminal)."""
    job = manager.create_job(
        source_text="aaaa bbbb cccc dddd eeee",
        source_kind="text",
        model_id="Qwen/Qwen3-TTS-12Hz-0.6B-Base",
        voice_id="suzy",
    )
    for index in range(3):
        chunk = manager.add_planned_chunk(
            job.id,
            ChunkPlan(text=f"chunk {index} text", char_start=index * 5, char_end=index * 5 + 5),
        )
        manager.mark_chunk_written(
            chunk,
            duration_seconds=10.0,
            segment_path=f"/tmp/{index}.m4s",
            wav_path=f"/tmp/{index}.wav",
        )
    return manager.get_job(job.id)


def test_record_folds_the_position_into_the_job_in_the_same_transaction():
    """`record` is the single playback command: job and progress move together."""
    database, manager, progress = _setup()
    job = _unfinished_job(manager)

    updated, _row = progress.record(job.id, position_seconds=12.5, is_playing=True)

    assert updated.playback_state.current_time_seconds == 12.5
    assert updated.playback_state.is_playing is True
    assert updated.is_active_listening is True
    assert updated.status.value == "playing"
    # The buffer is job-timeline seconds: 30s rendered, 12.5s consumed.
    assert updated.buffered_seconds == 17.5
    with database.transaction() as uow:
        stored = uow.jobs.get("local", job.id)
        assert stored is not None
        assert stored.playback_state.current_time_seconds == 12.5


def test_record_freezes_a_finished_jobs_position_but_tracks_the_listener():
    _, manager, progress = _setup()
    job = _written_job(manager)
    manager.finish_planning(job.id)
    finished = manager.get_job(job.id)
    assert finished.status.value == "completed"

    updated, _row = progress.record(job.id, position_seconds=25.0, is_playing=True)

    assert updated.status.value == "completed"
    assert updated.playback_state.current_time_seconds == 0.0
    # Folder warming still needs to know someone is listening.
    assert updated.is_active_listening is True


def test_heard_seconds_tracks_the_marks_and_their_durations():
    _, manager, progress = _setup()
    job = _written_job(manager, durations=(10.0, 20.0, 30.0))

    _, row = progress.record(job.id, position_seconds=1.0, heard_chunk_indexes=[0, 1])
    assert row.heard_seconds == 30.0

    _, row = progress.record(job.id, position_seconds=2.0, heard_chunk_indexes=[2])
    assert row.heard_seconds == 60.0

    _, row = progress.mark_chunk(job.id, 1, heard=False)
    assert row.heard_seconds == 40.0


def test_heard_seconds_survives_a_rerender_and_a_new_take():
    _, manager, progress = _setup()
    job = _written_job(manager, durations=(10.0, 20.0, 30.0))
    progress.record(job.id, position_seconds=1.0, heard_chunk_indexes=[0, 1, 2])

    # A full re-render clears the audio, so no mark describes it any more.
    job = manager.set_voice(job.id, "howard", rerender_written=True)
    _, row = progress.record(job.id, position_seconds=0.0)
    assert row.heard == {}
    assert row.heard_seconds == 0.0


def test_heard_seconds_is_recomputed_when_a_chunk_is_rerendered():
    database, manager, progress = _setup()
    job = _written_job(manager, durations=(10.0, 20.0, 30.0))
    progress.record(job.id, position_seconds=1.0, heard_chunk_indexes=[1])

    # Reprocessing chunk 1 appends a new take; until it is written, the old
    # heard mark no longer describes audible audio.
    manager.add_versioned_chunk(
        job.id,
        text="chunk 1 again",
        char_start=5,
        char_end=10,
        voice_id="suzy",
        parent_index=1,
    )
    with database.transaction() as uow:
        row = uow.progress.get("local", job.id)
    assert row is not None and row.heard_seconds == 0.0

    chunk = manager.get_job(job.id).active_chunk(1)
    assert chunk is not None
    manager.mark_chunk_written(
        chunk,
        duration_seconds=25.0,
        segment_path="/tmp/1_v1.m4s",
        wav_path="/tmp/1_v1.wav",
    )
    with database.transaction() as uow:
        row = uow.progress.get("local", job.id)
    assert row is not None and row.heard_seconds == 0.0


def test_record_writes_each_row_once(monkeypatch):
    """A fresh progress row is `add`ed, an existing one `save`d — never both."""
    from app.db.memory import MemoryProgressRepository

    _, manager, progress = _setup()
    job = _written_job(manager)
    writes: list[str] = []
    original_add = MemoryProgressRepository.add
    original_save = MemoryProgressRepository.save

    def recording_add(self, row):
        writes.append("add")
        original_add(self, row)

    def recording_save(self, row):
        writes.append("save")
        original_save(self, row)

    monkeypatch.setattr(MemoryProgressRepository, "add", recording_add)
    monkeypatch.setattr(MemoryProgressRepository, "save", recording_save)

    progress.record(job.id, position_seconds=1.0)
    assert writes == ["add"]

    writes.clear()
    progress.record(job.id, position_seconds=2.0)
    assert writes == ["save"]
