import type { Chunk, JobDetail, JobManifest } from "../../types/api";
import type { StreamJob } from "../../types/events";
import type { TimelineSlotData, TimelineSlotState } from "../../types/timeline";
import { deriveActiveVersions, sortChunks, upsertChunk } from "./chunk-utils";

/**
 * Pure reader state derivations.
 *
 * Everything here turns server payloads and chunk lists into the shapes the
 * reader renders. It is deliberately free of React so the trickiest rules
 * (patch merging, the contiguous rendered run, gap classification, slot states)
 * can be unit-tested directly instead of only through a mounted page.
 */

/* ── Stream payloads ──────────────────────────────────────── */

/** Envelope fields carried by streamed job events. */
export interface StreamEventMeta {
  mime_type?: string;
  init_segment_url?: string | null;
}

/** Payload carried by the job events the reader consumes. */
export interface StreamEventPayload extends StreamEventMeta {
  job?: StreamJob;
  chunk?: Chunk;
}

/**
 * Merge a job payload into the loaded detail. Payloads are patches: per-chunk
 * events and play/pause/resume responses carry the summary plus at most one
 * chunk, while `job_updated` still carries full detail. `current` keeps the
 * fields a patch omits (most importantly `source_text`).
 */
export function mergeJobPatch(current: JobDetail, patch: StreamJob, chunk?: Chunk): JobDetail {
  const merged: JobDetail = {
    ...current,
    ...patch,
    chunks: patch.chunks ?? current.chunks,
  };
  return chunk ? { ...merged, chunks: upsertChunk(merged.chunks, chunk) } : merged;
}

/** Rebuild the media manifest from a patch, keeping the fields it omits. */
export function buildManifestFromPatch(
  previousManifest: JobManifest | null,
  patch: StreamJob,
  chunk?: Chunk,
  meta: StreamEventMeta = {},
): JobManifest | null {
  const nextMimeType = meta.mime_type ?? previousManifest?.mime_type ?? null;
  if (!nextMimeType) return null;
  const nextInitSegmentUrl =
    "init_segment_url" in meta
      ? meta.init_segment_url ?? null
      : previousManifest?.init_segment_url ?? null;
  const nextChunks = patch.chunks
    ? sortChunks(patch.chunks)
    : chunk
      ? upsertChunk(previousManifest?.chunks ?? [], chunk)
      : previousManifest?.chunks ?? [];
  return {
    mime_type: nextMimeType,
    init_segment_url: nextInitSegmentUrl,
    chunks: nextChunks,
  } satisfies JobManifest;
}

/** Chunk list the reader knows about: the manifest wins over job detail. */
export function mergeKnownChunks(job: JobDetail | null, manifest: JobManifest | null): Chunk[] {
  if (manifest) return sortChunks(manifest.chunks);
  if (job) return sortChunks(job.chunks);
  return [];
}

/* ── Version resolution ───────────────────────────────────── */

/**
 * Active version per chunk index. `job.active_chunk_version` is authoritative
 * when present; indexes missing from it fall back to the highest version in the
 * chunk list, so a chunk that arrived before the summary is still renderable.
 *
 * The fallback used to be seeded from the *first* chunk seen for an index, so a
 * summary that omitted a multi-version index could select an older version and
 * stream the wrong audio. Max-per-index is both correct and cheaper.
 */
export function deriveActiveVersionMap(
  chunks: Chunk[],
  activeChunkVersion: Record<number, number> | undefined,
): Map<number, number> {
  const versions = new Map<number, number>();
  if (activeChunkVersion) {
    for (const [index, version] of Object.entries(activeChunkVersion)) {
      versions.set(Number(index), version);
    }
  }
  for (const [index, version] of deriveActiveVersions(chunks)) {
    if (!versions.has(index)) versions.set(index, version);
  }
  return versions;
}

/** One chunk per index, keeping only the active version of each. */
export function deriveActiveChunks(
  knownChunks: Chunk[],
  activeVersions: Map<number, number>,
): Chunk[] {
  const active: Chunk[] = [];
  const seen = new Set<number>();
  for (const chunk of knownChunks) {
    if (seen.has(chunk.index)) continue;
    if (chunk.version !== activeVersions.get(chunk.index)) continue;
    active.push(chunk);
    seen.add(chunk.index);
  }
  return active;
}

/* ── Playback model ───────────────────────────────────────── */

/**
 * Everything derived from the anchor + chunk list that the reader, the timeline
 * and the player all agree on. This is the frontend half of the gap-aware
 * playback contract: only the contiguous written run from the anchor can play,
 * later written chunks are visible but not auto-played, and missing chunks are
 * surfaced as expected-but-unavailable.
 */
export interface ReaderPlaybackModel {
  /** Chunks from the playback anchor onward — the current stream's span. */
  anchoredChunks: Chunk[];
  /** Contiguous written run from the anchor: exactly what the stream contains. */
  contiguousReadyChunks: Chunk[];
  /** Indexes in that run that are the active version. */
  activeContiguousReadyIndexes: Set<number>;
  /** First chunk from the anchor that is not written (the gap), if any. */
  expectedNextChunkIndex: number | null;
  /** Written chunks beyond the gap: ready, but never auto-played. */
  writtenAfterGapIndexes: Set<number>;
  /** Expected but neither written nor failed. */
  missingExpectedIndexes: Set<number>;
  /** Contiguous written chunks from the very start — the download range. */
  downloadableChunks: Chunk[];
  /** Total duration of every known chunk (the timeline's known length). */
  knownDurationSeconds: number;
  /** Original-timeline position of the anchor; stream positions are relative to it. */
  anchorOffsetSeconds: number;
}

export function derivePlaybackModel(
  knownChunks: Chunk[],
  activeChunks: Chunk[],
  activeVersions: Map<number, number>,
  playbackAnchorIndex: number,
): ReaderPlaybackModel {
  const anchoredChunks = knownChunks.filter((chunk) => chunk.index >= playbackAnchorIndex);

  const contiguousReadyChunks: Chunk[] = [];
  for (const chunk of anchoredChunks) {
    if (chunk.status !== "written") break;
    contiguousReadyChunks.push(chunk);
  }

  const activeContiguousReadyIndexes = new Set<number>();
  for (const chunk of contiguousReadyChunks) {
    if (chunk.version === activeVersions.get(chunk.index)) {
      activeContiguousReadyIndexes.add(chunk.index);
    }
  }

  const expectedNextChunkIndex =
    activeChunks.find((chunk) => chunk.status !== "written")?.index ?? null;

  const writtenAfterGapIndexes = new Set<number>();
  const missingExpectedIndexes = new Set<number>();
  const gapBoundary = expectedNextChunkIndex ?? Number.POSITIVE_INFINITY;
  for (const chunk of activeChunks) {
    if (chunk.status !== "written" && chunk.status !== "failed") {
      missingExpectedIndexes.add(chunk.index);
    }
    if (chunk.index >= gapBoundary && chunk.status === "written") {
      writtenAfterGapIndexes.add(chunk.index);
    }
  }

  const downloadableChunks: Chunk[] = [];
  for (const chunk of knownChunks) {
    if (chunk.index !== downloadableChunks.length || chunk.status !== "written" || !chunk.segment_url) {
      break;
    }
    downloadableChunks.push(chunk);
  }

  let knownDurationSeconds = 0;
  let anchorOffsetSeconds = 0;
  for (const chunk of knownChunks) {
    knownDurationSeconds += chunk.duration_seconds;
    if (chunk.index < playbackAnchorIndex) anchorOffsetSeconds += chunk.duration_seconds;
  }

  return {
    anchoredChunks,
    contiguousReadyChunks,
    activeContiguousReadyIndexes,
    expectedNextChunkIndex,
    writtenAfterGapIndexes,
    missingExpectedIndexes,
    downloadableChunks,
    knownDurationSeconds,
    anchorOffsetSeconds,
  };
}

/**
 * Rewrite the stream sent to the player so it starts at the anchor: the media
 * element's clock resets to 0 at the anchor, so `start_seconds` must be
 * renumbered from there. This is why player positions are stream-normalized and
 * must be shifted by the anchor offset before they reach the timeline.
 */
export function buildStreamManifest(
  fullManifest: JobManifest | null,
  contiguousReadyChunks: Chunk[],
): JobManifest | null {
  if (!fullManifest) return null;
  let runningStart = 0;
  const normalizedChunks = contiguousReadyChunks.map((chunk) => {
    const normalized = { ...chunk, start_seconds: runningStart };
    runningStart += chunk.duration_seconds;
    return normalized;
  });
  return {
    mime_type: fullManifest.mime_type,
    init_segment_url: fullManifest.init_segment_url,
    chunks: normalizedChunks,
  };
}

/**
 * Start of a chunk in original timeline coordinates: the sum of every active
 * chunk before it. Jump-to-chunk seeks use this, and the player converts it to
 * stream coordinates via the anchor offset.
 */
export function chunkStartSeconds(activeChunks: Chunk[], chunkIndex: number): number {
  let start = 0;
  for (const chunk of activeChunks) {
    if (chunk.index >= chunkIndex) break;
    start += chunk.duration_seconds;
  }
  return start;
}

/* ── Playback progress ────────────────────────────────────── */

export interface ActiveChunkProgress {
  activeChunkIndex: number | null;
  /** 0..100 fill per chunk index. */
  fillByIndex: Map<number, number>;
  playedIndexes: Set<number>;
}

/**
 * Map a stream-normalized playhead onto the contiguous ready run.
 *
 * `currentTimeSeconds` is stream-normalized (0 at the playback anchor), while
 * `contiguousReadyChunks` are in the same order the player plays them, so this
 * needs no anchor conversion — unlike everything that reaches the timeline.
 */
export function deriveActiveChunkProgress(
  contiguousReadyChunks: Chunk[],
  currentTimeSeconds: number,
): ActiveChunkProgress {
  const fillByIndex = new Map<number, number>();
  const playedIndexes = new Set<number>();
  let remaining = Math.max(0, currentTimeSeconds);
  let activeChunkIndex: number | null = null;
  for (const chunk of contiguousReadyChunks) {
    if (remaining >= chunk.duration_seconds) {
      fillByIndex.set(chunk.index, 100);
      playedIndexes.add(chunk.index);
      remaining -= chunk.duration_seconds;
      continue;
    }
    fillByIndex.set(
      chunk.index,
      chunk.duration_seconds > 0 ? (remaining / chunk.duration_seconds) * 100 : 0,
    );
    activeChunkIndex = chunk.index;
    break;
  }
  return { activeChunkIndex, fillByIndex, playedIndexes };
}

/**
 * Clamp a relative skip into the playable range. Skipping past the end of the
 * rendered stream lands on the last playable position, which is what puts the
 * player into its waiting state instead of seeking into audio that does not
 * exist yet.
 */
export function skipTargetSeconds(
  currentSeconds: number,
  deltaSeconds: number,
  renderedDurationSeconds: number,
): number {
  return Math.min(Math.max(0, currentSeconds + deltaSeconds), renderedDurationSeconds);
}

/* ── Timeline slots ───────────────────────────────────────── */

/**
 * Slot state for every active chunk, in original job-timeline coordinates.
 *
 * Branch order matters: failed beats playing beats played beats the various
 * ready states, and anything neither written nor failed renders as
 * expected-but-missing.
 */
export function deriveTimelineSlots(
  activeChunks: Chunk[],
  model: Pick<
    ReaderPlaybackModel,
    "activeContiguousReadyIndexes" | "writtenAfterGapIndexes" | "missingExpectedIndexes"
  >,
  activeProgress: ActiveChunkProgress,
  playbackAnchorIndex: number,
): TimelineSlotData[] {
  return activeChunks.map((chunk) => {
    let state: TimelineSlotState;
    if (chunk.status === "failed" || chunk.status === "max_retries_exceeded") {
      state = "failed";
    } else if (activeProgress.activeChunkIndex === chunk.index) {
      state = "playing";
    } else if (activeProgress.playedIndexes.has(chunk.index)) {
      state = "played";
    } else if (chunk.index < playbackAnchorIndex && chunk.status === "written") {
      state = "ready";
    } else if (model.activeContiguousReadyIndexes.has(chunk.index)) {
      state = "ready";
    } else if (model.writtenAfterGapIndexes.has(chunk.index)) {
      state = "ready_after_gap";
    } else if (model.missingExpectedIndexes.has(chunk.index)) {
      state = "missing_expected";
    } else if (chunk.status === "written") {
      state = "ready";
    } else {
      state = "missing_expected";
    }

    return {
      chunkIndex: chunk.index,
      state,
      durationSeconds: chunk.duration_seconds > 0 ? chunk.duration_seconds : 4,
    };
  });
}
