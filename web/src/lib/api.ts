import type {
  AdminConfig,
  AdminState,
  JobDetail,
  JobManifest,
  JobSummary,
  Voice,
} from "../types/api";
import { apiPath } from "./transport";

/**
 * API request error with path context for better debugging.
 */
export class ApiError extends Error {
  constructor(
    message: string,
    public readonly path: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/**
 * Makes a fetch request to the API with proper error handling.
 */
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    headers: {
      ...(init?.body instanceof FormData ? {} : { "Content-Type": "application/json" }),
      ...init?.headers,
    },
    ...init,
  });
  if (!response.ok) {
    throw new ApiError(
      `Request failed: ${response.status}`,
      path,
      response.status,
    );
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
  /** Fetches all jobs. */
  listJobs: () => request<JobSummary[]>(apiPath("/jobs")),

  /** Fetches a single job by ID. */
  getJob: (jobId: string) => request<JobDetail>(apiPath(`/jobs/${jobId}`)),

  /** Creates a new job from form data. */
  createJob: (formData: FormData) =>
    request<{ job: JobDetail }>(apiPath("/jobs"), { method: "POST", body: formData }),

  /** Fetches the media manifest for a job. */
  getManifest: (jobId: string) => request<JobManifest>(apiPath(`/jobs/${jobId}/manifest`)),

  /** Activates a job for listening. */
  activateJob: (jobId: string) =>
    request<JobDetail>(apiPath(`/jobs/${jobId}/activate`), { method: "POST" }),

  /** Pauses a job. */
  pauseJob: (jobId: string) =>
    request<JobDetail>(apiPath(`/jobs/${jobId}/pause`), { method: "POST" }),

  /** Resumes a paused job. */
  resumeJob: (jobId: string) =>
    request<JobDetail>(apiPath(`/jobs/${jobId}/resume`), { method: "POST" }),

  /** Updates the voice for future chunks of a job. */
  updateJobVoice: (jobId: string, voiceId: string) =>
    request<JobDetail>(apiPath(`/jobs/${jobId}/voice`), {
      method: "POST",
      body: JSON.stringify({ voice_id: voiceId }),
    }),

  /** Updates playback position. */
  updatePlayback: (jobId: string, currentTimeSeconds: number, isPlaying: boolean) =>
    request<JobDetail>(apiPath(`/jobs/${jobId}/playback`), {
      method: "POST",
      body: JSON.stringify({
        current_time_seconds: currentTimeSeconds,
        is_playing: isPlaying,
      }),
    }),

  /** Downloads the rendered audio for a job. */
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
      throw new ApiError(detail, apiPath(`/jobs/${jobId}/download`), response.status);
    }
    return {
      blob: await response.blob(),
      filename: parseDownloadFilename(
        response.headers.get("content-disposition"),
        `readflow-job-${jobId}.m4a`,
      ),
    };
  },

  /** Lists available voices. */
  listVoices: () => request<Voice[]>(apiPath("/voices")),

  /** Fetches admin state including config, scheduler info, and telemetry. */
  getAdminState: () => request<AdminState>(apiPath("/admin/state")),

  /** Updates admin configuration. */
  updateAdminConfig: (config: Partial<AdminConfig>) =>
    request<AdminConfig>(apiPath("/admin/config"), {
      method: "POST",
      body: JSON.stringify(config),
    }),

  /** Warms the model. */
  warmModel: () => request<{ status: string }>(apiPath("/admin/model/warm"), { method: "POST" }),

  /** Evicts the model from VRAM. */
  evictModel: () =>
    request<{ status: string }>(apiPath("/admin/model/evict"), { method: "POST" }),
};
