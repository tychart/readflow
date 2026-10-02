import { describe, expect, test } from "vitest";

import type { JobManifest } from "../../types/api";
import { buildChunk, buildChunks, buildJobDetail } from "../../test-utils/chunks";
import {
  buildManifestFromPatch,
  buildStreamManifest,
  deriveActiveChunkProgress,
  deriveActiveChunks,
  deriveActiveVersionMap,
  derivePlaybackModel,
  deriveTimelineSlots,
  mergeJobPatch,
  mergeKnownChunks,
} from "./reader-model";

/* ── Fixtures ─────────────────────────────────────────────── */

function buildManifest(chunks = buildChunks(2)): JobManifest {
  return {
    mime_type: 'audio/mp4; codecs="mp4a.40.2"',
    init_segment_url: "/api/jobs/job-1/chunks/init",
    chunks,
  };
}

function versionsFor(chunks: ReturnType<typeof buildChunks>): Map<number, number> {
  return new Map(chunks.map((chunk) => [chunk.index, chunk.version]));
}

/* ── Patch merging ────────────────────────────────────────── */

describe("mergeJobPatch", () => {
  test("keeps fields a summary patch omits, including the source text", () => {
    const current = buildJobDetail({ source_text: "the whole book", chunks: buildChunks(2) });
    const merged = mergeJobPatch(current, { id: "job-1", status: "playing" } as never);
    expect(merged.source_text).toBe("the whole book");
    expect(merged.chunks).toHaveLength(2);
    expect(merged.status).toBe("playing");
  });

  test("applies a single chunk delta without dropping the other chunks", () => {
    const current = buildJobDetail({ chunks: buildChunks(3) });
    const merged = mergeJobPatch(
      current,
      { id: "job-1", status: "playing" } as never,
      buildChunk(1, { duration_seconds: 9 }),
    );
    expect(merged.chunks.map((chunk) => chunk.duration_seconds)).toEqual([4, 9, 4]);
  });

  test("full detail in the patch replaces the chunk list", () => {
    const current = buildJobDetail({ chunks: buildChunks(3) });
    const merged = mergeJobPatch({ ...current, chunks: undefined } as never, {
      ...current,
      chunks: buildChunks(1),
    });
    expect(merged.chunks).toHaveLength(1);
  });
});

describe("buildManifestFromPatch", () => {
  test("returns null until a mime type is known", () => {
    expect(buildManifestFromPatch(null, { id: "job-1" } as never)).toBeNull();
  });

  test("carries the previous mime type and init segment over an unrelated patch", () => {
    const next = buildManifestFromPatch(buildManifest(), { id: "job-1" } as never);
    expect(next?.mime_type).toBe('audio/mp4; codecs="mp4a.40.2"');
    expect(next?.init_segment_url).toBe("/api/jobs/job-1/chunks/init");
  });

  test("an explicitly null init segment clears the previous one", () => {
    const next = buildManifestFromPatch(buildManifest(), { id: "job-1" } as never, undefined, {
      init_segment_url: null,
    });
    expect(next?.init_segment_url).toBeNull();
  });

  test("upserts a chunk delta into the manifest chunk list", () => {
    const next = buildManifestFromPatch(buildManifest(buildChunks(3)), { id: "job-1" } as never, {
      ...buildChunk(1),
      segment_url: "/api/jobs/job-1/chunks/1?v=2",
    });
    expect(next?.chunks).toHaveLength(3);
    expect(next?.chunks[1]?.segment_url).toBe("/api/jobs/job-1/chunks/1?v=2");
  });
});

describe("mergeKnownChunks", () => {
  test("the manifest wins over job detail", () => {
    const job = buildJobDetail({ chunks: buildChunks(1) });
    expect(mergeKnownChunks(job, buildManifest(buildChunks(4)))).toHaveLength(4);
  });

  test("falls back to job detail without a manifest", () => {
    expect(mergeKnownChunks(buildJobDetail({ chunks: buildChunks(3) }), null)).toHaveLength(3);
  });

  test("returns nothing without either source", () => {
    expect(mergeKnownChunks(null, null)).toEqual([]);
  });
});

/* ── Version resolution ───────────────────────────────────── */

describe("deriveActiveVersionMap", () => {
  test("active_chunk_version is authoritative", () => {
    const chunks = [buildChunk(0, { version: 1 }), buildChunk(1, { version: 3 })];
    const versions = deriveActiveVersionMap(chunks, { 1: 0 });
    expect(versions.get(0)).toBe(1);
    expect(versions.get(1)).toBe(0);
  });

  test("indexes missing from the summary fall back to their highest version", () => {
    const chunks = [buildChunk(0, { version: 1 }), buildChunk(0, { version: 5 })];
    expect(deriveActiveVersionMap(chunks, {})?.get(0)).toBe(5);
    expect(deriveActiveVersionMap(chunks, undefined).get(0)).toBe(5);
  });
});

describe("deriveActiveChunks", () => {
  test("keeps one active version per index, in order", () => {
    const chunks = [
      buildChunk(0, { version: 0 }),
      buildChunk(0, { version: 1 }),
      buildChunk(1, { version: 0 }),
    ];
    const active = deriveActiveChunks(chunks, new Map([[0, 1], [1, 0]]));
    expect(active.map((chunk) => [chunk.index, chunk.version])).toEqual([[0, 1], [1, 0]]);
  });

  test("drops indexes with no active version", () => {
    expect(deriveActiveChunks([buildChunk(0)], new Map())).toEqual([]);
  });
});

/* ── Playback model ───────────────────────────────────────── */

describe("derivePlaybackModel", () => {
  const known = [
    buildChunk(0),
    buildChunk(1),
    buildChunk(2),
    buildChunk(3, { status: "queued", segment_url: null, duration_seconds: 0 }),
    buildChunk(4),
    buildChunk(5, { status: "rendering", segment_url: null, duration_seconds: 0 }),
  ];

  test("the contiguous run stops at the first chunk that is not written", () => {
    const model = derivePlaybackModel(known, known, versionsFor(known), 0);
    expect(model.contiguousReadyChunks.map((chunk) => chunk.index)).toEqual([0, 1, 2]);
    expect(model.expectedNextChunkIndex).toBe(3);
  });

  test("written chunks past the gap are ready but never auto-played", () => {
    const model = derivePlaybackModel(known, known, versionsFor(known), 0);
    expect([...model.writtenAfterGapIndexes]).toEqual([4]);
    expect([...model.missingExpectedIndexes].sort()).toEqual([3, 5]);
  });

  test("failed chunks are neither missing-expected nor written-after-gap", () => {
    const withFailure = [...known.slice(0, 3), buildChunk(3, { status: "failed" }), ...known.slice(4)];
    const model = derivePlaybackModel(withFailure, withFailure, versionsFor(withFailure), 0);
    expect(model.missingExpectedIndexes.has(3)).toBe(false);
    expect(model.expectedNextChunkIndex).toBe(3);
  });

  test("the download range requires contiguous written chunks with segments", () => {
    const model = derivePlaybackModel(known, known, versionsFor(known), 0);
    expect(model.downloadableChunks.map((chunk) => chunk.index)).toEqual([0, 1, 2]);

    const noSegment = [buildChunk(0), buildChunk(1, { segment_url: null }), buildChunk(2)];
    expect(
      derivePlaybackModel(noSegment, noSegment, versionsFor(noSegment), 0).downloadableChunks.map(
        (chunk) => chunk.index,
      ),
    ).toEqual([0]);
  });

  test("the anchor bounds the run and yields the timeline offset", () => {
    const model = derivePlaybackModel(known, known, versionsFor(known), 2);
    expect(model.anchoredChunks.map((chunk) => chunk.index)).toEqual([2, 3, 4, 5]);
    expect(model.contiguousReadyChunks.map((chunk) => chunk.index)).toEqual([2]);
    expect(model.anchorOffsetSeconds).toBe(8);
  });

  test("totals the known timeline duration", () => {
    expect(derivePlaybackModel(known, known, versionsFor(known), 0).knownDurationSeconds).toBe(
      4 + 4 + 4 + 0 + 4 + 0,
    );
  });

  test("only the active version counts as part of the playable run", () => {
    const stale = [buildChunk(0, { version: 0 }), buildChunk(1, { version: 0 })];
    const model = derivePlaybackModel(stale, stale, new Map([[0, 1]]), 0);
    expect([...model.activeContiguousReadyIndexes]).toEqual([]);
  });
});

describe("buildStreamManifest", () => {
  test("renumbers start_seconds from the anchor so the stream clock resets to 0", () => {
    const stream = buildStreamManifest(buildManifest(buildChunks(4)), [
      buildChunk(2, { start_seconds: 8 }),
      buildChunk(3, { start_seconds: 12 }),
    ]);
    expect(stream?.chunks.map((chunk) => chunk.start_seconds)).toEqual([0, 4]);
    expect(stream?.mime_type).toBe('audio/mp4; codecs="mp4a.40.2"');
  });

  test("stays null without a manifest", () => {
    expect(buildStreamManifest(null, buildChunks(1))).toBeNull();
  });
});

/* ── Progress ─────────────────────────────────────────────── */

describe("deriveActiveChunkProgress", () => {
  const run = buildChunks(3);

  test("marks finished chunks played and reports the partial one as active", () => {
    const progress = deriveActiveChunkProgress(run, 5);
    expect(progress.activeChunkIndex).toBe(1);
    expect(progress.fillByIndex.get(0)).toBe(100);
    expect(progress.fillByIndex.get(1)).toBe(25);
    expect([...progress.playedIndexes]).toEqual([0]);
  });

  test("clamps a negative playhead to the start", () => {
    const progress = deriveActiveChunkProgress(run, -10);
    expect(progress.activeChunkIndex).toBe(0);
    expect(progress.fillByIndex.get(0)).toBe(0);
  });

  test("reports every chunk played once the playhead passes the run", () => {
    const progress = deriveActiveChunkProgress(run, 99);
    expect(progress.activeChunkIndex).toBeNull();
    expect(progress.playedIndexes.size).toBe(3);
  });

  test("a zero-duration chunk is treated as already played", () => {
    const progress = deriveActiveChunkProgress([buildChunk(0, { duration_seconds: 0 })], 0);
    expect(progress.playedIndexes.has(0)).toBe(true);
    expect(progress.activeChunkIndex).toBeNull();
  });
});

/* ── Timeline slots ───────────────────────────────────────── */

describe("deriveTimelineSlots", () => {
  const known = [
    buildChunk(0),
    buildChunk(1),
    buildChunk(2),
    buildChunk(3, { status: "queued", segment_url: null, duration_seconds: 0 }),
    buildChunk(4),
    buildChunk(5, { status: "rendering", segment_url: null, duration_seconds: 0 }),
  ];

  function slotsFor(currentTimeSeconds: number, anchorIndex = 0) {
    const model = derivePlaybackModel(known, known, versionsFor(known), anchorIndex);
    const progress = deriveActiveChunkProgress(model.contiguousReadyChunks, currentTimeSeconds);
    return deriveTimelineSlots(known, model, progress, anchorIndex);
  }

  test("classifies played, playing, ready, gaps and missing chunks", () => {
    expect(slotsFor(5).map((slot) => slot.state)).toEqual([
      "played",
      "playing",
      "ready",
      "missing_expected",
      "ready_after_gap",
      "missing_expected",
    ]);
  });

  test("failed and exhausted chunks render as failed", () => {
    const failing = [
      buildChunk(0),
      buildChunk(1, { status: "failed" }),
      buildChunk(2, { status: "max_retries_exceeded" }),
    ];
    const model = derivePlaybackModel(failing, failing, versionsFor(failing), 0);
    const progress = deriveActiveChunkProgress(model.contiguousReadyChunks, 0);
    expect(deriveTimelineSlots(failing, model, progress, 0).map((slot) => slot.state)).toEqual([
      "playing",
      "failed",
      "failed",
    ]);
  });

  test("written chunks before the anchor stay ready rather than playing", () => {
    expect(slotsFor(0, 2)[0]?.state).toBe("ready");
  });

  test("falls back to a 4s placeholder for a chunk with no duration", () => {
    const zero = [buildChunk(0, { duration_seconds: 0 })];
    const model = derivePlaybackModel(zero, zero, versionsFor(zero), 0);
    const progress = deriveActiveChunkProgress(model.contiguousReadyChunks, 0);
    expect(deriveTimelineSlots(zero, model, progress, 0)[0]?.durationSeconds).toBe(4);
  });
});
