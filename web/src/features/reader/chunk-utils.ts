import type { Chunk, ChunkStatus, JobStatus } from "../../types/api";

/**
 * Pure chunk/version helpers shared by the reader page, its sidebar and the
 * admin surface. These used to be duplicated (or re-implemented inside tests),
 * which meant a change to one copy could silently diverge from the other.
 */

/** Job statuses after which no further chunks will be produced. */
export const TERMINAL_JOB_STATUSES: readonly JobStatus[] = ["completed", "failed"];

export function isTerminalStatus(status: JobStatus | undefined): boolean {
  return status ? TERMINAL_JOB_STATUSES.includes(status) : false;
}

/** Chunks in timeline order. */
export function sortChunks(chunks: readonly Chunk[]): Chunk[] {
  return [...chunks].sort((left, right) => left.index - right.index);
}

/** Insert or replace a chunk by (index, version), keeping timeline order. */
export function upsertChunk(chunks: Chunk[], incoming: Chunk): Chunk[] {
  const next = chunks.filter(
    (chunk) => !(chunk.index === incoming.index && chunk.version === incoming.version),
  );
  next.push(incoming);
  return sortChunks(next);
}

/** Highest version recorded per chunk index. */
export function deriveActiveVersions(chunks: Chunk[]): Map<number, number> {
  const versions = new Map<number, number>();
  for (const chunk of chunks) {
    const existing = versions.get(chunk.index);
    if (existing === undefined || chunk.version > existing) {
      versions.set(chunk.index, chunk.version);
    }
  }
  return versions;
}

/** Highest version recorded for one chunk index, or -1 when the index is absent. */
export function getLatestVersion(chunks: Chunk[], index: number): number {
  let max = -1;
  for (const chunk of chunks) {
    if (chunk.index === index && chunk.version > max) max = chunk.version;
  }
  return max;
}

/** Attempt counter shown next to reprocess/retry; the version doubles as it. */
export function getRetryCount(status: ChunkStatus, version: number): number {
  if (status === "max_retries_exceeded") return 3;
  return version;
}

/**
 * Chunk text as the reader displays it. `source_text` is already canonical (the
 * backend normalizes once at job creation) and offsets index into it, so this
 * is a plain slice — normalizing here used to re-filter the whole document for
 * every chunk on every render.
 */
export function getChunkText(
  chunk: Pick<Chunk, "char_start" | "char_end">,
  sourceText: string,
): string {
  return sourceText.slice(chunk.char_start, chunk.char_end).trim();
}
