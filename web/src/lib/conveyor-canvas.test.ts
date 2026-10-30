import { describe, expect, test, vi } from "vitest";

import type { TimelineSlotData } from "../types/timeline";
import {
  createConveyorScene,
  paintConveyor,
  readConveyorPalette,
  sizeConveyorCanvas,
  type ConveyorViewport,
} from "./conveyor-canvas";
import { buildCumulativeStartTimes } from "./waveform-timeline";

function recordingContext() {
  type Color = string | CanvasGradient;
  const fills: { color: Color; alpha: number; x: number; y: number; width: number; height: number }[] = [];
  const pills: { color: Color; alpha: number }[] = [];
  const stack: { alpha: number; color: Color }[] = [];
  const gradient = { addColorStop: vi.fn() };
  const context = {
    globalAlpha: 1,
    fillStyle: "" as Color,
    strokeStyle: "",
    lineWidth: 1,
    font: "",
    textAlign: "",
    textBaseline: "",
    save: vi.fn(() => stack.push({ alpha: context.globalAlpha, color: context.fillStyle })),
    restore: vi.fn(() => {
      const state = stack.pop();
      if (!state) throw new Error("Unbalanced canvas restore");
      context.globalAlpha = state.alpha;
      context.fillStyle = state.color;
    }),
    clearRect: vi.fn(),
    translate: vi.fn(),
    beginPath: vi.fn(),
    rect: vi.fn(),
    clip: vi.fn(),
    roundRect: vi.fn(),
    fill: vi.fn(() => pills.push({ color: context.fillStyle, alpha: context.globalAlpha })),
    createLinearGradient: vi.fn(() => gradient as unknown as CanvasGradient),
    stroke: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    fillText: vi.fn(),
    fillRect: vi.fn((x: number, y: number, width: number, height: number) => {
      fills.push({ color: context.fillStyle, alpha: context.globalAlpha, x, y, width, height });
    }),
  };
  return { context, ctx: context as unknown as CanvasRenderingContext2D, fills, pills, gradient };
}

function slots(...states: TimelineSlotData["state"][]): TimelineSlotData[] {
  return states.map((state, chunkIndex) => ({ state, chunkIndex, durationSeconds: 4 }));
}

function sceneFor(list = slots("ready", "ready", "ready")) {
  return createConveyorScene(list, buildCumulativeStartTimes(list), new Map(), 40);
}

function viewport(overrides: Partial<ConveyorViewport> = {}): ConveyorViewport {
  return {
    width: 320,
    height: 64,
    centerSeconds: 6,
    renderedDurationSeconds: 12,
    palette: { amber: "#f59e0b", active: "#active", bar: "#bar", muted: "#muted" },
    ...overrides,
  };
}

describe("conveyor vector painting", () => {
  test("draws visible chunks in order at fractional positions without moving a DOM layer", () => {
    const { ctx, context } = recordingContext();
    const scene = sceneFor();
    paintConveyor(ctx, scene, viewport());
    expect(context.translate.mock.calls).toEqual([[-80, 0], [80, 0], [240, 0]]);
    expect(context.fillText.mock.calls.map(call => call[0])).toEqual(["1", "2", "3"]);
    context.translate.mockClear();

    paintConveyor(ctx, scene, viewport({ centerSeconds: 6.001 }));
    expect(context.translate.mock.calls[0][0]).toBeCloseTo(-80.04, 8);
    expect(context.translate.mock.calls[1][0]).toBeCloseTo(79.96, 8);
    expect(context.save).toHaveBeenCalledTimes(context.restore.mock.calls.length);
    expect(context.globalAlpha).toBe(1);
  });

  test("motion and fractional amber fill use the SAME frame position", () => {
    const { ctx, context, gradient } = recordingContext();
    const scene = sceneFor(slots("playing"));
    // 160px slot => 30 bars => first bar spans 4/30 seconds.
    paintConveyor(ctx, scene, viewport({ centerSeconds: 0.05 }));
    expect(context.createLinearGradient).toHaveBeenCalledTimes(1);
    expect(context.createLinearGradient).toHaveBeenCalledWith(4, 0, 7, 0);
    const fraction = 0.05 / (4 / 30);
    expect(gradient.addColorStop.mock.calls).toEqual([
      [0, "#f59e0b"], [fraction, "#f59e0b"], [fraction, "#bar"], [1, "#bar"],
    ]);
  });

  test("keeps failed/missing chunks unfilled and draws the broken-signal treatment", () => {
    const { ctx, context, pills } = recordingContext();
    paintConveyor(ctx, sceneFor(slots("failed", "missing_expected")), viewport());
    expect(pills.some(pill => pill.color === "#f59e0b")).toBe(false);
    expect(context.stroke).toHaveBeenCalledTimes(1);
    expect(context.roundRect).toHaveBeenCalled();
  });

  test("played chunks recede and gaps retain their different tint", () => {
    const { ctx, fills, pills } = recordingContext();
    paintConveyor(ctx, sceneFor(slots("played", "ready_after_gap")), viewport());
    const backgrounds = fills.filter(fill => fill.color === "#muted");
    expect(backgrounds.map(fill => fill.alpha)).toEqual([0.4, 1]);
    const amber = pills.filter(pill => pill.color === "#f59e0b");
    expect(amber.some(fill => fill.alpha === 0.4)).toBe(true);
    expect(amber.some(fill => fill.alpha === 0.7)).toBe(true);
  });

  test("draws no amber until audio is rendered", () => {
    const { ctx, pills } = recordingContext();
    paintConveyor(ctx, sceneFor(), viewport({ renderedDurationSeconds: 0 }));
    expect(pills.some(pill => pill.color === "#f59e0b")).toBe(false);
  });

  test("paints each pill once, without overlapping fills or per-pill clips that can pulse", () => {
    const { ctx, context, fills, pills } = recordingContext();
    paintConveyor(ctx, sceneFor(slots("played", "playing", "ready")), viewport({ centerSeconds: 6.01 }));
    expect(pills.length).toBe(context.roundRect.mock.calls.length);
    // Only the chunk boundaries/backgrounds clip or fillRect. There is never
    // a second antialiased layer over a played OR partially played pill.
    expect(context.clip).toHaveBeenCalledTimes(3);
    expect(fills).toHaveLength(3);
    expect(context.createLinearGradient).toHaveBeenCalledTimes(1);
  });

  test("pools analyzed peaks once per layout, not on every animation frame", () => {
    const list = slots("ready");
    const scene = createConveyorScene(list, [0], new Map([[0, new Float32Array([0.2, 1])]]), 40);
    const first = scene.bars(0);
    expect(Math.max(...first)).toBe(1);
    expect(scene.bars(0)).toBe(first);
    const { ctx } = recordingContext();
    paintConveyor(ctx, scene, viewport({ centerSeconds: 0 }));
    paintConveyor(ctx, scene, viewport({ centerSeconds: 0.001 }));
    expect(scene.bars(0)).toBe(first);
  });

  test("a book-sized scene reads only the visible chunks plus logarithmic lookup", () => {
    let reads = 0;
    const list = new Proxy(slots(...Array<TimelineSlotData["state"]>(10_000).fill("ready")), {
      get(target, key, receiver) {
        if (typeof key === "string" && /^\d+$/.test(key)) reads += 1;
        return Reflect.get(target, key, receiver);
      },
    });
    const starts = buildCumulativeStartTimes(list);
    const scene = createConveyorScene(list, starts, new Map(), 40);
    const { ctx, context } = recordingContext();
    reads = 0;
    paintConveyor(ctx, scene, viewport({ centerSeconds: 20_002 }));
    expect(context.fillText.mock.calls.length).toBeLessThanOrEqual(3);
    expect(reads).toBeLessThan(40);
  });

  test("empty or unmeasured scenes clear safely without preparing bars", () => {
    const { ctx, context } = recordingContext();
    paintConveyor(ctx, createConveyorScene([], [], new Map(), 0), viewport());
    expect(context.clearRect).toHaveBeenCalledWith(0, 0, 320, 64);
    expect(context.roundRect).not.toHaveBeenCalled();
  });
});

describe("canvas backing pixels and palette", () => {
  test("uses device-pixel backing dimensions without resetting them on every frame", () => {
    let writes = 0;
    let width = 0;
    let height = 0;
    const canvas = {
      get width() { return width; },
      set width(value: number) { width = value; writes += 1; },
      get height() { return height; },
      set height(value: number) { height = value; writes += 1; },
    } as HTMLCanvasElement;
    sizeConveyorCanvas(canvas, 320, 64, 1.5);
    expect([width, height]).toEqual([480, 96]);
    expect(writes).toBe(2);
    sizeConveyorCanvas(canvas, 320, 64, 1.5);
    expect(writes).toBe(2);
    sizeConveyorCanvas(canvas, 320, 64, 2);
    expect([width, height]).toEqual([640, 128]);
  });

  test("reads the same CSS colors as the overview, including a changed theme", () => {
    const canvas = document.createElement("canvas");
    document.body.append(canvas);
    canvas.style.setProperty("--amber", "#d97706");
    canvas.style.setProperty("--waveform-bar-dim", "rgba(0,0,0,0.12)");
    expect(readConveyorPalette(canvas).amber).toBe("#d97706");
    expect(readConveyorPalette(canvas).bar).toBe("rgba(0,0,0,0.12)");
    canvas.style.setProperty("--amber", "#f59e0b");
    expect(readConveyorPalette(canvas).amber).toBe("#f59e0b");
    canvas.remove();
  });
});
