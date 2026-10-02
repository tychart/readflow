import { describe, expect, test } from "vitest";

import type { TimelineSlotData } from "../types/timeline";
import {
  barCountForWidth,
  barFillFraction,
  barStepPx,
  buildCumulativeStartTimes,
  generateBrokenWaveform,
  generatePlaceholderWaveform,
  isNonFillState,
  isSlotDimmed,
  pointerRatio,
  secondsAtRatio,
  slotIndexAtSeconds,
  slotWidthPx,
  totalSlotDuration,
  waveformForSlot,
} from "./waveform-timeline";

function slots(durations: number[]): TimelineSlotData[] {
  return durations.map((durationSeconds, chunkIndex) => ({
    chunkIndex,
    state: "ready",
    durationSeconds,
  }));
}

describe("buildCumulativeStartTimes", () => {
  test("accumulates each slot's duration", () => {
    expect(buildCumulativeStartTimes(slots([4, 1, 5]))).toEqual([0, 4, 5]);
  });

  test("is empty for no slots", () => {
    expect(buildCumulativeStartTimes([])).toEqual([]);
  });
});

describe("totalSlotDuration", () => {
  test("sums every slot", () => {
    expect(totalSlotDuration(slots([4, 1, 5]))).toBe(10);
    expect(totalSlotDuration([])).toBe(0);
  });
});

describe("slotIndexAtSeconds", () => {
  const starts = [0, 4, 5];

  test("finds the slot containing a position", () => {
    expect(slotIndexAtSeconds(starts, 0)).toBe(0);
    expect(slotIndexAtSeconds(starts, 3.9)).toBe(0);
    expect(slotIndexAtSeconds(starts, 4)).toBe(1);
    expect(slotIndexAtSeconds(starts, 9)).toBe(2);
  });

  test("clamps past the end to the last slot and defaults to 0 when empty", () => {
    expect(slotIndexAtSeconds(starts, 999)).toBe(2);
    expect(slotIndexAtSeconds([], 5)).toBe(0);
  });
});

describe("pointerRatio", () => {
  test("maps an offset inside the bounds to 0..1", () => {
    expect(pointerRatio(50, { left: 0, width: 100 })).toBe(0.5);
    expect(pointerRatio(150, { left: 100, width: 200 })).toBe(0.25);
  });

  test("clamps outside the bounds and tolerates zero width", () => {
    expect(pointerRatio(-40, { left: 0, width: 100 })).toBe(0);
    expect(pointerRatio(400, { left: 0, width: 100 })).toBe(1);
    expect(pointerRatio(10, { left: 0, width: 0 })).toBe(0);
  });
});

describe("secondsAtRatio", () => {
  test("scales a clamped ratio onto the total duration", () => {
    expect(secondsAtRatio(0.25, 12)).toBe(3);
    expect(secondsAtRatio(2, 12)).toBe(12);
    expect(secondsAtRatio(-1, 12)).toBe(0);
    expect(secondsAtRatio(0.5, 0)).toBe(0);
  });
});

describe("slotWidthPx", () => {
  test("is proportional to the slot's share of the total", () => {
    expect(slotWidthPx(300, 4, 12)).toBe(100);
    expect(slotWidthPx(300, 1, 3)).toBe(100);
  });

  test("falls back to the full container width without a total duration", () => {
    expect(slotWidthPx(300, 4, 0)).toBe(300);
  });
});

describe("bar layout", () => {
  test("barStepPx adds the trailing gap to the bar width", () => {
    expect(barStepPx(3, 2)).toBe(5);
  });

  test("barCountForWidth fits as many bars as the slot allows, minimum one", () => {
    expect(barCountForWidth(108, 5, 8)).toBe(20);
    expect(barCountForWidth(0, 5, 8)).toBe(1);
    expect(barCountForWidth(9, 5, 8)).toBe(1);
  });
});

describe("barFillFraction", () => {
  test("is 0 before the bar, proportional inside it and 1 after it", () => {
    expect(barFillFraction(0, 4, 8, 12)).toBe(0);
    expect(barFillFraction(6, 4, 8, 12)).toBe(0.5);
    expect(barFillFraction(8, 4, 8, 12)).toBe(1);
    expect(barFillFraction(30, 4, 8, 12)).toBe(1);
  });

  test("stays muted while nothing is rendered yet", () => {
    expect(barFillFraction(6, 4, 8, 0)).toBe(0);
  });

  test("does not divide by a zero-width bar", () => {
    expect(barFillFraction(4, 4, 4, 12)).toBe(1);
  });
});

describe("slot state helpers", () => {
  test("only missing and failed states skip the playback fill", () => {
    expect(isNonFillState("missing_expected")).toBe(true);
    expect(isNonFillState("failed")).toBe(true);
    expect(isNonFillState("ready_after_gap")).toBe(false);
    expect(isNonFillState("playing")).toBe(false);
  });

  test("a played slot dims only once the playhead has left it", () => {
    const slot = { state: "played" as const, durationSeconds: 4 };
    expect(isSlotDimmed(slot, 0, 3)).toBe(false);
    expect(isSlotDimmed(slot, 0, 5)).toBe(true);
    expect(isSlotDimmed({ state: "ready", durationSeconds: 4 }, 0, 5)).toBe(false);
  });
});

describe("waveform sources", () => {
  test("pools analyzed peaks to the requested bar count", () => {
    const analyzed = new Float32Array([0.1, 0.5, 0.2, 0.8]);
    const pooled = Array.from(waveformForSlot(analyzed, { chunkIndex: 0, state: "ready" }, 2));
    expect(pooled).toHaveLength(2);
    expect(pooled[0]).toBeCloseTo(0.5, 5);
    expect(pooled[1]).toBeCloseTo(0.8, 5);
  });

  test("uses a broken-signal pattern for missing and failed chunks", () => {
    const missing = waveformForSlot(undefined, { chunkIndex: 1, state: "missing_expected" }, 64);
    expect(Array.from(missing)).toEqual(Array.from(generateBrokenWaveform(1, 64)));
    const failed = waveformForSlot(undefined, { chunkIndex: 1, state: "failed" }, 8);
    expect(Array.from(failed)).toEqual(Array.from(generateBrokenWaveform(1, 8)));
  });

  test("uses a dim deterministic placeholder for un-analyzed ready chunks", () => {
    const placeholder = waveformForSlot(undefined, { chunkIndex: 2, state: "ready" }, 16);
    expect(Array.from(placeholder)).toEqual(Array.from(generatePlaceholderWaveform(2, 16)));
    // Deterministic: the same chunk always renders the same shape.
    expect(Array.from(waveformForSlot(undefined, { chunkIndex: 2, state: "ready" }, 16))).toEqual(
      Array.from(placeholder),
    );
  });
});
