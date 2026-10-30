import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { createConveyorScene, paintConveyor } from "../lib/conveyor-canvas";
import type { TimelineSlotData } from "../types/timeline";
import { ChunkConveyor } from "./ChunkConveyor";

vi.mock("../lib/conveyor-canvas", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/conveyor-canvas")>();
  return {
    ...actual,
    createConveyorScene: vi.fn(actual.createConveyorScene),
    paintConveyor: vi.fn(),
  };
});

beforeEach(() => {
  vi.stubGlobal("matchMedia", vi.fn((media: string) => ({
    media,
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  })));
  vi.mocked(createConveyorScene).mockClear();
  vi.mocked(paintConveyor).mockClear();
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    setTransform: vi.fn(),
  } as unknown as CanvasRenderingContext2D);
});

/** Last vector draw, not a CSS transform or a synthetic DOM playhead. */
function lastPaint() {
  const call = vi.mocked(paintConveyor).mock.calls.at(-1);
  if (!call) throw new Error("Expected the conveyor to paint");
  return { scene: call[1], viewport: call[2] };
}

/* jsdom has no PointerEvent; the strip is driven entirely by pointer input. */
class TestPointerEvent extends MouseEvent {
  readonly pointerId: number;
  readonly pointerType: string;

  constructor(type: string, init: PointerEventInit = {}) {
    super(type, init);
    this.pointerId = init.pointerId ?? 1;
    this.pointerType = init.pointerType ?? "mouse";
  }
}

Object.defineProperty(window, "PointerEvent", {
  configurable: true,
  value: TestPointerEvent,
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  // The deterministic-frame harness stubs requestAnimationFrame; without this
  // the stub leaks and every later tap test waits forever for a frame.
  vi.unstubAllGlobals();
});

/* ── Fixtures ─────────────────────────────────────────────── */

const STRIP_WIDTH = 800;

function buildSlots(count: number, durationSeconds = 4): TimelineSlotData[] {
  return Array.from({ length: count }, (_, chunkIndex) => ({
    chunkIndex,
    state: "ready",
    durationSeconds,
  }));
}

function buildProps(overrides: Partial<Parameters<typeof ChunkConveyor>[0]> = {}) {
  return {
    slots: buildSlots(6),
    waveforms: new Map<number, Float32Array>(),
    playheadSeconds: 6,
    maxSeekSeconds: 16,
    motion: "animated" as const,
    isPlaying: false,
    playbackRate: 1,
    windowSizeSetting: "auto" as const,
    onSeek: vi.fn(),
    stripHeightPx: 64,
    ...overrides,
  };
}

/**
 * jsdom performs no layout, so the hook measures nothing and the strip would
 * have zero width. Pin a real rect for every element instead.
 */
function mockLayout(width = STRIP_WIDTH) {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    left: 0,
    right: width,
    top: 0,
    bottom: 64,
    width,
    height: 64,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  } as DOMRect);
}

function strip() {
  return screen.getByTestId("chunk-conveyor");
}

function tap(clientX: number, pointerId = 1) {
  fireEvent.pointerDown(strip(), { button: 0, clientX, pointerId });
  fireEvent.pointerUp(strip(), { clientX, pointerId });
}

/* ── Rendering ────────────────────────────────────────────── */

describe("ChunkConveyor rendering", () => {
  test("shows the live position in the readout at the fixed playhead", () => {
    mockLayout();
    render(<ChunkConveyor {...buildProps({ playheadSeconds: 6 })} />);

    expect(screen.getByTestId("conveyor-readout")).toHaveTextContent("0:06");
    expect(screen.getByTestId("conveyor-playhead")).toBeInTheDocument();
  });

  test("draws decorative vectors in one fixed canvas, not translated DOM slots", () => {
    mockLayout();
    const { container } = render(<ChunkConveyor {...buildProps()} />);
    const canvas = screen.getByTestId("conveyor-canvas");
    expect(strip()).toHaveAttribute("role", "group");
    expect(canvas.tagName).toBe("CANVAS");
    expect(canvas).toHaveAttribute("aria-hidden", "true");
    expect(canvas.style.transform).toBe("");
    expect(canvas.style.filter).toBe("");
    expect(container.querySelectorAll('[role="slider"], [data-waveform-slot]')).toHaveLength(0);
    expect(lastPaint().scene.slots.map(slot => slot.chunkIndex)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  test("shows an empty state before any chunk is planned", () => {
    mockLayout();
    render(<ChunkConveyor {...buildProps({ slots: [] })} />);

    expect(screen.getByText("No chunks to display")).toBeInTheDocument();
    expect(screen.getByTestId("chunk-conveyor")).toBeInTheDocument();
  });

  test("a larger window setting makes each chunk narrower", () => {
    mockLayout();
    const { unmount } = render(
      <ChunkConveyor {...buildProps({ playheadSeconds: 8, windowSizeSetting: 3 })} />,
    );
    const wideScale = lastPaint().scene.pxPerSecond;
    unmount();

    render(<ChunkConveyor {...buildProps({ playheadSeconds: 8, windowSizeSetting: 5 })} />);
    expect(wideScale).toBeGreaterThan(lastPaint().scene.pxPerSecond);
  });

  test("reduced motion snaps the strip to the chunk boundary instead of sliding", () => {
    mockLayout();
    const { unmount } = render(<ChunkConveyor {...buildProps({ playheadSeconds: 6 })} />);
    expect(screen.getByTestId("conveyor-readout")).toHaveTextContent("0:06");
    unmount();

    // With reduced motion the window advances one chunk at a time, so the
    // readout sits on the start of the chunk containing the playhead.
    render(<ChunkConveyor {...buildProps({ motion: "reduced", playheadSeconds: 6 })} />);
    expect(screen.getByTestId("conveyor-readout")).toHaveTextContent("0:04");
  });
});

/* ── Tapping ──────────────────────────────────────────────── */

describe("ChunkConveyor tapping", () => {
  test("a tap seeks to the exact tapped point", async () => {
    mockLayout();
    const onSeek = vi.fn();
    render(<ChunkConveyor {...buildProps({ onSeek, playheadSeconds: 6 })} />);

    // Centre is x=400 showing 6s; tapping x=500 shows 2s later (scale: 4 chunks
    // of 4s across 800px = 50px per second).
    tap(500);

    await waitFor(() => expect(onSeek).toHaveBeenCalledTimes(1));
    expect(onSeek).toHaveBeenCalledWith(2, 8);
  });

  test("a tap left of centre seeks earlier", async () => {
    mockLayout();
    const onSeek = vi.fn();
    render(<ChunkConveyor {...buildProps({ onSeek, playheadSeconds: 6 })} />);

    tap(300);

    await waitFor(() => expect(onSeek).toHaveBeenCalledTimes(1));
    expect(onSeek).toHaveBeenCalledWith(1, 4);
  });
});

/* ── Dragging ─────────────────────────────────────────────── */

describe("ChunkConveyor dragging", () => {
  /**
   * Pointer velocity is read from timestamps and the coast advances on animation
   * frames, so both are driven by hand here. That keeps these tests exact and
   * load-independent: a real-timer version of the flick test would take as long
   * as the glide and could time out on a busy machine.
   */
  let nowMs = 1000;
  let pendingFrame: FrameRequestCallback | null = null;

  function useDeterministicFrames() {
    nowMs = 1000;
    pendingFrame = null;
    vi.spyOn(performance, "now").mockImplementation(() => nowMs);
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      pendingFrame = callback;
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", () => {
      pendingFrame = null;
    });
    return {
      /** Move the clock without running a frame (between pointer events). */
      wait(ms: number) {
        nowMs += ms;
      },
      /** Run one animation frame. */
      frame(ms = 16) {
        nowMs += ms;
        const callback = pendingFrame;
        pendingFrame = null;
        if (callback) act(() => callback(nowMs));
      },
      /** Run frames until the gesture finishes (the loop stops rescheduling). */
      settle(maxFrames = 400) {
        for (let i = 0; i < maxFrames && pendingFrame; i += 1) this.frame();
      },
      get isAnimating() {
        return pendingFrame !== null;
      },
    };
  }

  test("commits nothing until the pointer is released", () => {
    mockLayout();
    const clock = useDeterministicFrames();
    const onSeek = vi.fn();
    render(<ChunkConveyor {...buildProps({ onSeek, playheadSeconds: 8 })} />);

    fireEvent.pointerDown(strip(), { button: 0, clientX: 400, pointerId: 1 });
    clock.wait(200);
    fireEvent.pointerMove(strip(), { clientX: 300, pointerId: 1 });
    clock.wait(200);
    fireEvent.pointerMove(strip(), { clientX: 250, pointerId: 1 });
    expect(onSeek).not.toHaveBeenCalled();

    fireEvent.pointerUp(strip(), { clientX: 250, pointerId: 1 });
    clock.settle();
    expect(onSeek).toHaveBeenCalledTimes(1);
  });

  test("drag direction is direct manipulation: right reveals earlier audio", () => {
    mockLayout();
    const clock = useDeterministicFrames();
    const onSeek = vi.fn();
    render(<ChunkConveyor {...buildProps({ onSeek, playheadSeconds: 8 })} />);

    // 100px right at 50px per second is 2s earlier; 100px over 300ms is a
    // deliberate drag, not a flick, so the strip settles where the finger left
    // it instead of gliding on.
    fireEvent.pointerDown(strip(), { button: 0, clientX: 400, pointerId: 1 });
    clock.wait(300);
    fireEvent.pointerMove(strip(), { clientX: 500, pointerId: 1 });
    clock.wait(300);
    fireEvent.pointerUp(strip(), { clientX: 500, pointerId: 1 });
    clock.settle();

    expect(onSeek).toHaveBeenCalledTimes(1);
    expect(onSeek).toHaveBeenCalledWith(1, 6);
  });

  test("a fast flick keeps travelling after the finger lifts", () => {
    mockLayout();
    const clock = useDeterministicFrames();
    const onSeek = vi.fn();
    render(<ChunkConveyor {...buildProps({ maxSeekSeconds: 40, onSeek, playheadSeconds: 8 })} />);

    // 13px in 10ms is 1.3px/ms — past both the flick threshold and the tap
    // slop, and leftwards so the glide continues forwards well beyond the
    // 8.26s a plain drop would have committed at.
    fireEvent.pointerDown(strip(), { button: 0, clientX: 400, pointerId: 1 });
    clock.wait(10);
    fireEvent.pointerMove(strip(), { clientX: 387, pointerId: 1 });
    clock.wait(10);
    fireEvent.pointerUp(strip(), { clientX: 387, pointerId: 1 });

    expect(clock.isAnimating).toBe(true);
    clock.settle();

    expect(onSeek).toHaveBeenCalledTimes(1);
    const [, seconds] = onSeek.mock.calls[0];
    // ≈ 8.26s + (26 - 2) / 2 of glide.
    expect(seconds).toBeGreaterThan(19);
    expect(seconds).toBeLessThan(21);
  });

  test("a flick is stopped by a touch and can be dragged from there", () => {
    mockLayout();
    const clock = useDeterministicFrames();
    const onSeek = vi.fn();
    render(<ChunkConveyor {...buildProps({ maxSeekSeconds: 40, onSeek, playheadSeconds: 8 })} />);

    fireEvent.pointerDown(strip(), { button: 0, clientX: 400, pointerId: 1 });
    clock.wait(10);
    fireEvent.pointerMove(strip(), { clientX: 387, pointerId: 1 });
    clock.wait(10);
    fireEvent.pointerUp(strip(), { clientX: 387, pointerId: 1 });
    clock.frame();
    clock.frame();

    // Catch the glide, then drag back deliberately.
    fireEvent.pointerDown(strip(), { button: 0, clientX: 380, pointerId: 2 });
    clock.wait(400);
    fireEvent.pointerMove(strip(), { clientX: 500, pointerId: 2 });
    clock.wait(400);
    fireEvent.pointerUp(strip(), { clientX: 500, pointerId: 2 });
    clock.settle();

    expect(onSeek).toHaveBeenCalledTimes(1);
    const [, seconds] = onSeek.mock.calls[0];
    // The catch interrupted the glide, so it stops well before the coast target.
    expect(seconds).toBeLessThan(19);
  });

  test("a cancelled gesture never seeks", () => {
    mockLayout();
    const onSeek = vi.fn();
    render(<ChunkConveyor {...buildProps({ onSeek })} />);

    fireEvent.pointerDown(strip(), { button: 0, clientX: 400, pointerId: 1 });
    fireEvent.pointerMove(strip(), { clientX: 250, pointerId: 1 });
    fireEvent.pointerCancel(strip(), { pointerId: 1 });

    expect(onSeek).not.toHaveBeenCalled();
    expect(screen.getByTestId("conveyor-readout")).toHaveTextContent("0:06");
  });

  test("ignores secondary mouse buttons", () => {
    mockLayout();
    const onSeek = vi.fn();
    render(<ChunkConveyor {...buildProps({ onSeek })} />);

    fireEvent.pointerDown(strip(), { button: 2, clientX: 500, pointerId: 1 });
    fireEvent.pointerUp(strip(), { clientX: 500, pointerId: 1 });

    expect(onSeek).not.toHaveBeenCalled();
  });

  test("ignores pointer events from a different pointer", () => {
    mockLayout();
    const onSeek = vi.fn();
    render(<ChunkConveyor {...buildProps({ onSeek })} />);

    fireEvent.pointerDown(strip(), { button: 0, clientX: 400, pointerId: 1 });
    fireEvent.pointerUp(strip(), { clientX: 500, pointerId: 2 });

    expect(onSeek).not.toHaveBeenCalled();
  });
});

/* ── Tapping past a gap ───────────────────────────────────── */

describe("ChunkConveyor tapping beyond gaps", () => {
  /** Chunk 1 has no audio, chunk 2 does: the contiguous run ends at 4s. */
  const GAP_SLOTS: TimelineSlotData[] = [
    { chunkIndex: 0, state: "ready", durationSeconds: 4 },
    { chunkIndex: 1, state: "missing_expected", durationSeconds: 4 },
    { chunkIndex: 2, state: "ready", durationSeconds: 4 },
  ];

  function buildGapProps(overrides: Partial<Parameters<typeof ChunkConveyor>[0]> = {}) {
    return buildProps({ maxSeekSeconds: 4, playheadSeconds: 0, slots: GAP_SLOTS, ...overrides });
  }

  test("a tap on a rendered chunk past a gap commits exactly there", async () => {
    mockLayout();
    const onSeek = vi.fn();
    render(<ChunkConveyor {...buildGapProps({ onSeek })} />);

    // 8s is the start of chunk 3, which already has audio beyond the gap.
    // Scale is 50px/s, so x=800 is 8s right of the centred playhead.
    tap(800);

    await waitFor(() => expect(onSeek).toHaveBeenCalledTimes(1));
    expect(onSeek).toHaveBeenCalledWith(2, 8);
  });

  test("a tap on a chunk with no audio still clamps to rendered audio", async () => {
    mockLayout();
    const onSeek = vi.fn();
    render(<ChunkConveyor {...buildGapProps({ onSeek })} />);

    // 5s is inside the unrendered chunk, so the commit holds at 4s.
    tap(650);

    await waitFor(() => expect(onSeek).toHaveBeenCalledTimes(1));
    expect(onSeek).toHaveBeenCalledWith(1, 4);
  });
});

/* ── Idle slide ───────────────────────────────────────────── */

describe("ChunkConveyor idle slide", () => {
  /**
   * Deterministic frames, like the drag tests. The strip owns its own clock
   * while playing, so the transform must keep moving *between* playhead
   * reports instead of waiting for the next ~20Hz prop update.
   */
  let nowMs = 1000;
  let pendingFrame: FrameRequestCallback | null = null;

  function useDeterministicFrames() {
    nowMs = 1000;
    pendingFrame = null;
    vi.spyOn(performance, "now").mockImplementation(() => nowMs);
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      pendingFrame = callback;
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", () => {
      pendingFrame = null;
    });
    return {
      frame(ms = 1000 / 60) {
        nowMs += ms;
        const callback = pendingFrame;
        pendingFrame = null;
        if (callback) act(() => callback(nowMs));
      },
    };
  }

  /** Current painted origin in CSS px (the canvas itself never moves). */
  function trackX(): number {
    const { scene, viewport } = lastPaint();
    return viewport.width / 2 - viewport.centerSeconds * scene.pxPerSecond;
  }

  test("advances on every animation frame between playhead reports", () => {
    mockLayout();
    const clock = useDeterministicFrames();
    const props = buildProps({ isPlaying: true, playheadSeconds: 8 });
    const { rerender } = render(<ChunkConveyor {...props} />);

    // 800px / (4 chunks x 4s) = 50px per second.
    const start = trackX();
    clock.frame();
    clock.frame();
    clock.frame();
    const afterThreeFrames = trackX();
    // Three frames at 1x is 50ms of timeline = 2.5px. A prop-driven strip would
    // still be sitting still here (the next report is ~50ms away).
    expect(start - afterThreeFrames).toBeCloseTo(2.5, 0);

    // A new report that is *behind* the predicted clock must not yank the strip
    // back: it is the stale sample, and the strip has already travelled past it.
    // The next frame still advances by roughly the normal 16.7ms (0.83px).
    rerender(<ChunkConveyor {...props} playheadSeconds={8.02} />);
    clock.frame();
    // 50px/s for one 60Hz frame is 0.83px.
    expect(afterThreeFrames - trackX()).toBeCloseTo(50 / 60, 1);
  });

  test("snaps to a seek instead of easing across the jump", () => {
    mockLayout();
    const clock = useDeterministicFrames();
    const props = buildProps({ isPlaying: true, playheadSeconds: 8 });
    const { rerender } = render(<ChunkConveyor {...props} />);
    clock.frame();

    // Centre at 12s with 50px/s: the track origin is 400 - 12 * 50 = -200px.
    rerender(<ChunkConveyor {...props} playheadSeconds={12} />);
    clock.frame();
    expect(trackX()).toBeCloseTo(-200, 0);
  });

  test("stops driving frames when playback pauses", () => {
    mockLayout();
    const clock = useDeterministicFrames();
    const props = buildProps({ isPlaying: true, playheadSeconds: 8 });
    const { rerender } = render(<ChunkConveyor {...props} />);
    clock.frame();
    clock.frame();

    rerender(<ChunkConveyor {...props} isPlaying={false} playheadSeconds={8} />);
    const paused = trackX();
    clock.frame();
    clock.frame();
    expect(trackX()).toBe(paused);
  });
});

/* ── Tick cost ────────────────────────────────────────────── */

describe("ChunkConveyor playback ticks", () => {
  test("does not prepare geometry or paint from a playback report while the frame loop owns it", () => {
    mockLayout();
    const props = buildProps({ playheadSeconds: 6, isPlaying: true });
    const { rerender } = render(<ChunkConveyor {...props} />);
    vi.mocked(createConveyorScene).mockClear();
    vi.mocked(paintConveyor).mockClear();

    rerender(<ChunkConveyor {...props} playheadSeconds={6.1} />);

    expect(createConveyorScene).not.toHaveBeenCalled();
    expect(paintConveyor).not.toHaveBeenCalled();
  });

  test("redraws a paused seek without starting a frame loop", () => {
    mockLayout();
    const props = buildProps({ playheadSeconds: 6 });
    const { rerender } = render(<ChunkConveyor {...props} />);
    rerender(<ChunkConveyor {...props} playheadSeconds={9} />);
    expect(lastPaint().viewport.centerSeconds).toBe(9);
  });

  test("updates backing pixels even when monitor density changes while paused", () => {
    mockLayout();
    vi.stubGlobal("devicePixelRatio", 1);
    render(<ChunkConveyor {...buildProps()} />);
    const canvas = screen.getByTestId("conveyor-canvas");
    expect(canvas).toHaveAttribute("width", "800");
    vi.stubGlobal("devicePixelRatio", 2);
    fireEvent(window, new Event("resize"));
    expect(canvas).toHaveAttribute("width", "1600");
    expect(canvas).toHaveAttribute("height", "128");
  });
});
