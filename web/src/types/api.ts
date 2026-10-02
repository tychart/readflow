export type JobStatus = "queued" | "rendering" | "paused" | "playing" | "completed" | "failed";
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

export interface JobSummary {
  id: string;
  title: string | null;
  status: JobStatus;
  voice_id: string;
  model_id: string;
  is_active_listening: boolean;
  total_chunks_emitted: number;
  total_chunks_completed: number;
  buffered_seconds: number;
  completed_seconds: number;
}

export interface JobDetail extends JobSummary {
  source_kind: string;
  source_text: string;
  plan_version: number;
  chunks: Chunk[];
  failed_reason: string | null;
  active_chunk_version: Record<number, number>;
}

export interface JobManifest {
  mime_type: string;
  init_segment_url: string | null;
  chunks: Chunk[];
}

export interface Voice {
  id: string;
  display_name: string;
  description: string | null;
}

export interface AdminConfig {
  device: string;
  idle_unload_seconds: number;
  max_prebuffer_seconds: number;
  target_buffer_seconds: number;
  batch_candidates_small_model: number[];
  batch_candidates_large_model: number[];
  vram_soft_limit_mb: number;
  vram_hard_limit_mb: number;
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
  priority_band: number;
  priority_label: string;
  priority_reason: string;
  rank: number;
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

export interface AdminQueue {
  generated_at: number;
  queue_depth: number;
  active_batch: QueueBatch | null;
  next_batch: QueueBatch | null;
  items: QueueChunk[];
}

export interface SchedulerState {
  queue_depth: number;
  batch_candidates: number[];
  /** Set while a batch is rendering so the queue view can refresh live. */
  active_batch?: QueueBatch | null;
}

// Re-export types that moved to events.ts to keep existing imports working
export type { AdminState, TelemetrySnapshot as AdminStateTelemetry } from "./events";
export type { WsEnvelope } from "./events";
