import { create } from "zustand";

import type {
  AdminState,
  JobDetail,
  JobSummary,
  Voice,
  WebSocketStatus,
  WsEnvelope,
} from "../types/api";

interface AppStore {
  jobs: JobSummary[];
  voices: Voice[];
  adminState: AdminState | null;
  websocketStatus: WebSocketStatus;
  lastSocketMessageAt: number | null;
  lastSocketError: string | null;
  reconnectAttempt: number;
  isSocketStale: boolean;
  lastEvent: WsEnvelope | null;
  setJobs: (jobs: JobSummary[]) => void;
  setVoices: (voices: Voice[]) => void;
  setAdminState: (adminState: AdminState) => void;
  setSocketState: (state: {
    status?: AppStore["websocketStatus"];
    lastMessageAt?: number | null;
    error?: string | null;
    reconnectAttempt?: number;
    isStale?: boolean;
  }) => void;
  applyEvent: (event: WsEnvelope) => void;
}

function upsertJob(jobs: JobSummary[], nextJob: JobSummary): JobSummary[] {
  const remaining = jobs.filter((job) => job.id !== nextJob.id);
  return [nextJob, ...remaining];
}

function isAdminConfigPayload(payload: unknown): payload is AdminState["config"] {
  if (typeof payload !== "object" || payload === null) {
    return false;
  }

  const candidate = payload as Record<string, unknown>;
  return (
    typeof candidate.idle_unload_seconds === "number" &&
    typeof candidate.max_prebuffer_seconds === "number" &&
    typeof candidate.target_buffer_seconds === "number" &&
    Array.isArray(candidate.batch_candidates_small_model) &&
    Array.isArray(candidate.batch_candidates_large_model) &&
    typeof candidate.vram_soft_limit_mb === "number" &&
    typeof candidate.vram_hard_limit_mb === "number"
  );
}

function toSummary(job: JobDetail): JobSummary {
  const {
    id,
    title,
    status,
    voice_id,
    model_id,
    is_active_listening,
    total_chunks_emitted,
    total_chunks_completed,
    buffered_seconds,
    completed_seconds,
  } = job;
  return {
    id,
    title,
    status,
    voice_id,
    model_id,
    is_active_listening,
    total_chunks_emitted,
    total_chunks_completed,
    buffered_seconds,
    completed_seconds,
  };
}

export const useAppStore = create<AppStore>((set) => ({
  jobs: [],
  voices: [],
  adminState: null,
  websocketStatus: "connecting",
  lastSocketMessageAt: null,
  lastSocketError: null,
  reconnectAttempt: 0,
  isSocketStale: false,
  lastEvent: null,
  setJobs: (jobs) => set({ jobs }),
  setVoices: (voices) => set({ voices }),
  setAdminState: (adminState) => set({ adminState }),
  setSocketState: ({ status, lastMessageAt, error, reconnectAttempt, isStale }) =>
    set((state) => ({
      websocketStatus: status ?? state.websocketStatus,
      lastSocketMessageAt:
        lastMessageAt === undefined ? state.lastSocketMessageAt : lastMessageAt,
      lastSocketError: error === undefined ? state.lastSocketError : error,
      reconnectAttempt:
        reconnectAttempt === undefined ? state.reconnectAttempt : reconnectAttempt,
      isSocketStale: isStale === undefined ? state.isSocketStale : isStale,
    })),
  applyEvent: (event) =>
    set((state) => {
      if (
        event.type === "job_created" ||
        event.type === "job_updated" ||
        event.type === "job_completed" ||
        event.type === "chunk_ready"
      ) {
        const job = event.payload.job as JobDetail | undefined;
        if (job) {
          return {
            jobs: upsertJob(state.jobs, toSummary(job)),
            lastEvent: event,
          };
        }
      }

      if (event.type === "telemetry" && state.adminState) {
        return {
          adminState: {
            ...state.adminState,
            telemetry: event.payload.telemetry as AdminState["telemetry"],
          },
          lastEvent: event,
        };
      }

      if (event.type === "admin_config_updated" && state.adminState) {
        const nextConfig = isAdminConfigPayload(event.payload)
          ? event.payload
          : state.adminState.config;
        return {
          adminState: {
            ...state.adminState,
            config: nextConfig,
          },
          lastEvent: event,
        };
      }

      if (event.type === "scheduler_state" && state.adminState) {
        return {
          adminState: {
            ...state.adminState,
            scheduler: event.payload as unknown as AdminState["scheduler"],
          },
          lastEvent: event,
        };
      }

      if (event.type === "model_state" && state.adminState) {
        return {
          adminState: {
            ...state.adminState,
            telemetry: {
              ...state.adminState.telemetry,
              model_state: String(event.payload.state ?? state.adminState.telemetry.model_state),
            },
          },
          lastEvent: event,
        };
      }

      return { lastEvent: event };
    }),
}));
