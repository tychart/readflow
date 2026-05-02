export type JobStatus = "queued" | "rendering" | "paused" | "playing" | "completed" | "failed";
export type ChunkStatus = "planned" | "queued" | "rendering" | "written" | "stale" | "failed";
export type WebSocketStatus = "connecting" | "open" | "reconnecting" | "closed" | "error";

export interface Chunk {
  index: number;
  status: ChunkStatus;
  duration_seconds: number;
  start_seconds: number;
  plan_version: number;
  voice_id: string;
  segment_url: string | null;
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
  idle_unload_seconds: number;
  max_prebuffer_seconds: number;
  target_buffer_seconds: number;
  batch_candidates_small_model: number[];
  batch_candidates_large_model: number[];
  vram_soft_limit_mb: number;
  vram_hard_limit_mb: number;
}

export interface SchedulerState {
  queue_depth: number;
  batch_candidates: number[];
}

export interface AdminState {
  config: AdminConfig;
  scheduler: SchedulerState;
  telemetry: {
    queue_depth: number;
    model_state: string;
    idle_deadline: number | null;
    oom_count: number;
    recent_batches: Array<{
      batch_size: number;
      duration_seconds: number;
      reserved_vram_mb: number;
      allocated_vram_mb: number;
      at: number;
    }>;
    recent_events: Array<{
      type: string;
      payload: Record<string, unknown>;
      at: number;
    }>;
  };
}

export interface WsEnvelope {
  type:
    | "job_created"
    | "job_updated"
    | "job_completed"
    | "chunk_ready"
    | "scheduler_state"
    | "model_state"
    | "telemetry"
    | "admin_config_updated"
    | "pong";
  payload: Record<string, unknown>;
}
