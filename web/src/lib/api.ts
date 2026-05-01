import type {
  AdminConfig,
  AdminState,
  JobDetail,
  JobManifest,
  JobSummary,
  Voice,
} from "../types/api";

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
  listJobs: () => request<JobSummary[]>("/api/jobs"),
  getJob: (jobId: string) => request<JobDetail>(`/api/jobs/${jobId}`),
  createJob: (formData: FormData) =>
    request<{ job: JobDetail }>("/api/jobs", { method: "POST", body: formData }),
  getManifest: (jobId: string) => request<JobManifest>(`/api/jobs/${jobId}/manifest`),
  activateJob: (jobId: string) => request<JobDetail>(`/api/jobs/${jobId}/activate`, { method: "POST" }),
  pauseJob: (jobId: string) => request<JobDetail>(`/api/jobs/${jobId}/pause`, { method: "POST" }),
  resumeJob: (jobId: string) => request<JobDetail>(`/api/jobs/${jobId}/resume`, { method: "POST" }),
  updateJobVoice: (jobId: string, voiceId: string) =>
    request<JobDetail>(`/api/jobs/${jobId}/voice`, {
      method: "POST",
      body: JSON.stringify({ voice_id: voiceId }),
    }),
  updatePlayback: (jobId: string, currentTimeSeconds: number, isPlaying: boolean) =>
    request<JobDetail>(`/api/jobs/${jobId}/playback`, {
      method: "POST",
      body: JSON.stringify({
        current_time_seconds: currentTimeSeconds,
        is_playing: isPlaying,
      }),
    }),
  listVoices: () => request<Voice[]>("/api/voices"),
  getAdminState: () => request<AdminState>("/api/admin/state"),
  updateAdminConfig: (config: Partial<AdminConfig>) =>
    request<AdminConfig>("/api/admin/config", {
      method: "POST",
      body: JSON.stringify(config),
    }),
  warmModel: () => request<{ status: string }>("/api/admin/model/warm", { method: "POST" }),
  evictModel: () => request<{ status: string }>("/api/admin/model/evict", { method: "POST" }),
};

