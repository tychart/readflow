from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

from app.jobs.models import ChunkRecord, Job


class ChunkResponse(BaseModel):
    index: int
    status: str
    duration_seconds: float
    start_seconds: float
    plan_version: int
    version: int = 0
    voice_id: str
    segment_url: str | None
    peaks_url: str | None = None
    deprecated: bool = False
    reprocessing: bool = False
    char_start: int = 0
    char_end: int = 0


class JobSummaryResponse(BaseModel):
    id: str
    title: str | None
    status: str
    voice_id: str
    model_id: str
    is_active_listening: bool
    total_chunks_emitted: int
    total_chunks_completed: int
    buffered_seconds: float
    completed_seconds: float


class JobDetailResponse(JobSummaryResponse):
    source_kind: str
    source_text: str
    plan_version: int
    chunks: list[ChunkResponse]
    failed_reason: str | None


class JobManifestResponse(BaseModel):
    mime_type: str
    init_segment_url: str | None
    chunks: list[ChunkResponse]


class CreateJobResponse(BaseModel):
    job: JobDetailResponse


class VoiceResponse(BaseModel):
    id: str
    display_name: str
    description: str | None


class UpdateVoiceRequest(BaseModel):
    voice_id: str


class ChunkReprocessRequest(BaseModel):
    new_text: str | None = None
    new_voice_id: str | None = None


class ChunkVersionRequest(BaseModel):
    version: int


class PlaybackUpdateRequest(BaseModel):
    current_time_seconds: float = 0.0
    is_playing: bool = True


class AdminConfigResponse(BaseModel):
    device: str
    idle_unload_seconds: int
    max_prebuffer_seconds: int
    target_buffer_seconds: int
    inactive_job_ahead_chunks: int
    batch_candidates_small_model: list[int]
    batch_candidates_large_model: list[int]
    vram_soft_limit_mb: int
    vram_hard_limit_mb: int


class AdminConfigUpdateRequest(BaseModel):
    device: str | None = None
    idle_unload_seconds: int | None = None
    max_prebuffer_seconds: int | None = None
    target_buffer_seconds: int | None = None
    inactive_job_ahead_chunks: int | None = None
    batch_candidates_small_model: list[int] | None = None
    batch_candidates_large_model: list[int] | None = None
    vram_soft_limit_mb: int | None = None
    vram_hard_limit_mb: int | None = None


class QueueBatch(BaseModel):
    """One synthesis batch: chunks that share a model/language/voice group.

    `started_at` is only set for the batch currently being rendered; the
    predicted next batch leaves it `None`.
    """

    chunk_count: int
    model_id: str | None = None
    language: str | None = None
    voice_id: str | None = None
    started_at: float | None = None


class SchedulerStateResponse(BaseModel):
    queue_depth: int
    batch_candidates: list[int]
    # Present while a batch is rendering so the admin queue view can go live
    # without polling. The full queue detail is fetched over HTTP.
    active_batch: QueueBatch | None = None


class QueueChunkVersionResponse(BaseModel):
    version: int
    status: str
    deprecated: bool


class QueueChunkResponse(BaseModel):
    """One chunk plus the derived scheduling facts an operator needs.

    This is an admin-only debugging view: it includes the chunk text and the
    exact inputs behind the scheduler's ordering (priority band, job buffer
    state, rank) so the operator can see *why* work is ordered the way it is.
    Written chunks are included too so the full job lifecycle is visible;
    `is_pending` distinguishes the ones the scheduler can still act on.
    """

    job_id: str
    job_title: str | None
    job_status: str
    job_is_active_listening: bool
    job_buffered_seconds: float
    job_target_buffer_seconds: int
    index: int
    version: int
    status: str
    plan_version: int
    voice_id: str
    language: str
    model_id: str
    text: str
    char_start: int
    char_end: int
    char_count: int
    estimated_duration_seconds: float
    duration_seconds: float = 0.0
    start_seconds: float = 0.0
    priority_band: int
    priority_label: str
    priority_reason: str
    # Position within the global pending priority order; 0 for non-pending.
    rank: int
    is_pending: bool
    is_rendering: bool
    in_next_batch: bool
    created_at: float
    updated_at: float
    error: str | None = None
    versions: list[QueueChunkVersionResponse] = Field(default_factory=list)


class QueueJobGroup(BaseModel):
    """A job plus its full chunk lifecycle, for the admin queue inspector."""

    job_id: str
    job_title: str | None
    job_status: str
    job_is_active_listening: bool
    job_buffered_seconds: float
    job_target_buffer_seconds: int
    model_id: str
    language: str
    voice_id: str
    total_chunks: int
    written_chunks: int
    pending_chunks: int
    failed_chunks: int
    # Characters in the canonical source text the planner has not reached yet.
    unplanned_chars: int
    # True when older chunks were dropped to bound the payload; the returned
    # list always keeps every pending chunk and the most recent history.
    chunks_truncated: bool = False
    chunks: list[QueueChunkResponse] = Field(default_factory=list)


class AdminQueueResponse(BaseModel):
    generated_at: float
    queue_depth: int
    active_batch: QueueBatch | None = None
    next_batch: QueueBatch | None = None
    jobs: list[QueueJobGroup] = Field(default_factory=list)


class AdminMemoryStats(BaseModel):
    device: str
    vram_total_mb: int
    vram_used_mb: int
    vram_reserved_mb: int
    vram_free_mb: int
    ram_total_mb: int
    ram_free_mb: int
    ram_used_mb: int


class AdminStateResponse(BaseModel):
    config: AdminConfigResponse
    scheduler: SchedulerStateResponse
    telemetry: dict[str, object]
    memory: AdminMemoryStats | None = None


class WsEnvelope(BaseModel):
    type: Literal[
        "job_created",
        "job_updated",
        "job_completed",
        "chunk_ready",
        "scheduler_state",
        "model_state",
        "telemetry",
        "admin_config_updated",
        "memory_stats",
    ]
    payload: dict[str, object] = Field(default_factory=dict)


def chunk_to_response(job: Job, chunk: ChunkRecord) -> ChunkResponse:
    segment_url = None
    peaks_url = None
    if chunk.segment_path:
        segment_url = f"/api/jobs/{job.id}/chunks/{chunk.index}"
        peaks_url = f"/api/jobs/{job.id}/chunks/{chunk.index}/peaks"
    return ChunkResponse(
        index=chunk.index,
        status=chunk.status,
        duration_seconds=chunk.duration_seconds,
        start_seconds=chunk.start_seconds,
        plan_version=chunk.plan_version,
        version=chunk.version,
        voice_id=chunk.voice_id,
        segment_url=segment_url,
        peaks_url=peaks_url,
        deprecated=chunk.deprecated,
        reprocessing=chunk.reprocessing,
        char_start=chunk.char_start,
        char_end=chunk.char_end,
    )


def job_to_summary(job: Job) -> JobSummaryResponse:
    return JobSummaryResponse(
        id=job.id,
        title=job.title,
        status=job.status,
        voice_id=job.voice_id,
        model_id=job.model_id,
        is_active_listening=job.is_active_listening,
        total_chunks_emitted=job.total_chunks_emitted,
        total_chunks_completed=job.total_chunks_completed,
        buffered_seconds=job.buffered_seconds,
        completed_seconds=job.completed_seconds,
    )


def job_to_detail(job: Job) -> JobDetailResponse:
    return JobDetailResponse(
        **job_to_summary(job).model_dump(),
        source_kind=job.source_kind,
        source_text=job.source_text,
        plan_version=job.plan_version,
        chunks=[
            chunk_to_response(job, chunk)
            for chunk in sorted(job.chunks, key=lambda item: item.index)
        ],
        failed_reason=job.failed_reason,
    )
