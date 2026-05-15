import { create } from "zustand";

import type { Voice } from "../types/api";
import type {
  AdminState,
  JobDetail,
  JobSummary,
  WsEnvelope,
} from "../types/events";

interface AppStore {
  jobs: Record<string, JobSummary>;
  voices: Voice[];
  adminState: AdminState | null;
  websocketStatus: "connecting" | "open" | "reconnecting" | "closed" | "error";
  lastSocketMessageAt: number | null;
  lastSocketError: string | null;
  reconnectAttempt: number;
  isSocketStale: boolean;
  lastEvent: WsEnvelope | null;
  setJobs: (jobs: Record<string, JobSummary>) => void;
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

function toSummary(job: JobDetail): JobSummary {
  return {
    id: job.id,
    title: job.title,
    status: job.status,
    voice_id: job.voice_id,
    model_id: job.model_id,
    is_active_listening: job.is_active_listening,
    total_chunks_emitted: job.total_chunks_emitted,
    total_chunks_completed: job.total_chunks_completed,
    buffered_seconds: job.buffered_seconds,
    completed_seconds: job.completed_seconds,
  };
}

export const useAppStore = create<AppStore>((set) => ({
  jobs: {},
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
    set((state) => {
      const newState = { ...state };
      let changed = false;

      if (status !== undefined && status !== state.websocketStatus) {
        newState.websocketStatus = status;
        changed = true;
      }
      if (lastMessageAt !== undefined && lastMessageAt !== state.lastSocketMessageAt) {
        newState.lastSocketMessageAt = lastMessageAt;
        changed = true;
      }
      if (error !== undefined && error !== state.lastSocketError) {
        newState.lastSocketError = error;
        changed = true;
      }
      if (reconnectAttempt !== undefined && reconnectAttempt !== state.reconnectAttempt) {
        newState.reconnectAttempt = reconnectAttempt;
        changed = true;
      }
      if (isStale !== undefined && isStale !== state.isSocketStale) {
        newState.isSocketStale = isStale;
        changed = true;
      }

      return changed ? newState : state;
    }),
  applyEvent: (event) =>
    set((state) => {
      if (
        event.type === "job_created" ||
        event.type === "job_updated" ||
        event.type === "job_completed" ||
        event.type === "chunk_ready"
      ) {
        return {
          jobs: { ...state.jobs, [event.payload.job.id]: toSummary(event.payload.job) },
          lastEvent: event,
        };
      }

      if (event.type === "telemetry" && state.adminState) {
        return {
          adminState: {
            ...state.adminState,
            telemetry: event.payload.telemetry,
          },
          lastEvent: event,
        };
      }

      if (event.type === "admin_config_updated" && state.adminState) {
        return {
          adminState: {
            ...state.adminState,
            config: event.payload,
          },
          lastEvent: event,
        };
      }

      if (event.type === "scheduler_state" && state.adminState) {
        return {
          adminState: {
            ...state.adminState,
            scheduler: event.payload,
          },
          lastEvent: event,
        };
      }

      if (event.type === "model_state" && state.adminState) {
        const telemetry = state.adminState.telemetry;
        return {
          adminState: {
            ...state.adminState,
            telemetry: telemetry
              ? { ...telemetry, model_state: event.payload.state }
              : null,
          },
          lastEvent: event,
        };
      }

      return state;
    }),
}));
