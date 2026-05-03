import type {
  AdminConfig,
  AdminState,
  JobDetail,
  JobManifest,
  JobSummary,
  Voice,
} from "../types/api";
import { apiPath } from "./transport";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    headers: {
      ...(init?.body instanceof FormData ? {} : { "Content-Type": "application/json" }),
      ...init?.headers,
    },
    ...init,
  });
  if (!response.ok) {
    throw new Error(`Request failed: ${response.status}`);
  }
  if (response.status === 204) {
    return undefined as T;
  }
  return (await response.json()) as T;
}

export const api = {
  listJobs: () => request<JobSummary[]>(apiPath("/jobs")),
  getJob: (jobId: string) => request<JobDetail>(apiPath(`/jobs/${jobId}`)),
  createJob: (formData: FormData) =>
    request<{ job: JobDetail }>(apiPath("/jobs"), { method: "POST", body: formData }),
  getManifest: (jobId: string) => request<JobManifest>(apiPath(`/jobs/${jobId}/manifest`)),
  activateJob: (jobId: string) =>
    request<JobDetail>(apiPath(`/jobs/${jobId}/activate`), { method: "POST" }),
  pauseJob: (jobId: string) =>
    request<JobDetail>(apiPath(`/jobs/${jobId}/pause`), { method: "POST" }),
  resumeJob: (jobId: string) =>
    request<JobDetail>(apiPath(`/jobs/${jobId}/resume`), { method: "POST" }),
  updateJobVoice: (jobId: string, voiceId: string) =>
    request<JobDetail>(apiPath(`/jobs/${jobId}/voice`), {
      method: "POST",
      body: JSON.stringify({ voice_id: voiceId }),
    }),
  updatePlayback: (jobId: string, currentTimeSeconds: number, isPlaying: boolean) =>
    request<JobDetail>(apiPath(`/jobs/${jobId}/playback`), {
      method: "POST",
      body: JSON.stringify({
        current_time_seconds: currentTimeSeconds,
        is_playing: isPlaying,
      }),
    }),
  listVoices: () => request<Voice[]>(apiPath("/voices")),
  getAdminState: () => request<AdminState>(apiPath("/admin/state")),
  updateAdminConfig: (config: Partial<AdminConfig>) =>
    request<AdminConfig>(apiPath("/admin/config"), {
      method: "POST",
      body: JSON.stringify(config),
    }),
  warmModel: () => request<{ status: string }>(apiPath("/admin/model/warm"), { method: "POST" }),
  evictModel: () =>
    request<{ status: string }>(apiPath("/admin/model/evict"), { method: "POST" }),
};
