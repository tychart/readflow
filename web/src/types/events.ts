import type { AdminConfig, JobDetail, SchedulerState } from "./api";

export type { AdminConfig, JobDetail, JobSummary, SchedulerState } from "./api";

export interface JobPayload {
  job: JobDetail;
}

export interface ChunkReadyPayload extends JobPayload {
  chunk_index: number;
  mime_type?: string;
  init_segment_url?: string | null;
}

export interface TelemetryPayload {
  telemetry: TelemetrySnapshot;
}

export interface ModelStatePayload {
  state: string;
}

export type TelemetrySnapshot = {
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

export type AdminStateTelemetry = TelemetrySnapshot;

export type AdminState = {
  config: AdminConfig;
  scheduler: SchedulerState;
  telemetry: TelemetrySnapshot | null;
};

export type WsEnvelope =
  | { type: "job_created"; payload: JobPayload }
  | { type: "job_updated"; payload: JobPayload }
  | { type: "job_completed"; payload: JobPayload }
  | { type: "chunk_ready"; payload: ChunkReadyPayload }
  | { type: "scheduler_state"; payload: SchedulerState }
  | { type: "model_state"; payload: ModelStatePayload }
  | { type: "telemetry"; payload: TelemetryPayload }
  | { type: "admin_config_updated"; payload: AdminConfig }
  | { type: "pong"; payload: null };
