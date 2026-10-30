import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

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
  const pills: { color: string; alpha: number }[] = [];
  const draws: { image: HTMLCanvasElement; alpha: number }[] = [];
  const stack: number[] = [];
  const context = {
    globalAlpha: 1, fillStyle: "", strokeStyle: "", lineWidth: 1,
    font: "", textAlign: "", textBaseline: "",
    save: vi.fn(() => stack.push(context.globalAlpha)),
    restore: vi.fn(() => {
      const alpha = stack.pop();
      if (alpha === undefined) throw new Error("Unbalanced canvas restore");
      context.globalAlpha = alpha;
    }),
    getTransform: vi.fn(() => ({ a: 1, d: 1 })),
    setTransform: vi.fn(), clearRect: vi.fn(), beginPath: vi.fn(),
    rect: vi.fn(), clip: vi.fn(), roundRect: vi.fn(),
    fill: vi.fn(() => pills.push({ color: context.fillStyle, alpha: context.globalAlpha })),
    stroke: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(), fillText: vi.fn(), fillRect: vi.fn(),
    drawImage: vi.fn<(image: HTMLCanvasElement, x: number, y: number, width: number, height: number) => void>((image) => {
      draws.push({ image, alpha: context.globalAlpha });
    }),
  };
  return { context, ctx: context as unknown as CanvasRenderingContext2D, pills, draws };
}

const rasters = new Map<HTMLCanvasElement, ReturnType<typeof recordingContext>>();
beforeEach(() => {
  rasters.clear();
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(function (this: HTMLCanvasElement) {
    const recording = recordingContext();
    rasters.set(this, recording);
    return recording.ctx;
  });
});
afterEach(() => vi.restoreAllMocks());

function slots(...states: TimelineSlotData["state"][]): TimelineSlotData[] {
  return states.map((state, chunkIndex) => ({ state, chunkIndex, durationSeconds: 4 }));
}
function sceneFor(list = slots("ready", "ready", "ready")) {
  return createConveyorScene(list, buildCumulativeStartTimes(list), new Map(), 40);
}
const palette = { amber: "#f59e0b", active: "#active", bar: "#bar", muted: "#muted" };
function viewport(overrides: Partial<ConveyorViewport> = {}): ConveyorViewport {
  return { width: 320, height: 64, centerSeconds: 6, renderedDurationSeconds: 12, palette, ...overrides };
}
function rasterPills() { return [...rasters.values()].flatMap(recording => recording.pills); }

describe("conveyor native-resolution artwork", () => {
  test("moves rigid artwork fractionally without moving a DOM layer or rebuilding contours", () => {
    const { ctx, context } = recordingContext();
    const scene = sceneFor();
    paintConveyor(ctx, scene, viewport());
    expect(context.drawImage.mock.calls.map(call => call[1])).toEqual([-80, 80, 80, 240]);
    expect(new Set([...rasters.values()].flatMap(r => r.context.fillText.mock.calls.map(c => c[0]))))
      .toEqual(new Set(["1", "2", "3"]));
    expect(rasters.size).toBe(6);
    context.drawImage.mockClear();
    paintConveyor(ctx, scene, viewport({ centerSeconds: 6.001 }));
    expect(context.drawImage.mock.calls[0][1]).toBeCloseTo(-80.04, 8);
    expect(context.drawImage.mock.calls[1][1]).toBeCloseTo(79.96, 8);
    expect(rasters.size).toBe(6);
    expect(context.roundRect).not.toHaveBeenCalled();
    expect(context.save).toHaveBeenCalledTimes(context.restore.mock.calls.length);
    expect(context.globalAlpha).toBe(1);
  });

  test("motion and disjoint played/unplayed regions share the SAME frame position", () => {
    const { ctx, context } = recordingContext();
    paintConveyor(ctx, sceneFor(slots("playing")), viewport({ centerSeconds: 0.05 }));
    expect(context.rect.mock.calls).toEqual([[158, 0, 2, 64], [160, 0, 158, 64]]);
    expect(context.drawImage.mock.calls.map(call => call[1])).toEqual([158, 158]);
    expect(context.clip).toHaveBeenCalledTimes(2);
  });

  test("keeps failed/missing chunks unfilled and caches the broken-signal treatment", () => {
    const { ctx } = recordingContext();
    paintConveyor(ctx, sceneFor(slots("failed", "missing_expected")), viewport());
    expect(rasterPills().some(pill => pill.color === palette.amber)).toBe(false);
    expect([...rasters.values()].reduce((n, r) => n + r.context.stroke.mock.calls.length, 0)).toBe(1);
    expect(rasters.size).toBe(2); // No unnecessary amber copies of non-fill slots.
  });

  test("played chunks recede and gaps retain their different tint", () => {
    const { ctx, draws } = recordingContext();
    paintConveyor(ctx, sceneFor(slots("played", "ready_after_gap")), viewport());
    expect(draws[0].alpha).toBe(0.4);
    const amber = rasterPills().filter(pill => pill.color === palette.amber);
    expect(amber.some(pill => pill.alpha === 0.7)).toBe(true);
  });

  test("draws no amber until audio is rendered", () => {
    const { ctx, draws } = recordingContext();
    paintConveyor(ctx, sceneFor(), viewport({ renderedDurationSeconds: 0 }));
    for (const draw of draws) {
      expect(rasters.get(draw.image)?.pills.some(pill => pill.color === palette.amber)).toBe(false);
    }
  });

  test("never supersamples or rescales rounded backing dimensions to fractional slot widths", () => {
    const { ctx, context } = recordingContext();
    context.getTransform.mockReturnValue({ a: 1.5, d: 1.5 });
    const list = [{ chunkIndex: 0, state: "playing" as const, durationSeconds: 4.013 }];
    paintConveyor(ctx, sceneFor(list), viewport({ centerSeconds: 2 }));
    for (const [image, , , width, height] of context.drawImage.mock.calls) {
      expect(image.width).toBe(Math.ceil(4.013 * 40 * 1.5));
      expect(width * 1.5).toBe(image.width);
      expect(height * 1.5).toBe(image.height);
    }
    for (const r of rasters.values()) expect(r.context.setTransform).toHaveBeenCalledWith(1.5, 0, 0, 1.5, 0, 0);
  });

  test("rebuilds artwork only for changed palette, height or native monitor density", () => {
    const scene = sceneFor(slots("playing"));
    const { ctx, context } = recordingContext();
    const theme = { ...palette, amber: "#d97706" };
    paintConveyor(ctx, scene, viewport());
    expect(rasters.size).toBe(2);
    paintConveyor(ctx, scene, viewport({ centerSeconds: 6.001 }));
    expect(rasters.size).toBe(2);
    paintConveyor(ctx, scene, viewport({ palette: theme }));
    expect(rasters.size).toBe(4);
    context.getTransform.mockReturnValue({ a: 2, d: 2 });
    paintConveyor(ctx, scene, viewport({ palette: theme }));
    expect(rasters.size).toBe(6);
    paintConveyor(ctx, scene, viewport({ palette: theme }));
    expect(rasters.size).toBe(6);
    paintConveyor(ctx, scene, viewport({ palette: theme, height: 60 }));
    expect(rasters.size).toBe(8);
  });

  test("releases offscreen artwork instead of retaining a book of raster images", () => {
    const scene = sceneFor(slots(...Array<TimelineSlotData["state"]>(100).fill("ready")));
    const { ctx, draws } = recordingContext();
    paintConveyor(ctx, scene, viewport({ centerSeconds: 6 }));
    const originalImage = draws[0].image;
    paintConveyor(ctx, scene, viewport({ centerSeconds: 200 }));
    draws.length = 0;
    paintConveyor(ctx, scene, viewport({ centerSeconds: 6 }));
    expect(draws[0].image).not.toBe(originalImage);
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

  test("a book-sized scene prepares only visible artwork with logarithmic lookup", () => {
    let reads = 0;
    const list = new Proxy(slots(...Array<TimelineSlotData["state"]>(10_000).fill("ready")), {
      get(target, key, receiver) {
        if (typeof key === "string" && /^\d+$/.test(key)) reads += 1;
        return Reflect.get(target, key, receiver);
      },
    });
    const starts = buildCumulativeStartTimes(list);
    const scene = createConveyorScene(list, starts, new Map(), 40);
    const { ctx } = recordingContext();
    reads = 0;
    paintConveyor(ctx, scene, viewport({ centerSeconds: 20_002 }));
    expect(rasters.size).toBeLessThanOrEqual(6);
    expect(reads).toBeLessThan(45);
  });

  test("empty or unmeasured scenes clear safely without preparing artwork", () => {
    const { ctx, context } = recordingContext();
    paintConveyor(ctx, createConveyorScene([], [], new Map(), 0), viewport());
    expect(context.clearRect).toHaveBeenCalledWith(0, 0, 320, 64);
    expect(rasters.size).toBe(0);
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
