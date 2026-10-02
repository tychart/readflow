import type { AdminConfig, Chunk, JobDetail, JobSummary, SchedulerState } from "./api";

export type { AdminConfig, JobDetail, JobSummary, SchedulerState } from "./api";

/**
 * Live-connection state.
 *
 * `idle` is the honest default: the socket is only opened when something needs
 * it (the jobs page watches live jobs, the reader watches non-terminal jobs),
 * so "no connection and none wanted" is a real state — not `connecting`, which
 * would claim an attempt that never happened.
 */
export type WebSocketStatus = "idle" | "connecting" | "open" | "reconnecting" | "error";

/**
 * Job fields carried by live events and by mutations that cannot change the
 * document (play / pause / resume).
 *
 * `job_updated` still ships full detail, but per-chunk events and the playback
 * transitions send only the summary: re-sending `source_text` and every chunk
 * record on each event made streaming a book quadratic in WebSocket traffic.
 * Treat the fields outside `JobSummary` as optional patches and merge them into
 * the detail the reader loaded over HTTP.
 */
export type StreamJob = JobSummary & Partial<Omit<JobDetail, keyof JobSummary>>;

export function hasFullDetail(job: StreamJob): job is JobDetail {
  return Array.isArray(job.chunks) && typeof job.source_text === "string";
}

export interface JobPayload {
  job: StreamJob;
}

export interface ChunkReadyPayload extends JobPayload {
  /** The chunk this event is about: per-chunk events are deltas. */
  chunk?: Chunk;
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

export type AdminMemoryStats = {
  device: string;
  vram_total_mb: number;
  vram_used_mb: number;
  vram_reserved_mb: number;
  vram_free_mb: number;
  ram_total_mb: number;
  ram_free_mb: number;
  ram_used_mb: number;
};

export type AdminState = {
  config: AdminConfig;
  scheduler: SchedulerState;
  telemetry: TelemetrySnapshot | null;
  memory: AdminMemoryStats | null;
};

export interface AdminMemoryStatsPayload {
  memory: AdminMemoryStats;
}

export type WsEnvelope =
  | { type: "job_created"; payload: JobPayload }
  | { type: "job_updated"; payload: JobPayload }
  | { type: "job_completed"; payload: JobPayload }
  | { type: "chunk_ready"; payload: ChunkReadyPayload }
  | { type: "scheduler_state"; payload: SchedulerState }
  | { type: "model_state"; payload: ModelStatePayload }
  | { type: "telemetry"; payload: TelemetryPayload }
  | { type: "admin_config_updated"; payload: AdminConfig }
  | { type: "memory_stats"; payload: AdminMemoryStatsPayload }
  | { type: "pong"; payload: null };
