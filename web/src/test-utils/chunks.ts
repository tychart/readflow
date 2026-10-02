import type { Chunk, ChunkStatus, JobDetail } from "../types/api";

/**
 * Shared reader fixtures.
 *
 * `Chunk.version` defaults to 0 on purpose: the reader only renders chunks whose
 * version matches the active version, and a fixture without one is dropped.
 */
export function buildChunk(index: number, overrides: Partial<Chunk> = {}): Chunk {
  const durationSeconds = overrides.duration_seconds ?? 4;
  return {
    index,
    status: "written" as ChunkStatus,
    duration_seconds: durationSeconds,
    start_seconds: index * durationSeconds,
    plan_version: 1,
    version: 0,
    voice_id: "suzy",
    segment_url: `/api/jobs/job-1/chunks/${index}`,
    peaks_url: null,
    deprecated: false,
    reprocessing: false,
    char_start: index * 20,
    char_end: index * 20 + 19,
    ...overrides,
  };
}

export function buildChunks(count: number, overrides: Partial<Chunk> = {}): Chunk[] {
  return Array.from({ length: count }, (_, index) => buildChunk(index, overrides));
}

export function buildJobDetail(overrides: Partial<JobDetail> = {}): JobDetail {
  const chunks = overrides.chunks ?? buildChunks(2);
  return {
    id: "job-1",
    title: "Reader job",
    status: "paused",
    voice_id: "suzy",
    model_id: "Qwen/Qwen3-TTS-12Hz-0.6B-Base",
    is_active_listening: false,
    total_chunks_emitted: chunks.length,
    total_chunks_completed: chunks.filter((chunk) => chunk.status === "written").length,
    buffered_seconds: chunks.reduce((total, chunk) => total + chunk.duration_seconds, 0),
    completed_seconds: 0,
    source_kind: "text",
    source_text: "Source text for reader fixtures.",
    plan_version: 1,
    chunks,
    failed_reason: null,
    active_chunk_version: {},
    ...overrides,
  };
}
