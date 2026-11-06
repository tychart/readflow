"""Pure listening-progress derivation.

The rules live here, not in the API or the React app:

- a chunk is heard only via real playback (the client decides that, the server
  stores it keyed by the chunk version that was heard);
- job progress is `(highest heard chunk + 1) / emitted chunks`, so the bar can
  never claim more than the ✓ marks show;
- a job is read once it is fully produced and its **last playable** chunk has
  been heard. Failed or still-missing chunks never block completion.
"""

from __future__ import annotations

from collections.abc import Iterable
from dataclasses import dataclass
from typing import Literal

from app.jobs.models import ChunkRecord, ChunkStatus, Job
from app.library.models import JobProgress

ReadStatus = Literal["unread", "in_progress", "read"]


@dataclass(frozen=True, slots=True)
class ProgressView:
    """Everything a client needs to render one job's listening state."""

    fraction: float
    read_status: ReadStatus
    heard_chunks: tuple[int, ...]
    remaining_seconds: float
    position_seconds: float = 0.0


def live_chunks(job: Job) -> list[ChunkRecord]:
    return job.active_chunks()


def valid_heard(job: Job, progress: JobProgress | None) -> set[int]:
    """Heard chunk indexes that still describe the job's current audio.

    `audio_epoch` invalidates every mark after a full re-render, and the stored
    version invalidates a single reprocessed chunk. Nothing else has to write
    invalidation state.
    """
    if progress is None or progress.audio_epoch != job.audio_epoch:
        return set()
    heard: set[int] = set()
    for index, version in progress.heard.items():
        if job.active_chunk_version.get(index) == version:
            heard.add(index)
    return heard


def last_playable_index(job: Job) -> int | None:
    """Highest live chunk index that actually has audio, or None."""
    written = [chunk.index for chunk in live_chunks(job) if chunk.status == ChunkStatus.WRITTEN]
    return max(written, default=None)


def is_fully_produced(job: Job) -> bool:
    """Planning is done and nothing is queued, rendering or reprocessing."""
    return job.planner_cursor.exhausted and not job.has_unfinished_chunks()


def read_status(job: Job, heard: Iterable[int], position_seconds: float) -> ReadStatus:
    """Classify a job from its heard set.

    Read deliberately ignores missing middle chunks: a listener who skims a
    boring section still finished the book, so only the last playable chunk
    matters. `is_fully_produced` keeps a job from being "read" while more audio
    is still coming, which would otherwise flip back to in-progress when the
    renderer caught up.
    """
    heard_set = set(heard)
    last = last_playable_index(job)
    if is_fully_produced(job) and last is not None and last in heard_set:
        return "read"
    if not heard_set and position_seconds <= 0:
        return "unread"
    return "in_progress"


def progress_fraction(job: Job, heard: Iterable[int]) -> float:
    """`(highest heard index + 1) / emitted chunks`, clamped to [0, 1]."""
    emitted = job.next_chunk_index
    if emitted <= 0:
        return 0.0
    highest = max(set(heard), default=-1)
    if highest < 0:
        return 0.0
    return min(1.0, (highest + 1) / emitted)


def estimated_remaining_seconds(
    job: Job, heard: Iterable[int], *, estimated_chars_per_second: float
) -> float:
    """Audio still unheard, including text the planner has not reached yet."""
    heard_set = set(heard)
    remaining = 0.0
    for chunk in live_chunks(job):
        if chunk.index in heard_set:
            continue
        if chunk.status == ChunkStatus.WRITTEN:
            remaining += chunk.duration_seconds
        else:
            remaining += len(chunk.text) / estimated_chars_per_second
    if not job.planner_cursor.exhausted and job.planner_cursor.offset >= 0:
        unplanned_chars = max(0, len(job.source_text) - job.planner_cursor.offset)
        remaining += unplanned_chars / estimated_chars_per_second
    return remaining


def progress_view(
    job: Job,
    progress: JobProgress | None,
    *,
    estimated_chars_per_second: float,
) -> ProgressView:
    heard = valid_heard(job, progress)
    position = progress.position_seconds if progress is not None else 0.0
    return ProgressView(
        fraction=progress_fraction(job, heard),
        read_status=read_status(job, heard, position),
        heard_chunks=tuple(sorted(heard)),
        remaining_seconds=estimated_remaining_seconds(
            job, heard, estimated_chars_per_second=estimated_chars_per_second
        ),
        position_seconds=position,
    )


def aggregate_fraction(jobs: Iterable[Job], views: dict[str, ProgressView]) -> float:
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


def heard_indexes_for_job(job: Job) -> set[int]:
    """Every live chunk index (used by mark-read / mark-unread)."""
    return {chunk.index for chunk in live_chunks(job)}
