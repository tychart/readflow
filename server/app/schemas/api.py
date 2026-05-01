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
    voice_id: str
    segment_url: str | None


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


class PlaybackUpdateRequest(BaseModel):
    current_time_seconds: float = 0.0
    is_playing: bool = True


class AdminConfigResponse(BaseModel):
    idle_unload_seconds: int
    max_prebuffer_seconds: int
    target_buffer_seconds: int
    batch_candidates_small_model: list[int]
    batch_candidates_large_model: list[int]
    vram_soft_limit_mb: int
    vram_hard_limit_mb: int


class AdminConfigUpdateRequest(BaseModel):
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


class AdminStateResponse(BaseModel):
    config: AdminConfigResponse
    scheduler: SchedulerStateResponse
    telemetry: dict[str, object]


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
    ]
    payload: dict[str, object] = Field(default_factory=dict)


def chunk_to_response(job: Job, chunk: ChunkRecord) -> ChunkResponse:
    segment_url = None
    if chunk.segment_path:
        segment_url = f"/api/jobs/{job.id}/chunks/{chunk.index}"
    return ChunkResponse(
        index=chunk.index,
        status=chunk.status,
        duration_seconds=chunk.duration_seconds,
        start_seconds=chunk.start_seconds,
        plan_version=chunk.plan_version,
        voice_id=chunk.voice_id,
        segment_url=segment_url,
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
