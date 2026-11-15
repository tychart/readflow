"""The remaining-audio estimate is now rollup-only; it must not change value.

`remaining_seconds` used to sum every un-heard chunk. It now works from stored
totals (`written_seconds`, `unwritten_chars`, `heard_seconds`, the planner
cursor and `source_char_count`) so a progress view never loads a chunk. Those are
two different implementations of one number, so this file keeps the old one as a
reference and asserts they agree on a fixture with a gap, a reprocessed take, a
take switch, a failed chunk and unplanned tail text.
"""

from __future__ import annotations

from collections.abc import Iterable

import pytest

from app.db.memory import MemoryDatabase
from app.jobs.manager import JobManager
from app.jobs.models import ChunkStatus, Job
from app.library.models import JobProgress
from app.library.progress import heard_seconds, remaining_seconds, valid_heard
from tests.unit.library_helpers import ChunkPlan, build_messy_job

CHARS_PER_SECOND = 18.0


def _legacy_remaining_seconds(job: Job, heard: Iterable[int], *, chars_per_second: float) -> float:
    """The pre-rollup implementation, kept verbatim as the reference."""
    heard_set = set(heard)
    remaining = 0.0
    for chunk in job.active_chunks():
        if chunk.index in heard_set:
            continue
        if chunk.status == ChunkStatus.WRITTEN:
            remaining += chunk.duration_seconds
        else:
            remaining += len(chunk.text) / chars_per_second
    if not job.planner_cursor.exhausted and job.planner_cursor.offset >= 0:
        unplanned_chars = max(0, job.source_char_count - job.planner_cursor.offset)
        remaining += unplanned_chars / chars_per_second
    return remaining


def _progress(job: Job, heard: Iterable[int]) -> JobProgress:
    row = JobProgress(
        user_id="local",
        job_id=job.id,
        audio_epoch=job.audio_epoch,
        heard={
            index: job.active_chunk_version[index]
            for index in heard
            if index in job.active_chunk_version
        },
    )
    row.heard_seconds = heard_seconds(job, row)
    return row


async def test_new_formula_equals_the_legacy_sum_on_a_messy_job() -> None:
    manager = JobManager(MemoryDatabase())
    job = await build_messy_job(manager)

    # Only written takes can be heard through playback, so those are the states
    # the old and new formulas must agree on.
    for heard in (set(), {0}, {0, 1}):
        row = _progress(job, heard)
        expected = _legacy_remaining_seconds(
            job, valid_heard(job, row), chars_per_second=CHARS_PER_SECOND
        )
        assert remaining_seconds(
            job, row.heard_seconds, chars_per_second=CHARS_PER_SECOND
        ) == pytest.approx(expected), heard


async def test_a_heard_mark_on_unrendered_text_does_not_hide_its_cost() -> None:
    """Deliberate difference from the old sum.

    A chunk that is still `PLANNED` has no audio, so hearing it is impossible;
    the mark can only come from a manual "mark read" on a job that is still
    rendering. The old formula dropped that text from the estimate entirely,
    which made the remaining time jump *up* when the chunk finally rendered. The
    rollup formula keeps it, so the number only ever shrinks as audio arrives.
    """
    manager = JobManager(MemoryDatabase())
    job = await build_messy_job(manager)
    row = _progress(job, {3})
    assert 3 in valid_heard(job, row)

    legacy = _legacy_remaining_seconds(job, {3}, chars_per_second=CHARS_PER_SECOND)
    current = remaining_seconds(job, row.heard_seconds, chars_per_second=CHARS_PER_SECOND)

    assert current > legacy
    third = job.active_chunk(3)
    assert third is not None
    assert current - legacy == pytest.approx(len(third.text) / CHARS_PER_SECOND)


async def test_new_formula_equals_the_legacy_sum_with_unplanned_text() -> None:
    manager = JobManager(MemoryDatabase())
    job = await manager.create_job(
        source_text="alpha beta gamma delta epsilon zeta eta theta iota kappa",
        source_kind="text",
        model_id="Qwen/Qwen3-TTS-12Hz-0.6B-Base",
        voice_id="suzy",
    )
    first = await manager.add_planned_chunk(
        job.id, ChunkPlan(text="alpha beta", char_start=0, char_end=10)
    )
    await manager.mark_chunk_written(
        first, duration_seconds=12.0, segment_path="/tmp/0.m4s", wav_path="/tmp/0.wav"
    )
    second = await manager.add_planned_chunk(
        job.id, ChunkPlan(text="gamma delta", char_start=10, char_end=21)
    )
    assert second.status == ChunkStatus.PLANNED

    for heard in (set(), {0}):
        row = _progress(job, heard)
        expected = _legacy_remaining_seconds(
            job, valid_heard(job, row), chars_per_second=CHARS_PER_SECOND
        )
        assert (
            remaining_seconds(job, row.heard_seconds, chars_per_second=CHARS_PER_SECOND) == expected
        )


async def test_appending_audio_never_increases_the_estimate() -> None:
    """Rendering more text must monotonically reduce what is left to hear.

    Each chunk's real duration is shorter than its character estimate (as real
    TTS audio is), which is the case where turning an estimate into a
    measurement can only lower the total.
    """
    chunk_chars = 180
    manager = JobManager(MemoryDatabase())
    job = await manager.create_job(
        source_text="x" * (chunk_chars * 4),
        source_kind="text",
        model_id="Qwen/Qwen3-TTS-12Hz-0.6B-Base",
        voice_id="suzy",
    )
    estimates = []
    for index in range(4):
        chunk = await manager.add_planned_chunk(
            job.id,
            ChunkPlan(
                text="x" * chunk_chars,
                char_start=index * chunk_chars,
                char_end=(index + 1) * chunk_chars,
            ),
        )
        estimates.append(remaining_seconds(job, 0.0, chars_per_second=CHARS_PER_SECOND))
        await manager.mark_chunk_written(
            chunk,
            duration_seconds=6.0,
            segment_path=f"/tmp/{index}.m4s",
            wav_path=f"/tmp/{index}.wav",
        )
        estimates.append(remaining_seconds(job, 0.0, chars_per_second=CHARS_PER_SECOND))

    assert estimates == sorted(estimates, reverse=True)


async def test_heard_audio_is_subtracted_exactly() -> None:
    manager = JobManager(MemoryDatabase())
    job = await manager.create_job(
        source_text="alpha beta gamma",
        source_kind="text",
        model_id="Qwen/Qwen3-TTS-12Hz-0.6B-Base",
        voice_id="suzy",
    )
    chunk = await manager.add_planned_chunk(
        job.id, ChunkPlan(text="alpha beta", char_start=0, char_end=10)
    )
    await manager.mark_chunk_written(
        chunk, duration_seconds=20.0, segment_path="/tmp/0.m4s", wav_path="/tmp/0.wav"
    )

    assert remaining_seconds(job, 0.0, chars_per_second=CHARS_PER_SECOND) == pytest.approx(
        20.0 + 6 / 18
    )
    assert remaining_seconds(job, 20.0, chars_per_second=CHARS_PER_SECOND) == pytest.approx(6 / 18)
    # Listening past the end of the audio cannot make it negative.
    assert remaining_seconds(job, 999.0, chars_per_second=CHARS_PER_SECOND) == 0.0
