import { describe, expect, test } from "vitest";

import { buildChunk } from "../../test-utils/chunks";
import {
  deriveActiveVersions,
  getChunkText,
  getLatestVersion,
  getRetryCount,
  isTerminalStatus,
  sortChunks,
  TERMINAL_JOB_STATUSES,
  upsertChunk,
} from "./chunk-utils";

describe("isTerminalStatus", () => {
  test("only completed and failed are terminal", () => {
    expect(TERMINAL_JOB_STATUSES).toEqual(["completed", "failed"]);
    expect(isTerminalStatus("completed")).toBe(true);
    expect(isTerminalStatus("failed")).toBe(true);
    expect(isTerminalStatus("playing")).toBe(false);
    expect(isTerminalStatus("paused")).toBe(false);
    expect(isTerminalStatus(undefined)).toBe(false);
  });
});

describe("sortChunks", () => {
  test("orders by chunk index without mutating the input", () => {
    const input = [buildChunk(2), buildChunk(0), buildChunk(1)];
    const sorted = sortChunks(input);
    expect(sorted.map((chunk) => chunk.index)).toEqual([0, 1, 2]);
    expect(input.map((chunk) => chunk.index)).toEqual([2, 0, 1]);
  });
});

describe("upsertChunk", () => {
  test("replaces the same (index, version) and keeps timeline order", () => {
    const original = [buildChunk(0), buildChunk(1, { duration_seconds: 4 })];
    const updated = upsertChunk(original, buildChunk(1, { duration_seconds: 9 }));
    expect(updated).toHaveLength(2);
    expect(updated[1]?.duration_seconds).toBe(9);
  });

  test("keeps other versions of the same index side by side", () => {
    const original = [buildChunk(0, { version: 0 })];
    const updated = upsertChunk(original, buildChunk(0, { version: 1 }));
    expect(updated.map((chunk) => chunk.version)).toEqual([0, 1]);
  });

  test("inserts a missing index in order", () => {
    const original = [buildChunk(0), buildChunk(2)];
    const updated = upsertChunk(original, buildChunk(1));
    expect(updated.map((chunk) => chunk.index)).toEqual([0, 1, 2]);
  });
});

describe("deriveActiveVersions", () => {
  test("picks the highest version per index", () => {
    const versions = deriveActiveVersions([
      buildChunk(0, { version: 0 }),
      buildChunk(0, { version: 2 }),
      buildChunk(0, { version: 1 }),
      buildChunk(1, { version: 0 }),
    ]);
    expect(versions.get(0)).toBe(2);
    expect(versions.get(1)).toBe(0);
  });

  test("returns an empty map for no chunks", () => {
    expect(deriveActiveVersions([]).size).toBe(0);
  });

  test("leaves a chunk with no version field unmapped", () => {
    const chunk = buildChunk(0) as { version?: number };
    delete chunk.version;
    expect(deriveActiveVersions([chunk as never]).get(0)).toBeUndefined();
  });
});

describe("getLatestVersion", () => {
  test("returns the highest version for an index", () => {
    expect(
      getLatestVersion([buildChunk(0, { version: 1 }), buildChunk(0, { version: 3 })], 0),
    ).toBe(3);
  });

  test("returns -1 when the index is absent", () => {
    expect(getLatestVersion([buildChunk(0)], 99)).toBe(-1);
  });
});

describe("getRetryCount", () => {
  test("uses the version as the attempt count", () => {
    expect(getRetryCount("written", 0)).toBe(0);
    expect(getRetryCount("written", 3)).toBe(3);
  });

  test("caps at 3 once retries are exhausted", () => {
    expect(getRetryCount("max_retries_exceeded", 5)).toBe(3);
  });
});

/**
 * Chunk text extraction.
 *
 * Chunk offsets are computed by the backend against the canonical source text
 * (`app.chunking.normalize.normalize_source_text`, applied once when the job is
 * created), so the client slices what it was given instead of normalizing
 * again. Backend normalization is covered by
 * `server/tests/unit/test_normalize.py` plus the planner coverage test.
 */
describe("getChunkText", () => {
  test("returns the text at the chunk's offsets", () => {
    const source = "Chunk one text. Chunk two text.";
    // "Chunk two text." starts at index 16 (after "Chunk one text. ")
    expect(getChunkText({ char_start: 16, char_end: 31 }, source)).toBe("Chunk two text.");
  });

  test("strips leading and trailing whitespace from the extracted text", () => {
    const source = "Hello. World. More text.";
    // char_start points to the space before "World"; char_end is past its period.
    expect(getChunkText({ char_start: 6, char_end: 13 }, source)).toBe("World.");
  });

  test("returns empty text for offsets past the end of the document", () => {
    expect(getChunkText({ char_start: 99, char_end: 200 }, "Short.")).toBe("");
  });
});
