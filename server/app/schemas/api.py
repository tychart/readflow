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
    batch_candidates_small_model: list[int]
    batch_candidates_large_model: list[int]
    vram_soft_limit_mb: int
    vram_hard_limit_mb: int


class AdminConfigUpdateRequest(BaseModel):
    device: str | None = None
    idle_unload_seconds: int | None = None
    max_prebuffer_seconds: int | None = None
    target_buffer_seconds: int | None = None
    batch_candidates_small_model: list[int] | None = None
    batch_candidates_large_model: list[int] | None = None
    vram_soft_limit_mb: int | None = None
    vram_hard_limit_mb: int | None = None


class SchedulerStateResponse(BaseModel):
    queue_depth: int
    batch_candidates: list[int]


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
