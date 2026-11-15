"""Pure listening-progress derivation.

The rules live here, not in the API or the React app:

- a chunk is heard only via real playback (the client decides that, the server
  stores it keyed by the chunk version that was heard);
- job progress is `(highest heard chunk + 1) / emitted chunks`, so the bar can
  never claim more than the ✓ marks show;
- a job is read once it is fully produced and its **last playable** chunk has
  been heard. Failed or still-missing chunks never block completion.

Every function here takes a `ProgressSource`, which both `Job` (the aggregate)
and `JobSummary` (the flat read model) satisfy. That is what lets a library read
derive progress without loading a single chunk.
"""

from __future__ import annotations

from collections.abc import Iterable
from dataclasses import dataclass
from typing import Literal

from app.jobs.models import ChunkStatus, Job, JobSummary
from app.library.models import JobProgress

ReadStatus = Literal["unread", "in_progress", "read"]

# Derived progress reads one job's facts and never needs its chunks, so these
# helpers accept either the aggregate or the flat summary. A union rather than a
# protocol because `JobSummary` is frozen (a mutable protocol member would not
# accept it) and both shapes are concrete and local.
ProgressSource = Job | JobSummary


@dataclass(frozen=True, slots=True)
class ProgressView:
    """Everything a client needs to render one job's listening state."""

    fraction: float
    read_status: ReadStatus
    heard_chunks: tuple[int, ...]
    remaining_seconds: float
    position_seconds: float = 0.0


def valid_heard(source: ProgressSource, progress: JobProgress | None) -> set[int]:
    """Heard chunk indexes that still describe the job's current audio.

    `audio_epoch` invalidates every mark after a full re-render, and the stored
    version invalidates a single reprocessed chunk. Nothing else has to write
    invalidation state.
    """
    if progress is None or progress.audio_epoch != source.audio_epoch:
        return set()
    heard: set[int] = set()
    for index, version in progress.heard.items():
        if source.active_chunk_version.get(index) == version:
            heard.add(index)
    return heard


def heard_seconds(job: Job, progress: JobProgress | None) -> float:
    """Duration of the heard takes that are still valid.

    This is the stored half of the remaining-audio estimate. It takes the
    aggregate because only the aggregate knows chunk durations; it is therefore
    a *writer* helper (`ProgressService` and the chunk-write path), never part of
    a list read.
    """
    heard = valid_heard(job, progress)
    if not heard:
        return 0.0
    return sum(
        chunk.duration_seconds
        for chunk in job.active_chunks()
        if chunk.index in heard and chunk.status == ChunkStatus.WRITTEN
    )


def last_playable_index(source: ProgressSource) -> int | None:
    """Highest live chunk index that actually has audio, or None."""
    return source.last_written_index


def is_fully_produced(source: ProgressSource) -> bool:
    """Planning is done and nothing is queued, rendering or reprocessing."""
    return source.planner_cursor.exhausted and source.unfinished_chunks == 0


def read_status(
    source: ProgressSource, heard: Iterable[int], position_seconds: float
) -> ReadStatus:
    """Classify a job from its heard set.

    Read deliberately ignores missing middle chunks: a listener who skims a
    boring section still finished the book, so only the last playable chunk
    matters. `is_fully_produced` keeps a job from being "read" while more audio
    is still coming, which would otherwise flip back to in-progress when the
    renderer caught up.
    """
    heard_set = set(heard)
    last = last_playable_index(source)
    if is_fully_produced(source) and last is not None and last in heard_set:
        return "read"
    if not heard_set and position_seconds <= 0:
        return "unread"
    return "in_progress"


def progress_fraction(source: ProgressSource, heard: Iterable[int]) -> float:
    """`(highest heard index + 1) / emitted chunks`, clamped to [0, 1]."""
    emitted = source.next_chunk_index
    if emitted <= 0:
        return 0.0
    highest = max(set(heard), default=-1)
    if highest < 0:
        return 0.0
    return min(1.0, (highest + 1) / emitted)


def remaining_seconds(
    source: ProgressSource, heard_seconds: float, *, chars_per_second: float
) -> float:
    """Audio still unheard, including text the planner has not reached yet.

    Numerically identical to summing the un-heard chunks one by one, but it uses
    only stored rollups: rendered seconds the listener has not heard, plus the
    estimated cost of every unwritten take and of the unplanned tail.

    `heard_seconds` is the duration of the valid heard marks (from the progress
    row), which is what makes the subtraction exact instead of an estimate.
    """
    cursor = source.planner_cursor
    unplanned = 0 if cursor.exhausted else max(0, source.source_char_count - cursor.offset)
    return max(
        0.0,
        source.written_seconds
        + (source.unwritten_chars + unplanned) / chars_per_second
        - heard_seconds,
    )


def progress_view(
    source: ProgressSource,
    progress: JobProgress | None,
    *,
    estimated_chars_per_second: float,
) -> ProgressView:
    heard = valid_heard(source, progress)
    position = progress.position_seconds if progress is not None else 0.0
    heard_duration = progress.heard_seconds if progress is not None else 0.0
    return ProgressView(
        fraction=progress_fraction(source, heard),
        read_status=read_status(source, heard, position),
        heard_chunks=tuple(sorted(heard)),
        remaining_seconds=remaining_seconds(
            source, heard_duration, chars_per_second=estimated_chars_per_second
        ),
        position_seconds=position,
    )


def aggregate_fraction(jobs: Iterable[ProgressSource], views: dict[str, ProgressView]) -> float:
    """Chunk-weighted progress for a folder (recursive jobs included).

    Job progress is `(highest heard + 1) / emitted`, so summing the numerators
    and denominators gives a stable folder bar that moves as each job advances.
    """
    numerator = 0.0
    denominator = 0
    for job in jobs:
        if job.next_chunk_index <= 0:
            continue
        view = views.get(job.id)
        # The view's fraction is the max-heard rule; recover the numerator from
        # the same rule instead of the heard count.
        if view is not None and view.heard_chunks:
            numerator += min(job.next_chunk_index, max(view.heard_chunks) + 1)
        denominator += job.next_chunk_index
    if denominator == 0:
        return 0.0
    return min(1.0, numerator / denominator)
