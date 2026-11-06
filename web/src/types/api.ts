export type JobStatus =
  | "queued"
  | "rendering"
  | "paused"
  | "playing"
  | "completed"
  | "failed";
export type ChunkStatus =
  | "planned"
  | "queued"
  | "rendering"
  | "written"
  | "stale"
  | "failed"
  | "reprocessing"
  | "max_retries_exceeded";
export interface Chunk {
  index: number;
  status: ChunkStatus;
  duration_seconds: number;
  start_seconds: number;
  plan_version: number;
  version: number;
  voice_id: string;
  segment_url: string | null;
  peaks_url: string | null;
  deprecated: boolean;
  reprocessing: boolean;
  char_start: number;
  char_end: number;
}

export type ReadStatus = "unread" | "in_progress" | "read";

/** Server-derived listening state; never computed in the client. */
export interface JobProgress {
  fraction: number;
  read_status: ReadStatus;
  heard_chunks: number[];
  remaining_seconds: number;
  position_seconds: number;
}

export interface FolderBrief {
  id: string;
  name: string;
}

export interface JobSummary {
  id: string;
  title: string | null;
  status: JobStatus;
  voice_id: string;
  model_id: string;
  is_active_listening: boolean;
  /** This job ignores the scheduler's lookahead cap ("Render rest now"). */
  render_to_end: boolean;
  total_chunks_emitted: number;
  total_chunks_completed: number;
  buffered_seconds: number;
  completed_seconds: number;
  /** Library metadata; omitted on streamed summaries that do not need it. */
  folder_id?: string | null;
  progress?: JobProgress | null;
}

export interface JobDetail extends JobSummary {
  source_kind: string;
  source_text: string;
  plan_version: number;
  chunks: Chunk[];
  failed_reason: string | null;
  active_chunk_version?: Record<number, number>;
  /** Bumped when already-rendered audio is invalidated (a full re-render). */
  audio_epoch: number;
  /** Where the job lives and what plays next (server-computed folder order). */
  folder_path?: FolderBrief[];
  previous_job_id?: string | null;
  next_job_id?: string | null;
}

export interface ProgressUpdateResponse {
  job_id: string;
  position_seconds: number;
  progress: JobProgress;
}

export interface JobManifest {
  mime_type: string;
  init_segment_url: string | null;
  chunks: Chunk[];
  /** Take identity of the audio; part of the player's stream key. */
  audio_epoch: number;
}

export interface Voice {
  id: string;
  display_name: string;
  description: string | null;
}

/** Device override the admin can pick; mirrors `RuntimeConfig.device` on the server. */
export type AdminDevice = "auto" | "gpu" | "cpu";

export interface AdminConfig {
  device: AdminDevice;
  idle_unload_seconds: number;
  max_prebuffer_seconds: number;
  target_buffer_seconds: number;
  /** Warming target for the next job in a playing folder; 0 disables it. */
  up_next_prebuffer_seconds: number;
  /** Opt-in lookahead cap in seconds; 0 (default) renders every job to the end. */
  render_ahead_seconds: number;
  /** Seconds without a playback report before a job stops counting as listened. */
  active_listener_timeout_seconds: number;
  plan_ahead_chunks: number;
  batch_candidates_small_model: number[];
  batch_candidates_large_model: number[];
  vram_soft_limit_mb: number;
  vram_hard_limit_mb: number;
  chunk_max_attempts: number;
  model_load_timeout_seconds: number;
  synthesis_timeout_seconds: number;
  /**
   * How long dispatch may stay blocked with work pending before the scheduler
   * recovers by itself (unload the model, or reset an errored provider).
   * 0 disables automatic recovery.
   */
  dispatch_stall_seconds: number;
  model_residency_batches: number;
  voice_residency_batches: number;
}

export interface QueueBatch {
  chunk_count: number;
  model_id: string | null;
  language: string | null;
  voice_id: string | null;
  started_at: number | null;
}

/** One pending chunk plus the scheduler facts behind its ordering. */
export interface QueueChunk {
  job_id: string;
  job_title: string | null;
  job_status: JobStatus;
  job_is_active_listening: boolean;
  job_buffered_seconds: number;
  job_target_buffer_seconds: number;
  index: number;
  version: number;
  status: ChunkStatus;
  plan_version: number;
  voice_id: string;
  language: string;
  model_id: string;
  text: string;
  char_start: number;
  char_end: number;
  char_count: number;
  estimated_duration_seconds: number;
  duration_seconds: number;
  start_seconds: number;
  priority_band: number;
  priority_label: string;
  priority_reason: string;
  /** Position in the global pending priority order; 0 when not pending. */
  rank: number;
  is_pending: boolean;
  is_rendering: boolean;
  in_next_batch: boolean;
  created_at: number;
  updated_at: number;
  error: string | null;
  versions: QueueChunkVersion[];
}

export interface QueueChunkVersion {
  version: number;
  status: ChunkStatus;
  deprecated: boolean;
}

/** A job plus its full chunk lifecycle, for the admin queue inspector. */
export interface QueueJobGroup {
  job_id: string;
  job_title: string | null;
  job_status: JobStatus;
  job_is_active_listening: boolean;
  job_buffered_seconds: number;
  job_target_buffer_seconds: number;
  model_id: string;
  language: string;
  voice_id: string;
  total_chunks: number;
  written_chunks: number;
  pending_chunks: number;
  failed_chunks: number;
  /** Characters of the source text the planner has not reached yet. */
  unplanned_chars: number;
  chunks_truncated: boolean;
  chunks: QueueChunk[];
}

export interface AdminQueue {
  generated_at: number;
  queue_depth: number;
  active_batch: QueueBatch | null;
  next_batch: QueueBatch | null;
  jobs: QueueJobGroup[];
}

export interface SchedulerState {
  queue_depth: number;
  batch_candidates: number[];
  /** Set while a batch is rendering so the queue view can refresh live. */
  active_batch?: QueueBatch | null;
  /** Liveness of the scheduling loop; a stale tick or error means it is stuck. */
  running?: boolean;
  last_tick_at?: number | null;
  last_error?: string | null;
  consecutive_errors?: number;
  /** Set while dispatch is intentionally paused (e.g. the VRAM hard limit). */
  warning?: string | null;
  /** Measured marginal allocated VRAM per rendered chunk, if known. */
  vram_per_chunk_mb?: number | null;
  /** Model/voice the scheduler is currently committed to (see /api/status). */
  resident_model_id?: string | null;
  resident_voice_id?: string | null;
  model_residency_batches?: number;
  voice_residency_batches?: number;
}

/** Public snapshot of what the GPU is currently committed to. */
export interface RuntimeStatus {
  resident_model_id: string | null;
  resident_voice_id: string | null;
  model_state?: string;
  model_residency_batches: number;
  voice_residency_batches: number;
}

// Re-export types that moved to events.ts to keep existing imports working
export type {
  AdminState,
  TelemetrySnapshot as AdminStateTelemetry,
  WsEnvelope,
} from "./events";
