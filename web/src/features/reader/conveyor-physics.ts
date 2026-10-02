import type { ConveyorWindowSize } from "../../state/reader-settings";
import type { TimelineSlotData } from "../../types/timeline";

/**
 * Chunk conveyor gesture physics and layout.
 *
 * The conveyor keeps a fixed playhead marker at the horizontal centre of the
 * strip and slides the chunk track under it, so the strip's position IS the
 * value being edited: a *time* in the job timeline. To keep that unambiguous,
 * every identifier here carries its unit — positions are seconds of timeline,
 * offsets are seconds relative to the position the gesture started from, and
 * speeds are seconds of timeline per second of real time. Pointer samples
 * arrive in px and are converted with `pxPerSecond`.
 *
 * Everything is pure, so the feel (flick threshold, friction, settle spring) is
 * unit-testable without pointer events or a browser.
 */

/* ── Feel ─────────────────────────────────────────────────── */

/** Pointer speed (px/ms) above which a release is a flick rather than a drop. */
export const FLICK_VELOCITY_PX_PER_MS = 0.45;
/**
 * Exponential decay rate while coasting (1/s).
 *
 * Chosen so total flick travel is `velocity / COAST_DECAY` in *pixels*, which
 * comes out independent of the strip's zoom: a ~1000px/s flick glides about
 * half a screen and a hard ~2500px/s flick about 1.5 screens.
 */
export const COAST_DECAY_PER_SECOND = 2;
/**
 * Coasting hands over to the settle spring below this speed (s/s). Expressed in
 * strip-seconds so it stays proportional to the visible scale.
 */
export const COAST_REST_SECONDS_PER_SECOND = 2;
/**
 * Settle spring, pulling the strip onto its commit target. Underdamped on
 * purpose: the leftover coasting speed makes the strip ease in with a small
 * overshoot instead of stopping dead.
 */
export const SETTLE_STIFFNESS_PER_SECOND_SQUARED = 200;
export const SETTLE_DAMPING_PER_SECOND = 16;
/** Distance from the target that counts as settled (s). */
export const SETTLE_REST_SECONDS = 0.01;
/** Sample window used to read a flick's velocity. */
export const VELOCITY_SAMPLE_WINDOW_MS = 110;
/**
 * Pointer travel (px) below which a press is a tap rather than a drag. A tap
 * means "put this point under the playhead", which is a different edit from
 * dragging the track with the finger.
 */
export const TAP_SLOP_PX = 6;

/* ── Types ────────────────────────────────────────────────── */

export interface PointerSample {
  x: number;
  atMs: number;
}

export interface DraggingGesture {
  phase: "dragging";
  /** Live playhead when the gesture started; the strip is positioned relative to it. */
  baseSeconds: number;
  offsetSeconds: number;
  pointerStartX: number;
  samples: PointerSample[];
}

export interface CoastingGesture {
  phase: "coasting";
  baseSeconds: number;
  offsetSeconds: number;
  speedSecondsPerSecond: number;
}

export interface SettlingGesture {
  phase: "settling";
  baseSeconds: number;
  /** Current position, relative to `baseSeconds`. */
  offsetSeconds: number;
  /** Where the spring is pulling the strip — always inside the playable range. */
  targetOffsetSeconds: number;
  speedSecondsPerSecond: number;
  /**
   * Set once the strip has reported rest, so rest is delivered exactly once.
   * Without it a settled gesture would report rest on every subsequent frame
   * (and a gesture that starts at rest would never report it at all).
   */
  hasReportedRest: boolean;
}

export type ConveyorGesture = DraggingGesture | CoastingGesture | SettlingGesture;

/** Visual range for the strip and the range a commit may land in. */
export interface ConveyorBounds {
  /** End of contiguous rendered audio: commits never land beyond this. */
  maxSeekSeconds: number;
  /** End of every known chunk: the strip may still be dragged this far. */
  maxVisualSeconds: number;
}

export interface SettleState {
  offsetSeconds: number;
  speedSecondsPerSecond: number;
}

/* ── Conversions ──────────────────────────────────────────── */

export function clampSeconds(seconds: number, maxSeconds: number): number {
  return Math.min(Math.max(0, seconds), maxSeconds);
}

/** Convert a pointer speed in px/ms to timeline seconds per second. */
export function pxPerMsToStripSpeed(velocityPxPerMs: number, pxPerSecond: number): number {
  if (pxPerSecond <= 0) return 0;
  return (velocityPxPerMs / pxPerSecond) * 1000;
}

/**
 * Pointer velocity in px/ms from recent samples, measured across the newest
 * sample window rather than the whole gesture so a pause before release reads
 * as a drop instead of a flick.
 */
export function velocityFromSamples(
  samples: readonly PointerSample[],
  windowMs = VELOCITY_SAMPLE_WINDOW_MS,
): number {
  if (samples.length < 2) return 0;
  const newest = samples[samples.length - 1];
  let oldest = newest;
  for (let i = samples.length - 1; i >= 0; i -= 1) {
    if (newest.atMs - samples[i].atMs > windowMs) break;
    oldest = samples[i];
  }
  const elapsed = newest.atMs - oldest.atMs;
  if (elapsed <= 0) return 0;
  return (newest.x - oldest.x) / elapsed;
}

export function isFlick(velocityPxPerMs: number): boolean {
  return Math.abs(velocityPxPerMs) >= FLICK_VELOCITY_PX_PER_MS;
}

/** True when a completed press never really moved. */
export function isTap(pointerStartX: number, pointerEndX: number): boolean {
  return Math.abs(pointerEndX - pointerStartX) <= TAP_SLOP_PX;
}

/* ── Gesture lifecycle ────────────────────────────────────── */

export function beginDrag(baseSeconds: number, pointerX: number, atMs: number): DraggingGesture {
  return {
    phase: "dragging",
    baseSeconds,
    offsetSeconds: 0,
    pointerStartX: pointerX,
    samples: [{ x: pointerX, atMs }],
  };
}

/**
 * Direct manipulation: the track follows the finger, so dragging right reveals
 * earlier audio (the strip moves right, time goes backwards).
 */
export function updateDrag(
  gesture: DraggingGesture,
  pointerX: number,
  atMs: number,
  pxPerSecond: number,
  bounds: ConveyorBounds,
): DraggingGesture {
  const travelledSeconds = pxPerSecond > 0 ? (pointerX - gesture.pointerStartX) / pxPerSecond : 0;
  const rawOffset = -travelledSeconds;
  return {
    ...gesture,
    offsetSeconds:
      clampSeconds(gesture.baseSeconds + rawOffset, bounds.maxVisualSeconds) - gesture.baseSeconds,
    samples: [...gesture.samples.slice(-8), { x: pointerX, atMs }],
  };
}

/**
 * Resolve a release.
 *
 * - A **tap** (`alignmentOffsetSeconds` provided) moves the strip so the tapped
 *   point ends up under the fixed playhead, then settles.
 * - A **flick** coasts under its own momentum — motion only, audio is not
 *   touched.
 * - A **drop** goes straight to the settle spring, which also animates the strip
 *   back if it was left past the end of rendered audio.
 */
export function endDrag(
  gesture: DraggingGesture,
  atMs: number,
  pxPerSecond: number,
  motion: "animated" | "reduced",
  bounds: ConveyorBounds,
  alignmentOffsetSeconds: number | null = null,
): ConveyorGesture {
  const offsetSeconds =
    alignmentOffsetSeconds === null
      ? gesture.offsetSeconds
      : clampSeconds(gesture.baseSeconds + alignmentOffsetSeconds, bounds.maxVisualSeconds) -
        gesture.baseSeconds;
  const targetOffsetSeconds =
    clampSeconds(gesture.baseSeconds + offsetSeconds, bounds.maxSeekSeconds) - gesture.baseSeconds;

  if (motion === "reduced") {
    // No inertia and no jiggle: land on the target and commit on the next tick.
    return {
      phase: "settling",
      baseSeconds: gesture.baseSeconds,
      offsetSeconds: targetOffsetSeconds,
      targetOffsetSeconds,
      speedSecondsPerSecond: 0,
      hasReportedRest: false,
    };
  }

  const velocityPxPerMs = velocityFromSamples(gesture.samples, atMs - gesture.samples[0].atMs);
  if (alignmentOffsetSeconds === null && isFlick(velocityPxPerMs)) {
    return {
      phase: "coasting",
      baseSeconds: gesture.baseSeconds,
      offsetSeconds,
      speedSecondsPerSecond: -pxPerMsToStripSpeed(velocityPxPerMs, pxPerSecond),
    };
  }

  return {
    phase: "settling",
    baseSeconds: gesture.baseSeconds,
    offsetSeconds,
    targetOffsetSeconds,
    speedSecondsPerSecond: 0,
    hasReportedRest: false,
  };
}

/**
 * One integration step of the settle spring toward `targetOffsetSeconds`.
 * Semi-implicit Euler, which stays stable at the frame sizes we clamp to.
 */
export function stepSettleSpring(
  state: SettleState,
  targetOffsetSeconds: number,
  dtSeconds: number,
  stiffness = SETTLE_STIFFNESS_PER_SECOND_SQUARED,
  damping = SETTLE_DAMPING_PER_SECOND,
): SettleState {
  const displacement = targetOffsetSeconds - state.offsetSeconds;
  const acceleration = stiffness * displacement - damping * state.speedSecondsPerSecond;
  const speedSecondsPerSecond = state.speedSecondsPerSecond + acceleration * dtSeconds;
  return {
    offsetSeconds: state.offsetSeconds + speedSecondsPerSecond * dtSeconds,
    speedSecondsPerSecond,
  };
}

export function isSettleAtRest(state: SettleState, targetOffsetSeconds: number): boolean {
  return (
    Math.abs(targetOffsetSeconds - state.offsetSeconds) < SETTLE_REST_SECONDS &&
    Math.abs(state.speedSecondsPerSecond) < COAST_REST_SECONDS_PER_SECOND
  );
}

/**
 * Advance a coasting or settling gesture by one frame.
 *
 * `restSeconds` is non-null exactly once, on the frame the strip comes to rest,
 * and is the time a commit should seek to. The component only commits then, so
 * audio never follows the finger and never lands on a moving strip.
 */
export function advanceConveyor(
  gesture: ConveyorGesture,
  dtSeconds: number,
  bounds: ConveyorBounds,
): { gesture: ConveyorGesture; restSeconds: number | null } {
  if (gesture.phase === "dragging" || dtSeconds <= 0) return { gesture, restSeconds: null };

  if (gesture.phase === "coasting") {
    const decay = Math.exp(-COAST_DECAY_PER_SECOND * dtSeconds);
    const travelledSeconds = (gesture.speedSecondsPerSecond * (1 - decay)) / COAST_DECAY_PER_SECOND;
    let offsetSeconds = gesture.offsetSeconds + travelledSeconds;
    let speedSecondsPerSecond = gesture.speedSecondsPerSecond * decay;

    // A fling stops at the end of rendered audio rather than overshooting into
    // silence, so it never needs a long snap-back. A *drag* can still be taken
    // further by hand (see updateDrag) and settles back deliberately.
    const maxOffset = bounds.maxSeekSeconds - gesture.baseSeconds;
    const minOffset = -gesture.baseSeconds;
    if (offsetSeconds > maxOffset) {
      offsetSeconds = maxOffset;
      speedSecondsPerSecond = 0;
    } else if (offsetSeconds < minOffset) {
      offsetSeconds = minOffset;
      speedSecondsPerSecond = 0;
    }

    const targetOffsetSeconds =
      clampSeconds(gesture.baseSeconds + offsetSeconds, bounds.maxSeekSeconds) - gesture.baseSeconds;

    if (Math.abs(speedSecondsPerSecond) >= COAST_REST_SECONDS_PER_SECOND) {
      return {
        gesture: { ...gesture, offsetSeconds, speedSecondsPerSecond },
        restSeconds: null,
      };
    }

    // Hand the leftover motion to the spring so the strip eases in with a small
    // overshoot instead of stopping dead.
    return {
      gesture: {
        phase: "settling",
        baseSeconds: gesture.baseSeconds,
        offsetSeconds,
        targetOffsetSeconds,
        speedSecondsPerSecond,
        hasReportedRest: false,
      },
      restSeconds: null,
    };
  }

  const next = stepSettleSpring(gesture, gesture.targetOffsetSeconds, dtSeconds);
  const advanced: SettlingGesture = {
    ...gesture,
    offsetSeconds: next.offsetSeconds,
    speedSecondsPerSecond: next.speedSecondsPerSecond,
  };

  // Rest is delivered exactly once per gesture.
  if (gesture.hasReportedRest) return { gesture, restSeconds: null };
  if (!isSettleAtRest(next, gesture.targetOffsetSeconds)) {
    return { gesture: advanced, restSeconds: null };
  }

  return {
    gesture: {
      ...advanced,
      offsetSeconds: gesture.targetOffsetSeconds,
      speedSecondsPerSecond: 0,
      hasReportedRest: true,
    },
    restSeconds: clampSeconds(
      gesture.baseSeconds + gesture.targetOffsetSeconds,
      bounds.maxSeekSeconds,
    ),
  };
}

/** Where the strip currently sits, in timeline seconds. */
export function gestureCenterSeconds(gesture: ConveyorGesture): number {
  return gesture.baseSeconds + gesture.offsetSeconds;
}

/** True while the strip is still moving under its own momentum. */
export function isMovingGesture(gesture: ConveyorGesture | null): boolean {
  return gesture !== null && gesture.phase !== "dragging";
}

/* ── Layout and scale ─────────────────────────────────────── */

/**
 * Strip scale reference: the average chunk duration, so one window shows
 * `windowSize` chunks' worth of time and a 30s chunk is drawn wider than a 3s
 * one. Taken over every known slot rather than the visible ones so the scale
 * does not change as the strip slides.
 */
export function averageDurationSeconds(slots: readonly TimelineSlotData[]): number {
  if (slots.length === 0) return 4;
  let total = 0;
  for (const slot of slots) total += slot.durationSeconds;
  return total / slots.length || 4;
}

/** Slots in view: 3 on a phone, up to 5 on a wide screen, unless overridden. */
export function resolveConveyorWindowSize(
  setting: ConveyorWindowSize,
  stripWidthPx: number,
): number {
  if (setting !== "auto") return setting;
  if (stripWidthPx < 480) return 3;
  if (stripWidthPx < 900) return 4;
  return 5;
}

export function conveyorPxPerSecond(
  stripWidthPx: number,
  windowSize: number,
  averageDuration: number,
): number {
  if (stripWidthPx <= 0 || windowSize <= 0 || averageDuration <= 0) return 0;
  return stripWidthPx / (windowSize * averageDuration);
}

/** X of timeline position 0 relative to the strip's left edge. */
export function conveyorTrackOriginPx(
  stripWidthPx: number,
  centerSeconds: number,
  pxPerSecond: number,
): number {
  return stripWidthPx / 2 - centerSeconds * pxPerSecond;
}

/** Inclusive index range of slots overlapping a time window. */
export function visibleSlotIndexes(
  cumulativeStartTimes: readonly number[],
  slots: readonly Pick<TimelineSlotData, "durationSeconds">[],
  fromSeconds: number,
  toSeconds: number,
): { first: number; last: number } {
  if (slots.length === 0) return { first: 0, last: -1 };
  let first = slots.length - 1;
  for (let i = 0; i < slots.length; i += 1) {
    const endSeconds = (cumulativeStartTimes[i] ?? 0) + slots[i].durationSeconds;
    if (endSeconds > fromSeconds) {
      first = i;
      break;
    }
  }
  let last = slots.length - 1;
  for (let i = first; i < slots.length; i += 1) {
    if ((cumulativeStartTimes[i] ?? 0) >= toSeconds) {
      last = i - 1;
      break;
    }
  }
  return last < first ? { first: 0, last: -1 } : { first, last };
}

/** Index of the slot containing a timeline position, clamped to the last slot. */
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
