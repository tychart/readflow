import type { Chunk } from "../types/api";

/**
 * A chunk counts as heard once real playback crosses ~90% of it.
 *
 * Deliberately additive (the caller owns the set) and deliberately position-
 * driven: seeking over a chunk never marks it, because the caller only runs
 * this while audio is actually playing and no seek is pending.
 */
export function collectHeardChunkIndexes(
  chunks: readonly Chunk[],
  positionSeconds: number,
  into: Set<number>,
): void {
  for (const chunk of chunks) {
    if (chunk.status !== "written" || chunk.duration_seconds <= 0) continue;
    const threshold = chunk.start_seconds + chunk.duration_seconds * 0.9;
    if (positionSeconds >= threshold) into.add(chunk.index);
  }
}
