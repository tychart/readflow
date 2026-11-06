from __future__ import annotations

from collections.abc import Iterable

from app.jobs.models import ChunkStatus
from app.library.models import JobProgress
from app.library.progress import (
    aggregate_fraction,
    estimated_remaining_seconds,
    last_playable_index,
    progress_fraction,
    progress_view,
    read_status,
    valid_heard,
)
from tests.unit.library_helpers import build_chunk, build_job, layout


def _progress(job, heard: Iterable[int] | None = None, *, position: float = 0.0):
    return JobProgress(
        user_id="local",
        job_id=job.id,
        position_seconds=position,
        audio_epoch=job.audio_epoch,
        heard={index: job.active_chunk_version[index] for index in (heard or [])},
    )


def _three_chunks():
    chunks = [build_chunk("job", index) for index in range(3)]
    layout(chunks)
    return build_job("job", chunks)


def test_valid_heard_requires_the_active_version_and_epoch():
    job = _three_chunks()
    heard = _progress(job, {0, 1, 2})
    heard.heard[1] = 1

    # Chunk 1 is at version 0, so the version-1 mark does not count.
    assert valid_heard(job, heard) == {0, 2}

    job.active_chunk_version[2] = 4
    assert valid_heard(job, heard) == {0}

    job.audio_epoch = 3
    assert valid_heard(job, heard) == set()

    assert valid_heard(job, None) == set()


def test_progress_fraction_uses_the_highest_heard_chunk():
    job = _three_chunks()
    assert progress_fraction(job, set()) == 0.0
    assert progress_fraction(job, {0}) == 1 / 3
    assert progress_fraction(job, {0, 2}) == 1.0
    # A sparse heard set still reports the furthest chunk.
    assert progress_fraction(job, {1}) == 2 / 3


def test_progress_fraction_is_zero_before_any_chunk_is_emitted():
    job = build_job("empty", [])
    assert progress_fraction(job, {0, 1}) == 0.0


def test_read_when_the_last_playable_chunk_is_heard():
    job = _three_chunks()
    assert read_status(job, {0, 1}, position_seconds=20.0) == "in_progress"
    assert read_status(job, {0, 1, 2}, position_seconds=20.0) == "read"


def test_missing_middle_chunks_never_block_completion():
    job = _three_chunks()
    # Skipped chunk 1 entirely, but heard the last one.
    assert read_status(job, {0, 2}, position_seconds=20.0) == "read"


def test_a_failed_last_chunk_falls_back_to_the_last_audio():
    chunks = [
        build_chunk("job", 0),
        build_chunk("job", 1),
        build_chunk("job", 2, status=ChunkStatus.FAILED),
    ]
    layout(chunks)
    job = build_job("job", chunks)
    assert last_playable_index(job) == 1
    assert read_status(job, {0, 1}, position_seconds=20.0) == "read"
    assert read_status(job, {0}, position_seconds=10.0) == "in_progress"


def test_a_job_still_producing_is_never_read():
    chunks = [build_chunk("job", 0)]
    layout(chunks)
    job = build_job("job", chunks, planner_exhausted=False)
    # Even with the only playable chunk heard, more text is still coming.
    assert read_status(job, {0}, position_seconds=10.0) == "in_progress"


def test_unread_requires_no_mark_and_no_position():
    job = _three_chunks()
    assert read_status(job, set(), position_seconds=0.0) == "unread"
    assert read_status(job, set(), position_seconds=0.1) == "in_progress"


def test_remaining_seconds_counts_written_planned_and_unplanned_text():
    chunks = [
        build_chunk("job", 0, duration=10.0),
        build_chunk("job", 1, duration=20.0, status=ChunkStatus.PLANNED, text="x" * 180),
    ]
    layout(chunks)
    job = build_job("job", chunks, planner_exhausted=False)
    job.source_text = "x" * 360
    job.planner_cursor.offset = 180

    # Chunk 0 heard; chunk 1 estimated at 180/18 = 10s; remaining text 180/18.
    assert estimated_remaining_seconds(job, {0}, estimated_chars_per_second=18.0) == 20.0


def test_progress_view_collects_everything_the_client_needs():
    job = _three_chunks()
    view = progress_view(
        job, _progress(job, {0, 2}, position=12.5), estimated_chars_per_second=18.0
    )
    assert view.fraction == 1.0
    assert view.read_status == "read"
    assert view.heard_chunks == (0, 2)
    assert view.position_seconds == 12.5


def test_aggregate_fraction_is_chunk_weighted():
    first = _three_chunks()
    second = build_job("second", [build_chunk("second", 0)])
    views = {
        first.id: progress_view(first, _progress(first, {0}), estimated_chars_per_second=18.0),
        second.id: progress_view(second, _progress(second, {0}), estimated_chars_per_second=18.0),
    }
    # 1 of 3 heard + 1 of 1 heard = 2/4.
    assert aggregate_fraction([first, second], views) == 0.5
