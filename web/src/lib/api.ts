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

function parseDownloadFilename(contentDisposition: string | null, fallback: string) {
  if (!contentDisposition) {
    return fallback;
  }
  const utf8Match = contentDisposition.match(/filename\*=UTF-8''([^;]+)/i);
  if (utf8Match?.[1]) {
    return decodeURIComponent(utf8Match[1]);
  }
  const quotedMatch = contentDisposition.match(/filename="([^"]+)"/i);
  if (quotedMatch?.[1]) {
    return quotedMatch[1];
  }
  return fallback;
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
  downloadJobAudio: async (jobId: string) => {
    const response = await fetch(apiPath(`/jobs/${jobId}/download`));
    if (!response.ok) {
      let detail = `Request failed: ${response.status}`;
      try {
        const payload = (await response.json()) as { detail?: string };
        if (payload.detail) {
          detail = payload.detail;
        }
      } catch {
        // Ignore non-JSON error bodies and keep the status-based fallback.
      }
      throw new Error(detail);
    }
    return {
      blob: await response.blob(),
      filename: parseDownloadFilename(
        response.headers.get("content-disposition"),
        `readflow-job-${jobId}.m4a`,
      ),
    };
  },
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
