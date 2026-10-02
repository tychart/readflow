import { describe, expect, test } from "vitest";

import { buildChunk } from "../../test-utils/chunks";
import { buildReaderTextSegments, FULL_TAIL_RENDER_CHARS, UPCOMING_PREVIEW_CHARS } from "./reader-text";

describe("buildReaderTextSegments", () => {
  test("slices one block per chunk straight out of the canonical text", () => {
    const source = "AAAA BBBB CCCC DDDD";
    const segments = buildReaderTextSegments(
      [buildChunk(0, { char_start: 0, char_end: 4 }), buildChunk(1, { char_start: 5, char_end: 9 })],
      source,
    );

    expect(segments.map((segment) => segment.text)).toEqual(["AAAA", " ", "BBBB", " CCCC DDDD"]);
    expect(segments.map((segment) => segment.kind)).toEqual([
      "chunk",
      "upcoming",
      "chunk",
      "upcoming",
    ]);
  });

  test("chunk segments carry their index and the tail does not", () => {
    const segments = buildReaderTextSegments([buildChunk(3, { char_start: 0, char_end: 2 })], "ab tail");
    expect(segments[0]?.chunkIndex).toBe(3);
    expect(segments[1]?.chunkIndex).toBeNull();
  });

  test("renders the planned tail in full when it is small", () => {
    const segments = buildReaderTextSegments([buildChunk(0, { char_start: 0, char_end: 4 })], "AAAA rest");
    const tail = segments.at(-1);
    expect(tail?.kind).toBe("upcoming");
    expect(tail?.text).toBe(" rest");
    expect(tail?.hiddenChars).toBe(0);
  });

  test("renders the whole unplanned tail when nothing is planned yet", () => {
    const source = "Nothing has been planned from this paste.";
    const segments = buildReaderTextSegments([], source);
    expect(segments).toHaveLength(1);
    expect(segments[0]?.text).toBe(source);
  });

  test("adds no trailing segment when the text is fully planned", () => {
    const segments = buildReaderTextSegments([buildChunk(0, { char_start: 0, char_end: 6 })], "abcdef");
    expect(segments).toHaveLength(1);
    expect(segments[0]?.kind).toBe("chunk");
  });

  test("orders out-of-order chunks by index", () => {
    const segments = buildReaderTextSegments(
      [buildChunk(1, { char_start: 2, char_end: 4 }), buildChunk(0, { char_start: 0, char_end: 2 })],
      "aabb",
    );
    expect(segments.map((segment) => segment.chunkIndex)).toEqual([0, 1]);
  });

  test("bounds a book-sized tail to a preview and reports the hidden count", () => {
    const planned = 10;
    const source = "x".repeat(planned + 250_000);
    const segments = buildReaderTextSegments(
      [buildChunk(0, { char_start: 0, char_end: planned })],
      source,
    );

    const tail = segments.at(-1);
    expect(tail?.kind).toBe("upcoming");
    expect(tail?.text).toHaveLength(UPCOMING_PREVIEW_CHARS);
    expect(tail?.hiddenChars).toBe(250_000 - UPCOMING_PREVIEW_CHARS);
  });

  test("renders a tail exactly at the full-render limit without hiding anything", () => {
    const planned = 10;
    const source = "y".repeat(planned + FULL_TAIL_RENDER_CHARS);
    const segments = buildReaderTextSegments(
      [buildChunk(0, { char_start: 0, char_end: planned })],
      source,
    );
    const tail = segments.at(-1);
    expect(tail?.hiddenChars).toBe(0);
    expect(tail?.text).toHaveLength(FULL_TAIL_RENDER_CHARS);
  });
});
