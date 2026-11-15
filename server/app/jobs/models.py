from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field, fields
from enum import StrEnum
from types import MappingProxyType
from typing import Any

from app.core.identity import DEFAULT_USER_ID
from app.core.time import utc_now


class JobStatus(StrEnum):
    QUEUED = "queued"
    RENDERING = "rendering"
    PAUSED = "paused"
    PLAYING = "playing"
    COMPLETED = "completed"
    FAILED = "failed"


# Coarse statuses that mean "nothing more will render". Playback of them is
# local-only, but the listener state (folder warming) is still tracked.
TERMINAL_JOB_STATUSES = frozenset({JobStatus.COMPLETED, JobStatus.FAILED})


class ChunkStatus(StrEnum):
    """Lifecycle of one chunk record.

    The scheduler produces `PLANNED`, `RENDERING`, `WRITTEN` and `FAILED`.
    `QUEUED`, `STALE`, `REPROCESSING` and `MAX_RETRIES_EXCEEDED` are part of the
    wire vocabulary the reader and the queue inspector render, so they stay in
    the enum even though nothing assigns them today. Everything that needs "is
    this chunk still work" uses the sets below rather than listing statuses
    again.
    """

    PLANNED = "planned"
    QUEUED = "queued"
    RENDERING = "rendering"
    WRITTEN = "written"
    STALE = "stale"
    FAILED = "failed"
    REPROCESSING = "reprocessing"
    MAX_RETRIES_EXCEEDED = "max_retries_exceeded"


# A chunk the scheduler can still act on: waiting to be picked, picked, or in
# flight. This used to be spelled out in five places (`Job.pending_chunks`,
# `queue_depth`, `renderable_chunks`, the scheduler's own `_PENDING_STATUSES`
# and the queue snapshot), which is exactly how they drifted apart.
PENDING_CHUNK_STATUSES = frozenset({ChunkStatus.PLANNED, ChunkStatus.QUEUED, ChunkStatus.RENDERING})

# Everything that keeps a job from being `completed`: pending work plus a chunk
# that is being reprocessed.
UNFINISHED_CHUNK_STATUSES = PENDING_CHUNK_STATUSES | {ChunkStatus.REPROCESSING}


class ModelState(StrEnum):
    UNLOADED = "unloaded"
    LOADING = "loading"
    WARM_IDLE = "warm_idle"
    BUSY = "busy"
    EVICTING = "evicting"
    NOT_ENOUGH_VRAM = "not_enough_vram"
    # A load or synthesis failed in a way the provider cannot recover from by
    # itself (timeout, executor hang, non-VRAM load error). Scheduling pauses
    # until the provider is reset — automatically after `dispatch_stall_seconds`,
    # or immediately from Admin.
    ERROR = "error"


@dataclass(slots=True)
class PlaybackState:
    current_time_seconds: float = 0.0
    is_playing: bool = False
    last_event_at: float = field(default_factory=utc_now)


@dataclass(slots=True)
class PlannerCursor:
    offset: int = 0
    chunks_emitted: int = 0

    @property
    def exhausted(self) -> bool:
        return self.offset < 0


@dataclass(slots=True)
class ChunkRecord:
    job_id: str
    index: int
    text: str
    voice_id: str
    plan_version: int
    char_start: int
    char_end: int
    version: int = 0
    language: str = "English"
    status: ChunkStatus = ChunkStatus.PLANNED
    start_seconds: float = 0.0
    duration_seconds: float = 0.0
    segment_path: str | None = None
    wav_path: str | None = None
    error: str | None = None
    parent_chunk_index: int | None = None
    # True for superseded takes: they stay in `Job.chunks` as history (the
    # queue inspector shows the version list) but are excluded from the
    # timeline, the buffer, the export and the counts.
    deprecated: bool = False
    reprocessing: bool = False
    # Number of failed attempts so far. The scheduler retries a failed chunk up
    # to `chunk_max_attempts`, then marks it failed and moves on without
    # failing the whole job.
    attempts: int = 0
    created_at: float = field(default_factory=utc_now)
    updated_at: float = field(default_factory=utc_now)

    @property
    def char_count(self) -> int:
        """Characters of source text this take covers."""
        return len(self.text)


@dataclass(slots=True)
class Job:
    """One job's mutable aggregate: the job row plus its chunk takes.

    The canonical source text is deliberately **not** here. It lives in its own
    `job_sources` row and is loaded only by the reader's detail view and by the
    planner, so a list endpoint no longer re-materialises megabytes per job.
    `source_char_count` is enough for every derived number.
    """

    id: str
    title: str | None
    source_kind: str
    # `chunk.char_start` / `char_end` index into the canonical text stored in
    # `job_sources` (normalized once by `JobManager.create_job`). This count is
    # the only thing the aggregate needs from it.
    source_char_count: int
    model_id: str
    voice_id: str
    language: str = "English"
    # Owner. Every stored row is user-scoped, and every lookup is
    # `(user_id, id)`, so a foreign id is indistinguishable from a missing one.
    user_id: str = DEFAULT_USER_ID
    # Parent folder, or None for the root library. Grouping is a library
    # concern; the scheduler never reads this.
    folder_id: str | None = None
    # Manual order among the jobs directly inside `folder_id` (folders have
    # their own sequence and are always rendered first).
    position: int = 0
    # Soft delete. A trashed job is invisible to the scheduler and the reader
    # until it is restored or purged.
    deleted_at: float | None = None
    trash_entry_id: str | None = None
    plan_version: int = 1
    # Bumped when already-rendered audio is invalidated (a full voice
    # re-render). It is surfaced in the media/peaks URLs and in the reader's
    # player stream key so the browser drops its buffered MSE stream and
    # re-fetches instead of continuing to play the superseded take.
    audio_epoch: int = 0
    status: JobStatus = JobStatus.QUEUED
    is_active_listening: bool = False
    # Per-job opt-out of the scheduler's lookahead cap (`render_ahead_seconds`).
    # Set by the reader's "Render rest now" action. It deliberately does not
    # override a pause: pause remains the only intentional stop.
    render_to_end: bool = False
    submitted_at: float = field(default_factory=utc_now)
    updated_at: float = field(default_factory=utc_now)
    planner_cursor: PlannerCursor = field(default_factory=PlannerCursor)
    # Every record ever produced, including superseded takes. `active_chunks()`
    # is the one place that knows which of them are live.
    chunks: list[ChunkRecord] = field(default_factory=list)
    # Index for the next planned chunk. Indexes are therefore dense and
    # monotonically assigned, which is what makes `total_chunks_emitted`
    # exact even after reprocessing appended extra records.
    next_chunk_index: int = 0
    # index -> live version. Authoritative: `deprecated` mirrors it, and the
    # reader uses this map (it is part of the job payload) to pick its takes.
    active_chunk_version: dict[int, int] = field(default_factory=dict)
    buffered_seconds: float = 0.0
    completed_seconds: float = 0.0
    #
    # Rollups. All of them are computed over **live takes only** by
    # `JobManager._refresh_derived`, which is their single writer. They exist so
    # a list/summary read never has to touch the chunk table: `written_seconds`
    # and `unwritten_chars` make the remaining-audio estimate exact, and
    # `pending_chunks` makes the queue depth a column sum.
    #
    # Number of live WRITTEN takes (gaps included).
    written_seconds: float = 0.0
    # Highest live WRITTEN index, else None. Equivalent to the old per-chunk
    # "last playable index" scan.
    last_written_index: int | None = None
    # Live takes in UNFINISHED_CHUNK_STATUSES.
    unfinished_chunks: int = 0
    # Characters of live takes that are not WRITTEN yet.
    unwritten_chars: int = 0
    # Live takes in PENDING_CHUNK_STATUSES under the current plan generation.
    pending_chunks: int = 0
    # Duration of the playable run from index 0 (stops at the first gap).
    contiguous_written_seconds: float = 0.0
    total_chunks_completed: int = 0
    playback_state: PlaybackState = field(default_factory=PlaybackState)
    failed_reason: str | None = None

    @property
    def total_chunks_emitted(self) -> int:
        """Number of distinct chunks in the job (superseded takes excluded)."""
        return self.next_chunk_index

    def summary(self) -> JobSummary:
        """A flat, frozen projection of this job for list/read-model use.

        Built field-by-field from `SUMMARY_FIELDS` so a renamed or dropped field
        cannot silently disappear from every projection; `test_summary.py` pins
        the tuple against `JobSummary`'s own fields.
        """
        values: dict[str, Any] = {
            name: _summary_value(name, getattr(self, name)) for name in SUMMARY_FIELDS
        }
        return JobSummary(**values)

    def active_chunks(self) -> list[ChunkRecord]:
        """The live take of every chunk index, in timeline order."""
        return sorted(
            (chunk for chunk in self.chunks if not chunk.deprecated),
            key=lambda chunk: chunk.index,
        )

    def active_chunk(self, index: int) -> ChunkRecord | None:
        """The live take for one chunk index, or None when it does not exist."""
        version = self.active_chunk_version.get(index)
        if version is None:
            return None
        return next(
            (chunk for chunk in self.chunks if chunk.index == index and chunk.version == version),
            None,
        )

    def has_unfinished_chunks(self) -> bool:
        """True while any live chunk still needs rendering.

        Completion must be decided from this, not from a pending-version list:
        that only knows about reprocessed versions, so for a normal job it is
        always empty and a job would be marked `completed` as soon as the
        planner reached the end of the text — even with a whole batch queued.
        Superseded takes never count: the listener will not hear them.

        The `unfinished_chunks` rollup is this same predicate, cached by
        `_refresh_derived` for summaries; this scans the aggregate so it cannot
        go stale mid-transaction.
        """
        return any(
            not chunk.deprecated and chunk.status in UNFINISHED_CHUNK_STATUSES
            for chunk in self.chunks
        )

    def recompute_derived(self) -> None:
        """Recompute every value derived from the chunk list, in one pass.

        This is the **only** writer of the stored rollups
        (`total_chunks_completed`, `contiguous_written_seconds`,
        `written_seconds`, `last_written_index`, `unfinished_chunks`,
        `unwritten_chars`, `pending_chunks`) and of the two playback-derived
        numbers that depend on them. They all describe the **live** takes:
        superseded versions stay in `chunks` as history, and including them used
        to double-count a reprocessed chunk, inflate `buffered_seconds` with
        audio nobody will hear, and skew `total_chunks_completed` past
        `total_chunks_emitted`.

        `JobManager._refresh_derived` calls this on every mutation and follows it
        with the progress-row consistency write, which needs a transaction.
        """
        running_start = 0.0
        contiguous = 0.0
        contiguous_open = True
        completed = 0
        written_seconds = 0.0
        last_written_index: int | None = None
        unfinished = 0
        unwritten_chars = 0
        pending = 0
        for chunk in self.active_chunks():
            if chunk.status in UNFINISHED_CHUNK_STATUSES:
                unfinished += 1
            if chunk.status in PENDING_CHUNK_STATUSES and chunk.plan_version == self.plan_version:
                pending += 1
            if chunk.status != ChunkStatus.WRITTEN:
                # Start times place later written chunks as if the gap were
                # zero-length (the gap-aware timeline), but the *playable* run
                # stops at the first hole.
                contiguous_open = False
                unwritten_chars += chunk.char_count
                continue
            completed += 1
            written_seconds += chunk.duration_seconds
            last_written_index = chunk.index
            chunk.start_seconds = running_start
            running_start += chunk.duration_seconds
            if contiguous_open:
                contiguous += chunk.duration_seconds
        self.total_chunks_completed = completed
        self.contiguous_written_seconds = contiguous
        self.written_seconds = written_seconds
        self.last_written_index = last_written_index
        self.unfinished_chunks = unfinished
        self.unwritten_chars = unwritten_chars
        self.pending_chunks = pending
        self.buffered_seconds = max(0.0, contiguous - self.playback_state.current_time_seconds)
        self.completed_seconds = max(
            self.completed_seconds, self.playback_state.current_time_seconds
        )

    def apply_playback_report(self, position_seconds: float, is_playing: bool, now: float) -> None:
        """Fold a listener's position report into the job.

        `position_seconds` is in **job-timeline** seconds (0 = the start of the
        first chunk), not the player's stream-normalized MSE clock. The buffer
        is derived from the same timeline, and subtracting a stream position
        after a seek/reload made `buffered_seconds` look permanently full (it is
        what kept a lookahead cap from ever being released), so the reader adds
        its anchor offset before reporting.

        A finished job plays from local audio: its position, buffer and totals
        are frozen. Listener intent is not, because the folder successor is
        warmed from it.
        """
        if self.status in TERMINAL_JOB_STATUSES:
            self.is_active_listening = is_playing
            self.playback_state.last_event_at = now
            self.updated_at = now
            return
        self.playback_state.current_time_seconds = position_seconds
        self.playback_state.is_playing = is_playing
        self.playback_state.last_event_at = now
        self.completed_seconds = max(self.completed_seconds, position_seconds)
        self.buffered_seconds = max(0.0, self.contiguous_written_seconds - position_seconds)
        if is_playing and self.status != JobStatus.PAUSED:
            # A position report while playing is proof of an active listener, so
            # the flag does not depend on the reader hitting /activate after a
            # reload. Explicit pause still wins: that path sets PAUSED first.
            self.is_active_listening = True
            self.status = JobStatus.PLAYING
        self.updated_at = now

    def get_latest_chunk_version(self, index: int) -> int:
        """Highest version number recorded for `index`, or -1 when absent."""
        return max((chunk.version for chunk in self.chunks if chunk.index == index), default=-1)

    def activate_chunk_version(self, index: int, version: int) -> ChunkRecord:
        """Make `version` the live take for `index` and deprecate the others.

        This is the only place that writes `deprecated`/`active_chunk_version`,
        so the two can never disagree (they used to: activating an older take
        un-deprecated it without deprecating the newer one, leaving two live
        records for one index — which duplicated timeline seconds, kept the
        rejected take in the download, and let the reader pick the wrong one).

        Validation happens before any mutation, so an unknown version leaves
        the job exactly as it was.
        """
        target = next(
            (chunk for chunk in self.chunks if chunk.index == index and chunk.version == version),
            None,
        )
        if target is None:
            raise KeyError(f"Chunk {index} has no version {version}")
        now = utc_now()
        for chunk in self.chunks:
            if chunk.index != index:
                continue
            chunk.deprecated = chunk.version != version
            chunk.updated_at = now
        self.active_chunk_version[index] = version
        self.updated_at = now
        return target


@dataclass(frozen=True, slots=True)
class JobSummary:
    """Flat, immutable projection of one job row.

    List endpoints and the scheduler work from these: no chunk list, no source
    text, so a tick or a library refresh costs one query instead of one
    aggregate load per job. Mutable fields are copied on construction (see
    `Job.summary`), so a summary never observes a later mutation.

    Keep `SUMMARY_FIELDS` and this dataclass in lockstep — `test_summary.py`
    asserts the tuple matches the dataclass fields, so a renamed field cannot
    silently disappear from every projection.
    """

    id: str
    title: str | None
    status: JobStatus
    voice_id: str
    model_id: str
    language: str
    user_id: str
    folder_id: str | None
    position: int
    deleted_at: float | None
    trash_entry_id: str | None
    plan_version: int
    audio_epoch: int
    is_active_listening: bool
    render_to_end: bool
    submitted_at: float
    updated_at: float
    planner_cursor: PlannerCursor
    next_chunk_index: int
    active_chunk_version: Mapping[int, int]
    buffered_seconds: float
    completed_seconds: float
    total_chunks_completed: int
    contiguous_written_seconds: float
    written_seconds: float
    last_written_index: int | None
    unfinished_chunks: int
    unwritten_chars: int
    pending_chunks: int
    source_char_count: int
    playback_state: PlaybackState
    failed_reason: str | None

    @property
    def total_chunks_emitted(self) -> int:
        """Number of distinct chunks in the job (matches `Job`)."""
        return self.next_chunk_index

    def has_unfinished_chunks(self) -> bool:
        """Same question as `Job.has_unfinished_chunks`, answered by the rollup."""
        return self.unfinished_chunks > 0


# The projection surface, in declaration order. Explicit so `Job.summary()`
# cannot drop a field when `Job` gains one.
SUMMARY_FIELDS: tuple[str, ...] = tuple(summary_field.name for summary_field in fields(JobSummary))


def _summary_value(name: str, value: object) -> object:
    """Freeze one mutable aggregate value for a `JobSummary`."""
    if name == "planner_cursor":
        cursor = value
        assert isinstance(cursor, PlannerCursor)
        return PlannerCursor(offset=cursor.offset, chunks_emitted=cursor.chunks_emitted)
    if name == "playback_state":
        state = value
        assert isinstance(state, PlaybackState)
        return PlaybackState(
            current_time_seconds=state.current_time_seconds,
            is_playing=state.is_playing,
            last_event_at=state.last_event_at,
        )
    if name == "active_chunk_version":
        versions = value
        assert isinstance(versions, dict)
        return MappingProxyType(dict(versions))
    return value
