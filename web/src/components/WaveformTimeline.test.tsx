import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { maxPool } from "../lib/waveform";
import { WaveformTimeline, type TimelineSlotData } from "./WaveformTimeline";

/* jsdom does not implement PointerEvent; provide a minimal polyfill so the
 * pointer-based scrub interactions can be exercised in tests. */
class TestPointerEvent extends MouseEvent {
  readonly pointerId: number;
  readonly pointerType: string;
  readonly isPrimary: boolean;

  constructor(type: string, init: PointerEventInit = {}) {
    super(type, init);
    this.pointerId = init.pointerId ?? 1;
    this.pointerType = init.pointerType ?? "mouse";
    this.isPrimary = init.isPrimary ?? true;
  }
}

Object.defineProperty(window, "PointerEvent", {
  configurable: true,
  value: TestPointerEvent,
});

/* ── Helpers ──────────────────────────────────────────────── */

function buildReadySlots(count: number, durationSeconds = 4): TimelineSlotData[] {
  return Array.from({ length: count }, (_, index) => ({
    chunkIndex: index,
    state: "ready" as const,
    durationSeconds,
  }));
}

/** Amber fill element inside each [data-wave-bar], or null when unfilled. */
function getBarFills(container: HTMLElement): (HTMLElement | null)[] {
  return Array.from(container.querySelectorAll("[data-wave-bar]")).map((bar) =>
    bar.querySelector<HTMLElement>("[data-wave-fill]"),
  );
}

function mockTimelineWidth(width: number) {
  const timeline = screen.getByLabelText("Audio waveform timeline");
  vi.spyOn(timeline, "getBoundingClientRect").mockReturnValue({
    left: 0,
    right: width,
    top: 0,
    bottom: 40,
    width,
    height: 40,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  } as DOMRect);
}

/* ── Tests ────────────────────────────────────────────────── */

describe("maxPool", () => {
  it("max-pools down to fewer bars, keeping loud transients", () => {
    const out = maxPool(new Float32Array([0.1, 0.5, 0.2, 0.8]), 2);
    expect(out[0]).toBeCloseTo(0.5, 5);
    expect(out[1]).toBeCloseTo(0.8, 5);
  });

  it("handles target larger than source (bars repeat source values)", () => {
    const out = maxPool(new Float32Array([0.4, 0.9]), 4);
    expect(out.length).toBe(4);
    expect(out[0]).toBeCloseTo(0.4, 5);
    expect(out[1]).toBeCloseTo(0.4, 5);
    expect(out[2]).toBeCloseTo(0.9, 5);
    expect(out[3]).toBeCloseTo(0.9, 5);
  });

  it("returns empty for empty source", () => {
    expect(maxPool(new Float32Array(0), 4).length).toBe(4);
  });

  it("returns non-positive target", () => {
    expect(maxPool(new Float32Array([0.5]), 0).length).toBe(0);
  });
});

describe("WaveformTimeline playhead coordinates", () => {
  it("positions the fill using job-timeline coordinates (0 = first slot)", () => {
    // Three 4s chunks: 0-4s, 4-8s, 8-12s. A playhead at 9s sits 1s into
    // chunk 2 — it must fill chunks 0-1 fully and chunk 2 by 25%.
    const { container } = render(
      <WaveformTimeline
        slots={buildReadySlots(3)}
        waveforms={new Map()}
        onSeek={vi.fn()}
        playheadSeconds={9}
        renderedDurationSeconds={12}
        scrollProgress={0}
      />,
    );

    const fills = getBarFills(container);
    expect(fills).toHaveLength(3);
    expect(fills[0]?.style.width).toBe("100%");
    expect(fills[1]?.style.width).toBe("100%");
    expect(fills[2]?.style.width).toBe("25%");
  });

  it("does not fill anything when the playhead is before the first bar", () => {
    const { container } = render(
      <WaveformTimeline
        slots={buildReadySlots(3)}
        waveforms={new Map()}
        onSeek={vi.fn()}
        playheadSeconds={0}
        renderedDurationSeconds={12}
        scrollProgress={0}
      />,
    );

    const fills = getBarFills(container);
    expect(fills).toHaveLength(3);
    expect(fills.every((fill) => fill === null)).toBe(true);
  });
});

describe("WaveformTimeline drag seeking", () => {
  it("previews the fill under the pointer and commits one seek on pointer-up", () => {
    const onSeek = vi.fn();
    const { container } = render(
      <WaveformTimeline
        slots={buildReadySlots(3)}
        waveforms={new Map()}
        onSeek={onSeek}
        playheadSeconds={0}
        renderedDurationSeconds={12}
        scrollProgress={0}
      />,
    );

    // 300px maps to 12s of timeline, so x=75 → 3s, x=225 → 9s.
    mockTimelineWidth(300);

    const startSlot = container.querySelector<HTMLElement>("[data-slot-state]");
    expect(startSlot).not.toBeNull();

    // Pointer down at x=75 (3s), drag to x=225 (9s), then release.
    fireEvent.pointerDown(startSlot as HTMLElement, { button: 0, clientX: 75, pointerId: 1 });
    fireEvent.pointerMove(startSlot as HTMLElement, { clientX: 225, pointerId: 1 });

    // The fill previews at 9s immediately — no seek committed yet.
    expect(onSeek).not.toHaveBeenCalled();
    const fills = getBarFills(container);
    expect(fills[0]?.style.width).toBe("100%");
    expect(fills[1]?.style.width).toBe("100%");
    expect(fills[2]?.style.width).toBe("25%");

    fireEvent.pointerUp(startSlot as HTMLElement, { clientX: 225, pointerId: 1 });

    // Exactly one committed seek at the final pointer position (job coords).
    expect(onSeek).toHaveBeenCalledTimes(1);
    expect(onSeek).toHaveBeenCalledWith(2, 9);
  });

  it("does not commit a seek when the pointer interaction is cancelled", () => {
    const onSeek = vi.fn();
    const { container } = render(
      <WaveformTimeline
        slots={buildReadySlots(3)}
        waveforms={new Map()}
        onSeek={onSeek}
        playheadSeconds={0}
        renderedDurationSeconds={12}
        scrollProgress={0}
      />,
    );

    mockTimelineWidth(300);

    const startSlot = container.querySelector<HTMLElement>("[data-slot-state]");
    fireEvent.pointerDown(startSlot as HTMLElement, { button: 0, clientX: 75, pointerId: 1 });
    fireEvent.pointerMove(startSlot as HTMLElement, { clientX: 225, pointerId: 1 });
    fireEvent.pointerCancel(startSlot as HTMLElement, { pointerId: 1 });

    expect(onSeek).not.toHaveBeenCalled();
    // Preview is discarded; the fill returns to the real playhead (0s).
    const fills = getBarFills(container);
    expect(fills.every((fill) => fill === null)).toBe(true);
  });
});
