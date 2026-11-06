from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from app.jobs.models import ChunkRecord, Job
from app.library.progress import ProgressView
from app.telemetry.memory import MemoryStats as AdminMemoryStats


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


class JobProgressResponse(BaseModel):
    """Derived listening state. The client never computes any of this."""

    fraction: float
    read_status: str
    heard_chunks: list[int]
    remaining_seconds: float
    position_seconds: float


class FolderBriefResponse(BaseModel):
    id: str
    name: str


class JobSummaryResponse(BaseModel):
    id: str
    title: str | None
    status: str
    voice_id: str
    model_id: str
    is_active_listening: bool
    # Per-job opt-out of the lookahead cap (reader action "Render rest now").
    render_to_end: bool = False
    total_chunks_emitted: int
    total_chunks_completed: int
    buffered_seconds: float
    completed_seconds: float
    # Library metadata. None for events/payloads that only need the scheduler
    # view of a job.
    folder_id: str | None = None
    progress: JobProgressResponse | None = None


class JobDetailResponse(JobSummaryResponse):
    source_kind: str
    source_text: str
    plan_version: int
    chunks: list[ChunkResponse]
    failed_reason: str | None
    # Library context: where the job lives and what plays next. Computed by the
    # server so the reader never rebuilds the folder order.
    folder_path: list[FolderBriefResponse] = Field(default_factory=list)
    previous_job_id: str | None = None
    next_job_id: str | None = None
    # Position within the folder (1-based) and the folder's playable job count,
    # for the reader's "Job 3 of 8" stepper. None for root jobs.
    folder_index: int | None = None
    folder_count: int | None = None
    previous_job_title: str | None = None
    next_job_title: str | None = None
    # index -> live version. Authoritative for the reader: it is what decides
    # which take of a reprocessed chunk plays. It used to live only in server
    # memory, so the reader always fell back to the newest take and the
    # set-active-version endpoint had no observable effect.
    active_chunk_version: dict[int, int] = Field(default_factory=dict)
    # Increments when already-rendered audio is invalidated (full re-render) so
    # the reader can drop its buffered media stream instead of replaying it.
    audio_epoch: int = 0


class JobManifestResponse(BaseModel):
    mime_type: str
    init_segment_url: str | None
    chunks: list[ChunkResponse]
    audio_epoch: int = 0


class CreateJobResponse(BaseModel):
    job: JobDetailResponse


class VoiceResponse(BaseModel):
    id: str
    display_name: str
    description: str | None


class UpdateVoiceRequest(BaseModel):
    voice_id: str
    # Re-render chunks that already have audio, for a single consistent take.
    # Omitted/false keeps the already-rendered audio and only rebuilds the
    # chunks that are still pending.
    rerender_written: bool = False


class ChunkReprocessRequest(BaseModel):
    new_text: str | None = None
    new_voice_id: str | None = None


class ChunkVersionRequest(BaseModel):
    version: int


class PlaybackUpdateRequest(BaseModel):
    # Job-timeline seconds (0 = start of the first chunk), not the player's
    # stream-normalized clock; the reader adds its anchor offset.
    current_time_seconds: float = 0.0
    is_playing: bool = True


class RenderToEndRequest(BaseModel):
    """Per-job opt-out of the scheduler's lookahead cap ("render the rest now")."""

    enabled: bool = True


class AdminConfigResponse(BaseModel):
    device: str
    idle_unload_seconds: int
    max_prebuffer_seconds: int
    target_buffer_seconds: int
    up_next_prebuffer_seconds: int
    render_ahead_seconds: int
    active_listener_timeout_seconds: float
    plan_ahead_chunks: int
    batch_candidates_small_model: list[int]
    batch_candidates_large_model: list[int]
    vram_soft_limit_mb: int
    vram_hard_limit_mb: int
    chunk_max_attempts: int
    model_load_timeout_seconds: float
    synthesis_timeout_seconds: float
    dispatch_stall_seconds: float
    model_residency_batches: int
    voice_residency_batches: int


class AdminConfigUpdateRequest(BaseModel):
    # Admin knobs have near-identical names (vram_soft/hard, target/max buffer);
    # a typo used to be dropped silently, so the operator saw a 200 and no change.
    model_config = ConfigDict(extra="forbid")

    device: str | None = None
    idle_unload_seconds: int | None = None
    max_prebuffer_seconds: int | None = None
    target_buffer_seconds: int | None = None
    up_next_prebuffer_seconds: int | None = None
    render_ahead_seconds: int | None = None
    active_listener_timeout_seconds: float | None = None
    plan_ahead_chunks: int | None = None
    batch_candidates_small_model: list[int] | None = None
    batch_candidates_large_model: list[int] | None = None
    vram_soft_limit_mb: int | None = None
    vram_hard_limit_mb: int | None = None
    chunk_max_attempts: int | None = None
    model_load_timeout_seconds: float | None = None
    synthesis_timeout_seconds: float | None = None
    dispatch_stall_seconds: float | None = None
    model_residency_batches: int | None = None
    voice_residency_batches: int | None = None


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
    # Measured marginal allocated VRAM per rendered chunk, used to size batches
    # against the soft limit. None until the first batch completes.
    vram_per_chunk_mb: float | None = None
    # Model/voice the scheduler is currently committed to. Changing model is an
    # expensive GPU reload, so new jobs on a different model wait their turn.
    resident_model_id: str | None = None
    resident_voice_id: str | None = None
    model_residency_batches: int = 10
    voice_residency_batches: int = 3
    # Liveness. `running=False`, a stale `last_tick_at`, or a non-empty
    # `last_error` are what make a silently stalled scheduler visible.
    running: bool = False
    last_tick_at: float | None = None
    last_error: str | None = None
    consecutive_errors: int = 0
    # Set while dispatch is intentionally paused (e.g. the VRAM hard limit).
    warning: str | None = None


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


class AdminStateResponse(BaseModel):
    config: AdminConfigResponse
    scheduler: SchedulerStateResponse
    telemetry: dict[str, object]
    memory: AdminMemoryStats | None = None
    # Most recent model load/synthesis failure, so a stuck model is not just
    # an unexplained "unloaded" chip.
    model_last_error: str | None = None


class RuntimeStatusResponse(BaseModel):
    """Lightweight, public view of what the GPU is currently committed to.

    The create-job form and the reader use this to default to the resident
    model/voice and to explain why a job on a different model is waiting.
    """

    resident_model_id: str | None = None
    resident_voice_id: str | None = None
    model_state: str
    model_residency_batches: int
    voice_residency_batches: int


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
        "library_changed",
        "job_progress",
    ]
    payload: dict[str, object] = Field(default_factory=dict)


def chunk_to_response(job: Job, chunk: ChunkRecord) -> ChunkResponse:
    segment_url = None
    peaks_url = None
    if chunk.segment_path:
        # The take identity is part of the URL: `version` changes on a chunk
        # reprocess and `audio_epoch` changes when a full re-render invalidates
        # the whole job. Without it the browser could serve/keep the previous
        # take from cache or its MSE buffer.
        take = f"v={chunk.version}&e={job.audio_epoch}"
        segment_url = f"/api/jobs/{job.id}/chunks/{chunk.index}?{take}"
        peaks_url = f"/api/jobs/{job.id}/chunks/{chunk.index}/peaks?{take}"
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


def progress_to_response(view: ProgressView) -> JobProgressResponse:
    return JobProgressResponse(
        fraction=view.fraction,
        read_status=view.read_status,
        heard_chunks=list(view.heard_chunks),
        remaining_seconds=view.remaining_seconds,
        position_seconds=view.position_seconds,
    )


def job_to_summary(job: Job, *, progress: ProgressView | None = None) -> JobSummaryResponse:
    return JobSummaryResponse(
        id=job.id,
        title=job.title,
        status=job.status,
        voice_id=job.voice_id,
        model_id=job.model_id,
        is_active_listening=job.is_active_listening,
        render_to_end=job.render_to_end,
        total_chunks_emitted=job.total_chunks_emitted,
        total_chunks_completed=job.total_chunks_completed,
        buffered_seconds=job.buffered_seconds,
        completed_seconds=job.completed_seconds,
        folder_id=job.folder_id,
        progress=progress_to_response(progress) if progress is not None else None,
    )


def job_to_detail(
    job: Job,
    *,
    progress: ProgressView | None = None,
    folder_path: list[FolderBriefResponse] | None = None,
    previous_job_id: str | None = None,
    next_job_id: str | None = None,
    folder_index: int | None = None,
    folder_count: int | None = None,
    previous_job_title: str | None = None,
    next_job_title: str | None = None,
) -> JobDetailResponse:
    return JobDetailResponse(
        **job_to_summary(job, progress=progress).model_dump(),
        source_kind=job.source_kind,
        source_text=job.source_text,
        plan_version=job.plan_version,
        chunks=[
            chunk_to_response(job, chunk)
            for chunk in sorted(job.chunks, key=lambda item: item.index)
        ],
        active_chunk_version=dict(job.active_chunk_version),
        failed_reason=job.failed_reason,
        audio_epoch=job.audio_epoch,
        folder_path=folder_path or [],
        previous_job_id=previous_job_id,
        next_job_id=next_job_id,
        folder_index=folder_index,
        folder_count=folder_count,
        previous_job_title=previous_job_title,
        next_job_title=next_job_title,
    )
