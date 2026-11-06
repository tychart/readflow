from __future__ import annotations

from dataclasses import dataclass, field
from enum import StrEnum
from time import time


class JobStatus(StrEnum):
    QUEUED = "queued"
    RENDERING = "rendering"
    PAUSED = "paused"
    PLAYING = "playing"
    COMPLETED = "completed"
    FAILED = "failed"


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
    last_event_at: float = field(default_factory=time)


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
    created_at: float = field(default_factory=time)
    updated_at: float = field(default_factory=time)


@dataclass(slots=True)
class Job:
    id: str
    title: str | None
    source_kind: str
    # Canonical text: `JobManager.create_job` stores it already normalized via
    # `app.chunking.normalize.normalize_source_text`. Every `char_start` /
    # `char_end` offset in `chunks` indexes into this string, and the reader
    # slices the same string, so it must never be normalized a second time.
    source_text: str
    model_id: str
    voice_id: str
    language: str = "English"
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
    submitted_at: float = field(default_factory=time)
    updated_at: float = field(default_factory=time)
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
    # Derived from `chunks` by `JobManager` (see `_refresh_derived`): number of
    # live chunks that are written, and the duration of the playable run from
    # index 0. Both exclude superseded takes.
    total_chunks_completed: int = 0
    contiguous_written_seconds: float = 0.0
    playback_state: PlaybackState = field(default_factory=PlaybackState)
    failed_reason: str | None = None

    @property
    def total_chunks_emitted(self) -> int:
        """Number of distinct chunks in the job (superseded takes excluded)."""
        return self.next_chunk_index

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
        """
        return any(
            not chunk.deprecated and chunk.status in UNFINISHED_CHUNK_STATUSES
            for chunk in self.chunks
        )

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
        now = time()
        for chunk in self.chunks:
            if chunk.index != index:
                continue
            chunk.deprecated = chunk.version != version
            chunk.updated_at = now
        self.active_chunk_version[index] = version
        self.updated_at = now
        return target
