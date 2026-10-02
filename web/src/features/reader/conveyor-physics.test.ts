import { describe, expect, test } from "vitest";

import type { TimelineSlotData } from "../../types/timeline";
import {
  advanceConveyor,
  averageDurationSeconds,
  beginDrag,
  clampSeconds,
  COAST_DECAY_PER_SECOND,
  COAST_REST_SECONDS_PER_SECOND,
  conveyorPxPerSecond,
  conveyorTrackOriginPx,
  endDrag,
  FLICK_VELOCITY_PX_PER_MS,
  gestureCenterSeconds,
  isFlick,
  isMovingGesture,
  isRenderedState,
  isSettleAtRest,
  isTap,
  pxPerMsToStripSpeed,
  resolveConveyorWindowSize,
  slotAtSeconds,
  slotIndexAtSeconds,
  stepSettleSpring,
  updateDrag,
  velocityFromSamples,
  visibleSlotIndexes,
  type ConveyorBounds,
  type ConveyorGesture,
  type DraggingGesture,
} from "./conveyor-physics";

/* ── Helpers ──────────────────────────────────────────────── */

function slots(durations: number[]): TimelineSlotData[] {
  return durations.map((durationSeconds, chunkIndex) => ({
    chunkIndex,
    state: "ready",
    durationSeconds,
  }));
}

const BOUNDS: ConveyorBounds = { maxSeekSeconds: 12, maxVisualSeconds: 20 };
const PX_PER_SECOND = 100;
const FRAME_SECONDS = 1 / 60;

/** Run a gesture to rest, returning how long it took and where it stopped. */
function runToRest(gesture: ConveyorGesture, bounds = BOUNDS, maxFrames = 600) {
  let current = gesture;
  let frames = 0;
  let finished: number | null = null;
  while (frames < maxFrames && finished === null) {
    const step = advanceConveyor(current, FRAME_SECONDS, bounds);
    current = step.gesture;
    finished = step.restSeconds;
    frames += 1;
  }
  return { frames, restSeconds: finished, center: gestureCenterSeconds(current), gesture: current };
}

function cumulative(durations: number[]): number[] {
  const starts: number[] = [];
  let running = 0;
  for (const duration of durations) {
    starts.push(running);
    running += duration;
  }
  return starts;
}

/* ── Conversions ──────────────────────────────────────────── */

describe("clampSeconds", () => {
  test("bounds a position into the playable range", () => {
    expect(clampSeconds(5, 12)).toBe(5);
    expect(clampSeconds(-3, 12)).toBe(0);
    expect(clampSeconds(40, 12)).toBe(12);
  });
});

describe("pxPerMsToStripSpeed", () => {
  test("converts a pointer speed into strip seconds per second", () => {
    expect(pxPerMsToStripSpeed(1, 100)).toBe(10);
    expect(pxPerMsToStripSpeed(-0.5, 50)).toBe(-10);
  });

  test("is zero without a measured scale", () => {
    expect(pxPerMsToStripSpeed(1, 0)).toBe(0);
  });
});

describe("velocityFromSamples", () => {
  test("needs two samples", () => {
    expect(velocityFromSamples([])).toBe(0);
    expect(velocityFromSamples([{ x: 10, atMs: 0 }])).toBe(0);
  });

  test("measures px/ms across the samples", () => {
    expect(
      velocityFromSamples([
        { x: 0, atMs: 1000 },
        { x: 100, atMs: 1100 },
      ]),
    ).toBeCloseTo(1, 6);
  });

  test("ignores an older pause instead of reading it as motion", () => {
    // A long press, then a quick 20px move: the flick is the 20px, not the 500px.
    const velocity = velocityFromSamples([
      { x: 0, atMs: 0 },
      { x: 500, atMs: 1000 },
      { x: 520, atMs: 1010 },
    ]);
    expect(velocity).toBeCloseTo(2, 6);
  });

  test("returns zero when the window has no duration", () => {
    expect(
      velocityFromSamples([
        { x: 0, atMs: 1000 },
        { x: 100, atMs: 1000 },
      ]),
    ).toBe(0);
  });
});

describe("isFlick", () => {
  test("uses a speed threshold, in either direction", () => {
    expect(isFlick(FLICK_VELOCITY_PX_PER_MS - 0.01)).toBe(false);
    expect(isFlick(FLICK_VELOCITY_PX_PER_MS)).toBe(true);
    expect(isFlick(-FLICK_VELOCITY_PX_PER_MS * 2)).toBe(true);
  });
});

describe("isTap", () => {
  test("tolerates a few px of unavoidable finger drift", () => {
    expect(isTap(100, 100)).toBe(true);
    expect(isTap(100, 104)).toBe(true);
    expect(isTap(100, 130)).toBe(false);
  });
});

/* ── Dragging ─────────────────────────────────────────────── */

describe("beginDrag / updateDrag", () => {
  test("direct manipulation: dragging right reveals earlier audio", () => {
    let gesture: DraggingGesture = beginDrag(10, 200, 0);
    // 25px right at 100px/s = 0.25s earlier.
    gesture = updateDrag(gesture, 225, 16, PX_PER_SECOND, BOUNDS);
    expect(gestureCenterSeconds(gesture)).toBeCloseTo(9.75, 6);
  });

  test("dragging left moves forward in time", () => {
    const gesture = updateDrag(beginDrag(10, 200, 0), 150, 16, PX_PER_SECOND, BOUNDS);
    expect(gestureCenterSeconds(gesture)).toBeCloseTo(10.5, 6);
  });

  test("cannot be dragged before the start or past the document", () => {
    const backwards = updateDrag(beginDrag(1, 200, 0), 999, 16, PX_PER_SECOND, BOUNDS);
    expect(gestureCenterSeconds(backwards)).toBeCloseTo(0, 6);

    const forwards = updateDrag(beginDrag(10, 0, 0), -9999, 16, PX_PER_SECOND, BOUNDS);
    expect(gestureCenterSeconds(forwards)).toBeCloseTo(BOUNDS.maxVisualSeconds, 6);
  });

  test("keeps a bounded sample history", () => {
    let gesture = beginDrag(10, 0, 0);
    for (let i = 1; i <= 40; i += 1) {
      gesture = updateDrag(gesture, i, i * 16, PX_PER_SECOND, BOUNDS);
    }
    expect(gesture.samples.length).toBeLessThanOrEqual(9);
    expect(gesture.samples.at(-1)?.x).toBe(40);
  });
});

/* ── Release ──────────────────────────────────────────────── */

/** Bounds with room to coast, for isolating the physics from the clamps. */
const OPEN_BOUNDS: ConveyorBounds = { maxSeekSeconds: 500, maxVisualSeconds: 500 };

describe("endDrag", () => {
  test("a drop settles in place and comes to rest on the spot", () => {
    const dragging = updateDrag(beginDrag(10, 0, 0), 50, 200, PX_PER_SECOND, BOUNDS);
    const released = endDrag(dragging, 400, PX_PER_SECOND, "animated", BOUNDS);
    expect(released.phase).toBe("settling");

    const { restSeconds } = runToRest(released);
    expect(restSeconds).toBeCloseTo(gestureCenterSeconds(dragging), 6);
  });

  test("a fast flick coasts in the direction the finger was moving", () => {
    // Rightwards drag = earlier audio, so a rightwards flick coasts backwards.
    let rightwards = beginDrag(10, 0, 0);
    rightwards = updateDrag(rightwards, 30, 20, PX_PER_SECOND, BOUNDS);
    rightwards = updateDrag(rightwards, 60, 40, PX_PER_SECOND, BOUNDS);
    const back = endDrag(rightwards, 50, PX_PER_SECOND, "animated", BOUNDS);
    expect(back.phase).toBe("coasting");
    expect(back.phase === "coasting" && back.speedSecondsPerSecond).toBeLessThan(0);

    // A leftwards flick coasts forwards.
    let leftwards = beginDrag(10, 0, 0);
    leftwards = updateDrag(leftwards, -30, 20, PX_PER_SECOND, BOUNDS);
    leftwards = updateDrag(leftwards, -60, 40, PX_PER_SECOND, BOUNDS);
    const forward = endDrag(leftwards, 50, PX_PER_SECOND, "animated", BOUNDS);
    expect(forward.phase).toBe("coasting");
    expect(forward.phase === "coasting" && forward.speedSecondsPerSecond).toBeGreaterThan(0);
  });

  test("a flick travels much further than the finger did", () => {
    let dragging = beginDrag(50, 0, 0);
    dragging = updateDrag(dragging, -30, 20, PX_PER_SECOND, OPEN_BOUNDS);
    dragging = updateDrag(dragging, -60, 40, PX_PER_SECOND, OPEN_BOUNDS);

    const from = gestureCenterSeconds(dragging);
    const { restSeconds } = runToRest(
      endDrag(dragging, 50, PX_PER_SECOND, "animated", OPEN_BOUNDS),
      OPEN_BOUNDS,
    );

    // The finger covered 0.6s; the glide covers several seconds.
    expect(restSeconds - from).toBeGreaterThan(5);
  });

  test("a tap moves the strip so the tapped point lands under the playhead", () => {
    // Tapped 50px right of centre: that point shows 0.5s later content, so the
    // strip must scroll 0.5s forward to bring it under the playhead.
    const dragging = beginDrag(10, 150, 0);
    const released = endDrag(dragging, 20, PX_PER_SECOND, "animated", BOUNDS, {
      alignmentOffsetSeconds: 0.5,
    });
    expect(released.phase).toBe("settling");

    const { restSeconds } = runToRest(released);
    expect(restSeconds).toBeCloseTo(10.5, 6);
  });

  test("a tap in the centre is a no-op seek to the current position", () => {
    const released = endDrag(beginDrag(10, 150, 0), 20, PX_PER_SECOND, "animated", BOUNDS, {
      alignmentOffsetSeconds: 0,
    });
    const { restSeconds } = runToRest(released);
    expect(restSeconds).toBeCloseTo(10, 6);
  });

  test("a tap can never target unrendered audio", () => {
    // Tapped 500px right of centre = +5s, but only 12s is rendered.
    const released = endDrag(beginDrag(10, 0, 0), 20, PX_PER_SECOND, "animated", BOUNDS, {
      alignmentOffsetSeconds: 5,
    });
    const { restSeconds } = runToRest(released);
    expect(restSeconds).toBeCloseTo(BOUNDS.maxSeekSeconds, 6);
  });

  test("a tap on an already-rendered chunk may commit past the contiguous run", () => {
    // Commits normally clamp to the end of contiguous rendered audio (12s here),
    // but a chunk at 14s already has audio, so tapping it is an explicit request
    // to go there — the same thing a click on the main timeline does.
    const released = endDrag(beginDrag(0, 0, 0), 20, PX_PER_SECOND, "animated", BOUNDS, {
      alignmentOffsetSeconds: 14,
      allowsUnrenderedTarget: true,
    });

    expect(runToRest(released).restSeconds).toBeCloseTo(14, 6);
  });

  test("momentum never gets to land past rendered audio", () => {
    const { restSeconds, center } = runToRest(
      { phase: "coasting", baseSeconds: 0, offsetSeconds: 0, speedSecondsPerSecond: 500 },
      BOUNDS,
    );
    expect(restSeconds).toBeCloseTo(BOUNDS.maxSeekSeconds, 6);
    expect(center).toBeCloseTo(BOUNDS.maxSeekSeconds, 6);
  });

  test("settles back to the rendered boundary when the drag is released past it", () => {
    // Dragged well past the rendered end, then released slowly (not a flick).
    let dragging = updateDrag(beginDrag(6, 0, 0), -2000, 16, PX_PER_SECOND, BOUNDS);
    dragging = updateDrag(dragging, -2000, 400, PX_PER_SECOND, BOUNDS);
    expect(gestureCenterSeconds(dragging)).toBeCloseTo(BOUNDS.maxVisualSeconds, 6);

    const { restSeconds, center } = runToRest(
      endDrag(dragging, 600, PX_PER_SECOND, "animated", BOUNDS),
      BOUNDS,
    );
    expect(restSeconds).toBeCloseTo(BOUNDS.maxSeekSeconds, 6);
    expect(center).toBeCloseTo(BOUNDS.maxSeekSeconds, 6);
  });

  test("reduced motion snaps straight onto the target with no inertia", () => {
    let dragging = beginDrag(10, 0, 0);
    dragging = updateDrag(dragging, 30, 20, PX_PER_SECOND, BOUNDS);
    dragging = updateDrag(dragging, 60, 40, PX_PER_SECOND, BOUNDS);

    const released = endDrag(dragging, 50, PX_PER_SECOND, "reduced", BOUNDS);
    expect(released.phase).toBe("settling");
    // Already on target with no speed, so the first frame reports rest.
    expect(released.phase === "settling" && released.offsetSeconds).toBe(
      released.phase === "settling" ? released.targetOffsetSeconds : null,
    );
    expect(released.phase === "settling" && released.speedSecondsPerSecond).toBe(0);
    expect(advanceConveyor(released, FRAME_SECONDS, BOUNDS).restSeconds).not.toBeNull();
  });
});

/* ── Coasting and settling ────────────────────────────────── */

describe("advanceConveyor", () => {
  const OPEN: ConveyorBounds = { maxSeekSeconds: 500, maxVisualSeconds: 500 };

  test("a dragging gesture never reports rest", () => {
    const dragging = beginDrag(10, 0, 0);
    expect(advanceConveyor(dragging, FRAME_SECONDS, BOUNDS).restSeconds).toBeNull();
  });

  test("a coast slows down monotonically and hands over to the spring", () => {
    let gesture: ConveyorGesture = {
      phase: "coasting",
      baseSeconds: 0,
      offsetSeconds: 0,
      speedSecondsPerSecond: 20,
    };
    const speeds: number[] = [];
    let handover: ConveyorGesture | null = null;

    for (let frame = 0; frame < 600 && handover === null; frame += 1) {
      const step = advanceConveyor(gesture, FRAME_SECONDS, OPEN);
      gesture = step.gesture;
      if (gesture.phase === "settling") handover = gesture;
      else speeds.push(Math.abs(gesture.speedSecondsPerSecond));
    }

    expect(handover).not.toBeNull();
    for (let i = 1; i < speeds.length; i += 1) {
      expect(speeds[i]).toBeLessThan(speeds[i - 1]);
    }
    // The handover happens as the coast crosses the rest speed.
    expect(speeds.at(-1)).toBeLessThan(COAST_REST_SECONDS_PER_SECOND * 1.05);
    expect(handover?.phase === "settling" && handover.speedSecondsPerSecond).toBeLessThan(
      COAST_REST_SECONDS_PER_SECOND,
    );
  });

  test("glide distance grows with flick speed", () => {
    // Total travel is (speed - restSpeed) / decay, independent of the zoom.
    const speed = 20;
    const { center } = runToRest(
      { phase: "coasting", baseSeconds: 0, offsetSeconds: 0, speedSecondsPerSecond: speed },
      OPEN,
    );
    expect(center).toBeGreaterThan(8.5);
    expect(center).toBeLessThan(9.5);
    expect(center).toBeCloseTo((speed - COAST_REST_SECONDS_PER_SECOND) / COAST_DECAY_PER_SECOND, 1);
  });

  test("comes to rest exactly once, on the commit target", () => {
    let gesture: ConveyorGesture = {
      phase: "coasting",
      baseSeconds: 4,
      offsetSeconds: 0,
      speedSecondsPerSecond: 8,
    };
    let rests = 0;
    for (let frame = 0; frame < 600; frame += 1) {
      const step = advanceConveyor(gesture, FRAME_SECONDS, BOUNDS);
      gesture = step.gesture;
      if (step.restSeconds !== null) {
        rests += 1;
        // 4s base + (8 - 2) / 2 ≈ 7s of glide, inside the 12s playable range.
        expect(step.restSeconds).toBeCloseTo(7, 1);
      }
    }
    expect(rests).toBe(1);
    // The strip really is on the target when the commit fires.
    expect(gestureCenterSeconds(gesture)).toBeCloseTo(7, 1);
  });

  test("a fling stops at the end of rendered audio instead of overshooting", () => {
    const { restSeconds, center } = runToRest({
      phase: "coasting",
      baseSeconds: 0,
      offsetSeconds: 0,
      speedSecondsPerSecond: 500,
    });
    expect(restSeconds).toBeCloseTo(BOUNDS.maxSeekSeconds, 6);
    expect(center).toBeCloseTo(BOUNDS.maxSeekSeconds, 6);
  });

  test("a backwards fling stops at the start of the document", () => {
    const { restSeconds } = runToRest({
      phase: "coasting",
      baseSeconds: 2,
      offsetSeconds: 0,
      speedSecondsPerSecond: -500,
    });
    expect(restSeconds).toBeCloseTo(0, 6);
  });

  test("a zero or negative frame step changes nothing", () => {
    const gesture: ConveyorGesture = {
      phase: "coasting",
      baseSeconds: 0,
      offsetSeconds: 1,
      speedSecondsPerSecond: 5,
    };
    expect(advanceConveyor(gesture, 0, BOUNDS).gesture).toBe(gesture);
  });
});

describe("stepSettleSpring / isSettleAtRest", () => {
  test("converges on the target", () => {
    let state = { offsetSeconds: -2, speedSecondsPerSecond: 0 };
    const target = 0;
    for (let frame = 0; frame < 600 && !isSettleAtRest(state, target); frame += 1) {
      state = stepSettleSpring(state, target, FRAME_SECONDS);
    }
    expect(isSettleAtRest(state, target)).toBe(true);
    expect(Math.abs(state.offsetSeconds - target)).toBeLessThan(0.01);
  });

  test("is underdamped, so it eases in past the target rather than stopping dead", () => {
    let state = { offsetSeconds: -1, speedSecondsPerSecond: 0 };
    let overshot = false;
    for (let frame = 0; frame < 600; frame += 1) {
      state = stepSettleSpring(state, 0, FRAME_SECONDS);
      if (state.offsetSeconds > 0.005) overshot = true;
      if (isSettleAtRest(state, 0)) break;
    }
    expect(overshot).toBe(true);
  });

  test("absorbs a leftover coasting speed as a settle jiggle", () => {
    // A settled strip with residual speed must not fly off: it should ease in
    // and stop on the target.
    let state = { offsetSeconds: 0, speedSecondsPerSecond: 5 };
    let peak = 0;
    for (let frame = 0; frame < 600; frame += 1) {
      state = stepSettleSpring(state, 0, FRAME_SECONDS);
      peak = Math.max(peak, Math.abs(state.offsetSeconds));
      if (isSettleAtRest(state, 0)) break;
    }
    expect(peak).toBeLessThan(0.5);
    expect(isSettleAtRest(state, 0)).toBe(true);
  });

  test("is stable over a long frame (backgrounded tab)", () => {
    const state = stepSettleSpring({ offsetSeconds: -2, speedSecondsPerSecond: 0 }, 0, 0.064);
    expect(Number.isFinite(state.offsetSeconds)).toBe(true);
    expect(Math.abs(state.offsetSeconds)).toBeLessThan(2.5);
  });
});

describe("gesture helpers", () => {
  test("only coasting and settling count as moving", () => {
    expect(isMovingGesture(null)).toBe(false);
    expect(isMovingGesture(beginDrag(0, 0, 0))).toBe(false);
    expect(
      isMovingGesture({
        phase: "coasting",
        baseSeconds: 0,
        offsetSeconds: 0,
        speedSecondsPerSecond: 1,
      }),
    ).toBe(true);
  });
});

/* ── Layout ───────────────────────────────────────────────── */

describe("averageDurationSeconds", () => {
  test("averages the slots", () => {
    expect(averageDurationSeconds(slots([4, 4, 4]))).toBe(4);
    expect(averageDurationSeconds(slots([2, 6]))).toBe(4);
  });

  test("falls back for an empty or zero-duration set", () => {
    expect(averageDurationSeconds([])).toBe(4);
    expect(averageDurationSeconds(slots([0, 0]))).toBe(4);
  });
});

describe("resolveConveyorWindowSize", () => {
  test("an explicit setting wins", () => {
    expect(resolveConveyorWindowSize(3, 1400)).toBe(3);
    expect(resolveConveyorWindowSize(5, 300)).toBe(5);
  });

  test("auto scales from 3 on a phone to 5 on a wide screen", () => {
    expect(resolveConveyorWindowSize("auto", 360)).toBe(3);
    expect(resolveConveyorWindowSize("auto", 700)).toBe(4);
    expect(resolveConveyorWindowSize("auto", 1200)).toBe(5);
  });
});

describe("conveyorPxPerSecond", () => {
  test("one window shows windowSize chunks' worth of time", () => {
    expect(conveyorPxPerSecond(800, 4, 5)).toBe(40);
  });

  test("is zero before the strip has been measured", () => {
    expect(conveyorPxPerSecond(0, 4, 5)).toBe(0);
    expect(conveyorPxPerSecond(800, 0, 5)).toBe(0);
    expect(conveyorPxPerSecond(800, 4, 0)).toBe(0);
  });
});

describe("conveyorTrackOriginPx", () => {
  test("puts the centre time under the middle of the strip", () => {
    // Time 10 at 40px/s must sit 400px left of the centre of an 800px strip.
    expect(conveyorTrackOriginPx(800, 10, 40)).toBe(400 - 400);
    expect(conveyorTrackOriginPx(800, 0, 40)).toBe(400);
  });
});

describe("visibleSlotIndexes", () => {
  const starts = cumulative([4, 4, 4, 4, 4]);

  test("returns every slot overlapping the window", () => {
    expect(visibleSlotIndexes(starts, slots([4, 4, 4, 4, 4]), 0, 8)).toEqual({ first: 0, last: 1 });
    expect(visibleSlotIndexes(starts, slots([4, 4, 4, 4, 4]), 4, 12)).toEqual({ first: 1, last: 2 });
  });

  test("includes a slot the window starts inside", () => {
    expect(visibleSlotIndexes(starts, slots([4, 4, 4, 4, 4]), 6, 7)).toEqual({ first: 1, last: 1 });
  });

  test("clamps to the document at both ends", () => {
    expect(visibleSlotIndexes(starts, slots([4, 4, 4, 4, 4]), -50, 1)).toEqual({ first: 0, last: 0 });
    expect(visibleSlotIndexes(starts, slots([4, 4, 4, 4, 4]), 18, 50)).toEqual({ first: 4, last: 4 });
  });

  test("reports an empty range for no slots", () => {
    expect(visibleSlotIndexes([], [], 0, 10)).toEqual({ first: 0, last: -1 });
  });
});

describe("slotIndexAtSeconds", () => {
  test("finds the containing slot and clamps to the last", () => {
    const starts = cumulative([4, 4, 4]);
    expect(slotIndexAtSeconds(starts, 0)).toBe(0);
    expect(slotIndexAtSeconds(starts, 5)).toBe(1);
    expect(slotIndexAtSeconds(starts, 99)).toBe(2);
    expect(slotIndexAtSeconds([], 5)).toBe(0);
  });
});

describe("isRenderedState", () => {
  test("only states with audio behind them count as rendered", () => {
    expect(isRenderedState("ready")).toBe(true);
    expect(isRenderedState("ready_after_gap")).toBe(true);
    expect(isRenderedState("playing")).toBe(true);
    expect(isRenderedState("played")).toBe(true);
    expect(isRenderedState("missing_expected")).toBe(false);
    expect(isRenderedState("failed")).toBe(false);
  });
});

describe("slotAtSeconds", () => {
  const list = slots([4, 4, 4]);

  test("finds the slot under a position", () => {
    expect(slotAtSeconds(list, cumulative([4, 4, 4]), 5)?.chunkIndex).toBe(1);
  });

  test("is null without slots", () => {
    expect(slotAtSeconds([], [], 5)).toBeNull();
  });
});
