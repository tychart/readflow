import { describe, expect, test } from "vitest";

import {
  STREAM_WINDOW_AHEAD_SECONDS,
  STREAM_WINDOW_EMERGENCY_KEEP_BEHIND_SECONDS,
  STREAM_WINDOW_KEEP_BEHIND_SECONDS,
  STREAM_WINDOW_REFILL_SECONDS,
  isSecondsBuffered,
  isSecondsEvicted,
  needsWindowFill,
  resolveAppendWindowEnd,
  resolveEvictionRange,
  type SecondsRange,
} from "./media-window";

describe("resolveAppendWindowEnd", () => {
  test("keeps the configured lookahead ahead of the playhead", () => {
    expect(resolveAppendWindowEnd({ playheadSeconds: 0, pendingSeekSeconds: null })).toBe(
      STREAM_WINDOW_AHEAD_SECONDS,
    );
    expect(
      resolveAppendWindowEnd({
        playheadSeconds: 100,
        pendingSeekSeconds: null,
      }),
    ).toBe(100 + STREAM_WINDOW_AHEAD_SECONDS);
  });

  test("never buffers a negative start", () => {
    expect(resolveAppendWindowEnd({ playheadSeconds: -5, pendingSeekSeconds: null })).toBe(
      STREAM_WINDOW_AHEAD_SECONDS,
    );
  });

  test("stretches just past a pending seek the playhead has not reached", () => {
    // One second past the target: chunks are selected by their start time, so
    // the chunk that *contains* the target has to be included.
    expect(resolveAppendWindowEnd({ playheadSeconds: 0, pendingSeekSeconds: 500 })).toBe(501);
    expect(resolveAppendWindowEnd({ playheadSeconds: 0, pendingSeekSeconds: 10 })).toBe(
      STREAM_WINDOW_AHEAD_SECONDS,
    );
  });
});

describe("needsWindowFill", () => {
  test("fills a brand new stream", () => {
    expect(
      needsWindowFill({
        playheadSeconds: 0,
        bufferedUntilSeconds: 0,
        pendingSeekSeconds: null,
      }),
    ).toBe(true);
  });

  test("stays quiet while the lookahead is still full", () => {
    expect(
      needsWindowFill({
        playheadSeconds: 100,
        bufferedUntilSeconds: 100 + STREAM_WINDOW_AHEAD_SECONDS,
        pendingSeekSeconds: null,
      }),
    ).toBe(false);
  });

  test("tops up once the lookahead falls below the refill threshold", () => {
    const refillBoundary = STREAM_WINDOW_AHEAD_SECONDS - STREAM_WINDOW_REFILL_SECONDS;
    expect(
      needsWindowFill({
        playheadSeconds: 100,
        bufferedUntilSeconds: 100 + refillBoundary,
        pendingSeekSeconds: null,
      }),
    ).toBe(false);
    expect(
      needsWindowFill({
        playheadSeconds: 100,
        bufferedUntilSeconds: 100 + refillBoundary - 1,
        pendingSeekSeconds: null,
      }),
    ).toBe(true);
  });

  test("fills even a full lookahead when the pending seek has not arrived", () => {
    expect(
      needsWindowFill({
        playheadSeconds: 0,
        bufferedUntilSeconds: 0,
        pendingSeekSeconds: 30,
      }),
    ).toBe(true);
    expect(
      needsWindowFill({
        playheadSeconds: 0,
        bufferedUntilSeconds: 10,
        pendingSeekSeconds: 30,
      }),
    ).toBe(true);
    expect(
      needsWindowFill({
        playheadSeconds: 0,
        bufferedUntilSeconds: 30,
        pendingSeekSeconds: null,
      }),
    ).toBe(true);
  });
});

describe("resolveEvictionRange", () => {
  test("never evicts at the start of a stream", () => {
    expect(resolveEvictionRange(0, 0)).toBeNull();
    expect(resolveEvictionRange(0, STREAM_WINDOW_KEEP_BEHIND_SECONDS)).toBeNull();
  });

  test("evicts everything before the keep-behind margin", () => {
    expect(resolveEvictionRange(0, 400)).toEqual({
      start: 0,
      end: 400 - STREAM_WINDOW_KEEP_BEHIND_SECONDS,
    });
    // A partial trim removes from the buffered start up to the margin.
    expect(resolveEvictionRange(100, 400)).toEqual({
      start: 0,
      end: 400 - STREAM_WINDOW_KEEP_BEHIND_SECONDS,
    });
    // Already-trimmed audio does not need a second removal call.
    expect(resolveEvictionRange(300, 400)).toBeNull();
  });

  test("leaves the margin untouched", () => {
    const playhead = 400;
    const keepBehind = STREAM_WINDOW_KEEP_BEHIND_SECONDS;
    expect(resolveEvictionRange(playhead - keepBehind, playhead)).toBeNull();
    expect(resolveEvictionRange(playhead - keepBehind + 5, playhead)).toBeNull();
  });

  test("the end always stays behind the playhead", () => {
    const range = resolveEvictionRange(0, 1000);
    expect(range).not.toBeNull();
    expect(range!.end).toBeLessThan(1000);
  });

  test("an emergency keep-behind frees almost everything", () => {
    expect(resolveEvictionRange(0, 1000, STREAM_WINDOW_EMERGENCY_KEEP_BEHIND_SECONDS)).toEqual({
      start: 0,
      end: 1000 - STREAM_WINDOW_EMERGENCY_KEEP_BEHIND_SECONDS,
    });
  });
});

describe("isSecondsBuffered", () => {
  test("matches inside a range, with float slack at the edges", () => {
    const ranges: SecondsRange[] = [{ start: 0, end: 10 }];
    expect(isSecondsBuffered(ranges, 0)).toBe(true);
    expect(isSecondsBuffered(ranges, 5)).toBe(true);
    expect(isSecondsBuffered(ranges, 10.02)).toBe(true);
    expect(isSecondsBuffered(ranges, 11)).toBe(false);
  });

  test("handles multiple ranges (a stream with a hole)", () => {
    const ranges: SecondsRange[] = [
      { start: 0, end: 10 },
      { start: 20, end: 30 },
    ];
    expect(isSecondsBuffered(ranges, 5)).toBe(true);
    expect(isSecondsBuffered(ranges, 15)).toBe(false);
    expect(isSecondsBuffered(ranges, 25)).toBe(true);
  });

  test("an empty buffer holds nothing", () => {
    expect(isSecondsBuffered([], 0)).toBe(false);
  });
});

describe("isSecondsEvicted", () => {
  test("positions behind the retained audio were played and dropped", () => {
    const ranges: SecondsRange[] = [{ start: 120, end: 360 }];
    expect(isSecondsEvicted(ranges, 0)).toBe(true);
    expect(isSecondsEvicted(ranges, 119)).toBe(true);
    expect(isSecondsEvicted(ranges, 130)).toBe(false);
  });

  test("positions ahead of the retained audio are not evicted", () => {
    // Ahead of the buffered end the window simply appends forward; nothing was
    // dropped, so a seek there must wait rather than reopen the stream.
    const ranges: SecondsRange[] = [{ start: 0, end: 10 }];
    expect(isSecondsEvicted(ranges, 60)).toBe(false);
    expect(isSecondsEvicted([], 60)).toBe(false);
  });
});
