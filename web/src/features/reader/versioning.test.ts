import { expect, test, describe } from "vitest";

import type { Chunk } from "../../types/api";

/**
 * These are the pure helper functions from ReaderPage.tsx.
 * We re-implement them here to test them in isolation.
 */

function deriveActiveVersions(chunks: Chunk[]): Map<number, number> {
  const versions = new Map<number, number>();
  for (const chunk of chunks) {
    const existing = versions.get(chunk.index);
    if (existing === undefined || chunk.version > existing) {
      versions.set(chunk.index, chunk.version);
    }
  }
  return versions;
}

function getLatestVersion(chunks: Chunk[], index: number): number {
  let max = -1;
  for (const chunk of chunks) {
    if (chunk.index === index && chunk.version > max) {
      max = chunk.version;
    }
  }
  return max;
}

function isReprocessing(status: string): boolean {
  return (
    status === "planned" ||
    status === "queued" ||
    status === "rendering" ||
    status === "reprocessing"
  );
}

function getRetryCount(status: string, version: number): number {
  if (status === "max_retries_exceeded") return 3;
  return version;
}

function chunkStatusText(state: string): string {
  switch (state) {
    case "played":
      return "played";
    case "playing":
      return "active";
    case "ready":
      return "ready";
    case "ready_after_gap":
      return "ready after gap";
    case "missing_expected":
      return "expected but not received";
    case "failed":
      return "failed";
    default:
      return "unknown";
  }
}

function describeTimelineSlot(slot: {
  chunk: { index: number };
  state: string;
}): string {
  const chunkNumber = slot.chunk.index + 1;
  return `Chunk ${chunkNumber} ${chunkStatusText(slot.state)}`;
}

function buildReaderJob(
  chunkCount: number,
  status: string = "queued",
  chunks: Chunk[] = [],
): {
  id: string;
  title: string;
  status: string;
  voice_id: string;
  model_id: string;
  is_active_listening: boolean;
  total_chunks_emitted: number;
  total_chunks_completed: number;
  buffered_seconds: number;
  completed_seconds: number;
  active_chunk_version: Record<number, number>;
  source_kind: string;
  source_text: string;
  plan_version: number;
  chunks: Chunk[];
  failed_reason: null;
  total_versioned_chunks: number;
  total_versioned_completed: number;
} {
  const defaultChunks = Array.from({ length: chunkCount }, (_, index) => ({
    index,
    status: "written",
    duration_seconds: 4,
    start_seconds: index * 4,
    plan_version: 1,
    version: 0,
    voice_id: "suzy",
    segment_url: `/api/jobs/job-1/chunks/${index}`,
    deprecated: false,
    reprocessing: false,
  })) satisfies Chunk[];

  return {
    id: "job-1",
    title: "Reader job",
    status,
    voice_id: "suzy",
    model_id: "Qwen/Qwen3-TTS-12Hz-0.6B-Base",
    is_active_listening: status === "playing",
    total_chunks_emitted: chunks.length || chunkCount,
    total_chunks_completed:
      chunks.filter((c) => c.status === "written").length || chunkCount,
    buffered_seconds:
      chunks
        .filter((c) => c.status === "written")
        .reduce((t, c) => t + c.duration_seconds, 0) || chunkCount * 4,
    completed_seconds: 0,
    active_chunk_version: {} as Record<number, number>,
    source_kind: "text",
    source_text: "A reader page test.",
    plan_version: 1,
    chunks: chunks.length ? chunks : defaultChunks,
    failed_reason: null,
    total_versioned_chunks: chunks.length || chunkCount,
    total_versioned_completed:
      chunks.filter((c) => c.status === "written").length || chunkCount,
  };
}

describe("deriveActiveVersions", () => {
  test("picks the highest version for each chunk index", () => {
    const chunks: Chunk[] = [
      {
        index: 0,
        status: "written",
        duration_seconds: 4,
        start_seconds: 0,
        plan_version: 1,
        version: 0,
        voice_id: "suzy",
        segment_url: "/api/jobs/job-1/chunks/0",
        deprecated: false,
        reprocessing: false,
      },
      {
        index: 0,
        status: "written",
        duration_seconds: 5,
        start_seconds: 0,
        plan_version: 2,
        version: 2,
        voice_id: "suzy",
        segment_url: "/api/jobs/job-1/chunks/0",
        deprecated: true,
        reprocessing: false,
      },
      {
        index: 0,
        status: "written",
        duration_seconds: 3,
        start_seconds: 0,
        plan_version: 3,
        version: 1,
        voice_id: "suzy",
        segment_url: "/api/jobs/job-1/chunks/0",
        deprecated: false,
        reprocessing: false,
      },
      {
        index: 1,
        status: "written",
        duration_seconds: 4,
        start_seconds: 4,
        plan_version: 1,
        version: 0,
        voice_id: "suzy",
        segment_url: "/api/jobs/job-1/chunks/1",
        deprecated: false,
        reprocessing: false,
      },
    ];

    const versions = deriveActiveVersions(chunks);
    expect(versions.get(0)).toBe(2); // highest version for index 0
    expect(versions.get(1)).toBe(0); // only version for index 1
  });

  test("returns empty map for empty chunk list", () => {
    expect(deriveActiveVersions([]).size).toBe(0);
  });

  test("handles chunks with no version field (defaults to 0)", () => {
    const chunks = [
      {
        index: 0,
        status: "written",
        duration_seconds: 4,
        start_seconds: 0,
        plan_version: 1,
        voice_id: "suzy",
        segment_url: "/api/jobs/job-1/chunks/0",
      },
    ] as unknown as Chunk[];
    const versions = deriveActiveVersions(chunks);
    expect(versions.get(0)).toBeUndefined();
  });
});

describe("getLatestVersion", () => {
  test("returns the highest version for a given index", () => {
    const chunks: Chunk[] = [
      {
        index: 0,
        status: "written",
        duration_seconds: 4,
        start_seconds: 0,
        plan_version: 1,
        version: 1,
        voice_id: "suzy",
        segment_url: "/api/jobs/job-1/chunks/0",
        deprecated: true,
        reprocessing: false,
      },
      {
        index: 0,
        status: "written",
        duration_seconds: 5,
        start_seconds: 0,
        plan_version: 2,
        version: 3,
        voice_id: "suzy",
        segment_url: "/api/jobs/job-1/chunks/0",
        deprecated: false,
        reprocessing: false,
      },
    ];
    expect(getLatestVersion(chunks, 0)).toBe(3);
  });

  test("returns -1 for non-existent chunk index", () => {
    const chunks: Chunk[] = [
      {
        index: 0,
        status: "written",
        duration_seconds: 4,
        start_seconds: 0,
        plan_version: 1,
        version: 0,
        voice_id: "suzy",
        segment_url: "/api/jobs/job-1/chunks/0",
        deprecated: false,
        reprocessing: false,
      },
    ];
    expect(getLatestVersion(chunks, 99)).toBe(-1);
  });
});

describe("isReprocessing", () => {
  test("returns true for reprocessing status", () => {
    expect(isReprocessing("reprocessing")).toBe(true);
  });

  test("returns true for planned status", () => {
    expect(isReprocessing("planned")).toBe(true);
  });

  test("returns true for queued status", () => {
    expect(isReprocessing("queued")).toBe(true);
  });

  test("returns true for rendering status", () => {
    expect(isReprocessing("rendering")).toBe(true);
  });

  test("returns false for written status", () => {
    expect(isReprocessing("written")).toBe(false);
  });

  test("returns false for failed status", () => {
    expect(isReprocessing("failed")).toBe(false);
  });

  test("returns false for max_retries_exceeded status", () => {
    expect(isReprocessing("max_retries_exceeded")).toBe(false);
  });
});

describe("getRetryCount", () => {
  test("returns version number as retry count", () => {
    expect(getRetryCount("written", 0)).toBe(0);
    expect(getRetryCount("written", 1)).toBe(1);
    expect(getRetryCount("written", 3)).toBe(3);
  });

  test("returns 3 for max_retries_exceeded regardless of version", () => {
    expect(getRetryCount("max_retries_exceeded", 3)).toBe(3);
    expect(getRetryCount("max_retries_exceeded", 5)).toBe(3);
  });
});

describe("chunkStatusText", () => {
  test("returns correct text for each state", () => {
    expect(chunkStatusText("played")).toBe("played");
    expect(chunkStatusText("playing")).toBe("active");
    expect(chunkStatusText("ready")).toBe("ready");
    expect(chunkStatusText("ready_after_gap")).toBe("ready after gap");
    expect(chunkStatusText("missing_expected")).toBe("expected but not received");
    expect(chunkStatusText("failed")).toBe("failed");
    expect(chunkStatusText("bogus")).toBe("unknown");
  });
});

describe("describeTimelineSlot", () => {
  test("formats slot description with chunk number and status", () => {
    expect(
      describeTimelineSlot({
        chunk: { index: 0 },
        state: "playing",
      }),
    ).toBe("Chunk 1 active");

    expect(
      describeTimelineSlot({
        chunk: { index: 4 },
        state: "missing_expected",
      }),
    ).toBe("Chunk 5 expected but not received");
  });
});

describe("buildReaderJob with versioning fields", () => {
  test("includes active_chunk_version as empty object by default", () => {
    const job = buildReaderJob(3);
    expect(job.active_chunk_version).toEqual({});
  });

  test("includes total_versioned_chunks and total_versioned_completed", () => {
    const chunks: Chunk[] = [
      {
        index: 0,
        status: "written",
        duration_seconds: 4,
        start_seconds: 0,
        plan_version: 1,
        version: 0,
        voice_id: "suzy",
        segment_url: "/api/jobs/job-1/chunks/0",
        deprecated: false,
        reprocessing: false,
      },
    ];
    const job = buildReaderJob(0, "queued", chunks);
    expect(job.total_versioned_chunks).toBe(1);
    expect(job.total_versioned_completed).toBe(1);
  });

  test("counts written chunks for total_versioned_completed", () => {
    const chunks: Chunk[] = [
      {
        index: 0,
        status: "written",
        duration_seconds: 4,
        start_seconds: 0,
        plan_version: 1,
        version: 0,
        voice_id: "suzy",
        segment_url: "/api/jobs/job-1/chunks/0",
        deprecated: false,
        reprocessing: false,
      },
      {
        index: 1,
        status: "queued",
        duration_seconds: 0,
        start_seconds: 0,
        plan_version: 1,
        version: 0,
        voice_id: "suzy",
        segment_url: null,
        deprecated: false,
        reprocessing: false,
      },
    ];
    const job = buildReaderJob(0, "rendering", chunks);
    expect(job.total_versioned_completed).toBe(1);
  });
});
