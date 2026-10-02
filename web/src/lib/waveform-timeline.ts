import type { TimelineSlotData, TimelineSlotState } from "../types/timeline";
import { maxPool } from "./waveform";

/**
 * Pure geometry and peak-selection helpers for waveform surfaces.
 *
 * Everything here is side-effect free and component-agnostic so the main
 * timeline and the reader conveyor share one definition of "where does this
 * bar sit, and how much of it has playback passed". Keeping the math out of
 * the components also makes it directly unit-testable.
 */

/* ── Slot geometry ────────────────────────────────────────── */

type DurationBearing = Pick<TimelineSlotData, "durationSeconds">;

/** Cumulative start time of every slot, in job-timeline coordinates. */
export function buildCumulativeStartTimes(slots: readonly DurationBearing[]): number[] {
  const starts: number[] = [];
  let running = 0;
  for (const slot of slots) {
    starts.push(running);
    running += slot.durationSeconds;
  }
  return starts;
}

/** Total duration of every slot combined, in seconds. */
export function totalSlotDuration(slots: readonly DurationBearing[]): number {
  return slots.reduce((total, slot) => total + slot.durationSeconds, 0);
}

/**
 * Index of the slot containing an absolute position, clamped to the last slot.
 * Returns 0 for an empty slot list.
 */
export function slotIndexAtSeconds(
  cumulativeStartTimes: readonly number[],
  seconds: number,
): number {
  let index = 0;
  for (let i = 0; i < cumulativeStartTimes.length; i += 1) {
    if (seconds >= cumulativeStartTimes[i]) index = i;
    else break;
  }
  return index;
}

/** Offset from the left edge of `bounds` as a 0..1 ratio, clamped to the edges. */
export function pointerRatio(clientX: number, bounds: { left: number; width: number }): number {
  if (bounds.width <= 0) return 0;
  return Math.max(0, Math.min(1, (clientX - bounds.left) / bounds.width));
}

/** Convert a 0..1 ratio into an absolute position within `totalSeconds`. */
export function secondsAtRatio(ratio: number, totalSeconds: number): number {
  return Math.max(0, Math.min(1, ratio)) * totalSeconds;
}

/** Width in px of one slot, from its share of the total duration. */
export function slotWidthPx(
  containerWidthPx: number,
  slotDurationSeconds: number,
  totalSeconds: number,
): number {
  if (totalSeconds <= 0) return containerWidthPx;
  return Math.max(0, containerWidthPx * (slotDurationSeconds / totalSeconds));
}

/* ── Bar layout ───────────────────────────────────────────── */

/** Horizontal px one bar plus its trailing gap consumes. */
export function barStepPx(barWidthPx: number, barGapPx: number): number {
  return barWidthPx + barGapPx;
}

/** Number of bars that fit in a slot of `widthPx`, never fewer than one. */
export function barCountForWidth(widthPx: number, barStep: number, slotPaddingPx: number): number {
  return Math.max(1, Math.floor((widthPx - slotPaddingPx) / barStep));
}

/**
 * Fraction (0..1) of a bar that playback has passed, used for the amber
 * left-to-right fill. Returns 0 when nothing is rendered yet, so bars ahead of
 * the playable range stay muted.
 */
export function barFillFraction(
  playheadSeconds: number,
  barStartSeconds: number,
  barEndSeconds: number,
  renderedDurationSeconds: number,
): number {
  if (renderedDurationSeconds <= 0) return 0;
  if (playheadSeconds >= barEndSeconds) return 1;
  const barDuration = barEndSeconds - barStartSeconds;
  if (playheadSeconds > barStartSeconds && barDuration > 0) {
    return Math.min(1, (playheadSeconds - barStartSeconds) / barDuration);
  }
  return 0;
}

/* ── Slot state ───────────────────────────────────────────── */

/**
 * Chunk states that never show playback fill: they render a broken-signal or
 * dimmed pattern instead, because there is no audio to sweep across.
 */
export function isNonFillState(state: TimelineSlotState): boolean {
  return state === "failed" || state === "missing_expected";
}

/** True when a played slot should visually recede behind the playhead. */
export function isSlotDimmed(
  slot: Pick<TimelineSlotData, "state" | "durationSeconds">,
  slotStartSeconds: number,
  playheadSeconds: number,
): boolean {
  return slot.state === "played" && playheadSeconds > slotStartSeconds + slot.durationSeconds;
}

/* ── Waveform sources ─────────────────────────────────────── */

/** Deterministic dim placeholder for chunks whose peaks are not analyzed yet. */
export function generatePlaceholderWaveform(chunkIndex: number, length: number): Float32Array {
  const data = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    // Deterministic pseudo-random from chunkIndex + bar position
    const seed = (chunkIndex * 31 + i * 7) % 9973;
    const norm = seed / 9973;
    // Create a soft wave-like pattern
    const wave = Math.sin((i / length) * Math.PI * 2 + chunkIndex * 1.7);
    data[i] = 0.15 + norm * 0.35 + (wave * 0.1 + 0.1);
  }
  return data;
}

/** Broken-signal pattern for chunks that are missing or failed. */
export function generateBrokenWaveform(chunkIndex: number, length: number): Float32Array {
  const data = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    // Mostly flat with sharp random spikes — looks like a broken signal
    const seed = (chunkIndex * 13 + i * 17) % 9973;
    const spike = seed < 500 ? 0.6 + (seed / 9973) * 0.4 : 0.05;
    data[i] = spike;
  }
  return data;
}

/**
 * Peak data to render for one slot: backend-analyzed peaks when present,
 * otherwise a broken-signal pattern for missing/failed chunks and a dim
 * deterministic placeholder for everything else. Always pooled to `barCount`.
 */
export function waveformForSlot(
  analyzed: Float32Array | undefined,
  slot: Pick<TimelineSlotData, "chunkIndex" | "state">,
  barCount: number,
): Float32Array {
  if (analyzed) return maxPool(analyzed, barCount);
  if (isNonFillState(slot.state)) return generateBrokenWaveform(slot.chunkIndex, barCount);
  return generatePlaceholderWaveform(slot.chunkIndex, barCount);
}
