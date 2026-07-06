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
    PLANNED = "planned"
    QUEUED = "queued"
    RENDERING = "rendering"
    WRITTEN = "written"
    STALE = "stale"
    FAILED = "failed"
    REPROCESSING = "reprocessing"
    MAX_RETRIES_EXCEEDED = "max_retries_exceeded"


class ModelState(StrEnum):
    UNLOADED = "unloaded"
    LOADING = "loading"
    WARM_IDLE = "warm_idle"
    BUSY = "busy"
    EVICTING = "evicting"
    NOT_ENOUGH_VRAM = "not_enough_vram"


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
    deprecated: bool = False
    reprocessing: bool = False
    created_at: float = field(default_factory=time)
    updated_at: float = field(default_factory=time)


@dataclass(slots=True)
class Job:
    id: str
    title: str | None
    source_kind: str
    source_text: str
    model_id: str
    voice_id: str
    language: str = "English"
    plan_version: int = 1
    status: JobStatus = JobStatus.QUEUED
    is_active_listening: bool = False
    submitted_at: float = field(default_factory=time)
    updated_at: float = field(default_factory=time)
    planner_cursor: PlannerCursor = field(default_factory=PlannerCursor)
    chunks: list[ChunkRecord] = field(default_factory=list)
    buffered_seconds: float = 0.0
    completed_seconds: float = 0.0
    total_chunks_emitted: int = 0
    total_chunks_completed: int = 0
    active_chunk_version: dict[int, int] = field(default_factory=dict)
    total_versioned_chunks: int = 0
    total_versioned_completed: int = 0
    playback_state: PlaybackState = field(default_factory=PlaybackState)
    failed_reason: str | None = None

    def written_chunks(self) -> list[ChunkRecord]:
        return [chunk for chunk in self.chunks if chunk.status == ChunkStatus.WRITTEN]

    def pending_chunks(self) -> list[ChunkRecord]:
        return [
            chunk
            for chunk in self.chunks
            if chunk.status in {ChunkStatus.PLANNED, ChunkStatus.QUEUED, ChunkStatus.RENDERING}
        ]

    def next_unwritten_chunk(self) -> ChunkRecord | None:
        for chunk in sorted(self.chunks, key=lambda item: item.index):
            if chunk.status in {ChunkStatus.PLANNED, ChunkStatus.QUEUED, ChunkStatus.RENDERING}:
                return chunk
        return None

    def get_active_chunk(self, index: int) -> ChunkRecord | None:
        """Return the currently active version of a chunk, or None if not found."""
        version = self.active_chunk_version.get(index)
        for chunk in self.chunks:
            if chunk.index == index and chunk.version == version:
                return chunk
        return None

    def get_latest_chunk_version(self, index: int) -> int:
        """Return the highest version number for a chunk index."""
        return max((c.version for c in self.chunks if c.index == index), default=-1)

    def versioned_pending_chunks(self) -> list[ChunkRecord]:
        """Return active-version chunks that still need rendering."""
        result = []
        for index, version in self.active_chunk_version.items():
            for chunk in self.chunks:
                if chunk.index == index and chunk.version == version:
                    if chunk.status in {ChunkStatus.PLANNED, ChunkStatus.QUEUED, ChunkStatus.RENDERING, ChunkStatus.REPROCESSING}:
                        result.append(chunk)
                    break
        return result

    def versioned_written_chunks(self) -> list[ChunkRecord]:
        """Return active-version chunks that are already rendered."""
        result = []
        for index, version in self.active_chunk_version.items():
            for chunk in self.chunks:
                if chunk.index == index and chunk.version == version:
                    if chunk.status == ChunkStatus.WRITTEN:
                        result.append(chunk)
                    break
        return result

    def mark_all_chunk_versions_deprecated(self, index: int) -> None:
        """Mark all versions of a chunk as deprecated."""
        for chunk in self.chunks:
            if chunk.index == index:
                chunk.deprecated = True
                chunk.updated_at = time()

    def set_active_chunk_version(self, index: int, version: int) -> None:
        """Mark a specific version as the active one for a chunk index."""
        self.active_chunk_version[index] = version
        self.updated_at = time()
