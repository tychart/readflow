import { conveyorTrackOriginPx, visibleSlotIndexes } from "../features/reader/conveyor-physics";
import type { TimelineSlotData } from "../types/timeline";
import {
  BAR_GAP_PX,
  BAR_RADIUS_PX,
  BAR_WIDTH_PX,
  MIN_BAR_HEIGHT,
  SLOT_H_PADDING_PX,
} from "./waveform-style";
import {
  barCountForWidth,
  barFillFraction,
  isNonFillState,
  isSlotDimmed,
  waveformForSlot,
} from "./waveform-timeline";

export interface ConveyorPalette {
  amber: string;
  active: string;
  bar: string;
  muted: string;
}

/** Read on mount/theme changes, never from the animation frame loop. */
export function readConveyorPalette(element: HTMLElement): ConveyorPalette {
  const style = getComputedStyle(element);
  return {
    amber: style.getPropertyValue("--amber").trim() || "#f59e0b",
    active: style.getPropertyValue("--amber-soft").trim() || "rgba(245,158,11,0.15)",
    bar: style.getPropertyValue("--waveform-bar-dim").trim() || "rgba(255,255,255,0.18)",
    muted: style.getPropertyValue("--waveform-bar-muted").trim() || "rgba(255,255,255,0.10)",
  };
}

/**
 * Immutable layout plus lazily pooled peaks. Only visible chunks are prepared;
 * a clock tick never scans or resamples the document. Replaced when the slot
 * data, peaks or scale change, not when the playhead changes.
 */
export function createConveyorScene(
  slots: readonly TimelineSlotData[],
  starts: readonly number[],
  waveforms: ReadonlyMap<number, Float32Array>,
  pxPerSecond: number,
) {
  const peaks = new Map<number, Float32Array>();
  return {
    slots,
    starts,
    pxPerSecond,
    bars(index: number) {
      let bars = peaks.get(index);
      if (!bars) {
        const slot = slots[index];
        const count = barCountForWidth(
          slot.durationSeconds * pxPerSecond,
          BAR_WIDTH_PX + BAR_GAP_PX,
          SLOT_H_PADDING_PX,
        );
        bars = waveformForSlot(waveforms.get(slot.chunkIndex), slot, count);
        peaks.set(index, bars);
      }
      return bars;
    },
  };
}

export type ConveyorScene = ReturnType<typeof createConveyorScene>;

export interface ConveyorViewport {
  width: number;
  height: number;
  centerSeconds: number;
  renderedDurationSeconds: number;
  palette: ConveyorPalette;
}

/**
 * Vector redraw into a stationary canvas. Do NOT translate a DOM/canvas layer
 * or move a cached bitmap: Firefox still visibly jitters at ~5px/s on a 1x
 * display. Direct canvas vectors were smooth in the user's minimal A/B test
 * (DOM jittered for every shape; SVG still jittered for rounded rectangles).
 *
 * Fractional coordinates are intentional. Motion AND playback fill use the
 * same centerSeconds, so there is no independent 20Hz fill repaint.
 */
export function paintConveyor(
  ctx: CanvasRenderingContext2D,
  scene: ConveyorScene,
  { width, height, centerSeconds, renderedDurationSeconds, palette }: ConveyorViewport,
) {
  ctx.clearRect(0, 0, width, height);
  if (width <= 0 || height <= 0 || scene.pxPerSecond <= 0) return;
  const halfWindow = width / scene.pxPerSecond / 2;
  const { first, last } = visibleSlotIndexes(
    scene.starts,
    scene.slots,
    centerSeconds - halfWindow,
    centerSeconds + halfWindow,
  );
  const origin = conveyorTrackOriginPx(width, centerSeconds, scene.pxPerSecond);
  for (let index = first; index <= last; index += 1) {
    const slot = scene.slots[index];
    const start = scene.starts[index];
    const x = origin + start * scene.pxPerSecond;
    const slotWidth = slot.durationSeconds * scene.pxPerSecond;
    const nonFill = isNonFillState(slot.state);
    const gap = slot.state === "ready_after_gap";
    const bars = scene.bars(index);

    ctx.save();
    ctx.translate(x, 0);
    ctx.beginPath();
    ctx.rect(0, 0, slotWidth, height);
    ctx.clip();
    const slotAlpha = isSlotDimmed(slot, start, centerSeconds) ? 0.4 : 1;
    ctx.globalAlpha = slotAlpha;
    let background = palette.muted;
    if (slot.state === "failed") background = "rgba(136,19,55,0.30)";
    else if (slot.state === "missing_expected") background = "rgba(136,19,55,0.15)";
    else if (slot.state === "playing") background = palette.active;
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, slotWidth, height);

    if (slot.state === "missing_expected") {
      ctx.save();
      ctx.strokeStyle = "rgba(239,68,68,0.10)";
      ctx.lineWidth = 2;
      ctx.beginPath();
      for (let line = -height; line < slotWidth; line += 8) {
        ctx.moveTo(line, height);
        ctx.lineTo(line + height, 0);
      }
      ctx.stroke();
      ctx.restore();
    }

    ctx.globalAlpha = slotAlpha * (gap ? 0.7 : 1);
    for (let i = 0; i < bars.length; i += 1) {
      const barX = SLOT_H_PADDING_PX / 2 + i * (BAR_WIDTH_PX + BAR_GAP_PX);
      const barHeight = Math.max(MIN_BAR_HEIGHT, bars[i]) * (height - 8);
      const barY = height - barHeight;
      const fill = nonFill ? 0 : barFillFraction(
        centerSeconds,
        start + (i / bars.length) * slot.durationSeconds,
        start + ((i + 1) / bars.length) * slot.durationSeconds,
        renderedDurationSeconds,
      );
      let color: string | CanvasGradient = fill >= 1 ? palette.amber : palette.bar;
      if (nonFill) color = slot.state === "failed" ? "rgba(244,63,94,0.6)" : palette.muted;
      if (fill > 0 && fill < 1) {
        const split = ctx.createLinearGradient(barX, 0, barX + BAR_WIDTH_PX, 0);
        split.addColorStop(0, palette.amber);
        split.addColorStop(fill, palette.amber);
        split.addColorStop(fill, palette.bar);
        split.addColorStop(1, palette.bar);
        color = split;
      }
      // Exactly ONE fill per pill. A clipped amber overlay over a muted pill
      // double-antialiases moving edges and makes played bars pulse at 1x DPR.
      ctx.beginPath();
      ctx.roundRect(
        barX, barY, BAR_WIDTH_PX, barHeight,
        Math.min(BAR_RADIUS_PX, BAR_WIDTH_PX / 2, barHeight / 2),
      );
      ctx.fillStyle = color;
      ctx.fill();
    }

    ctx.globalAlpha = slotAlpha;
    ctx.fillStyle = "rgba(255,255,255,0.4)";
    ctx.font = "600 9px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "bottom";
    ctx.fillText(String(slot.chunkIndex + 1), slotWidth / 2, height - 4);
    ctx.restore();
  }
}

/** Backing pixels follow monitor scale without changing the CSS viewport. */
export function sizeConveyorCanvas(
  canvas: HTMLCanvasElement,
  width: number,
  height: number,
  dpr: number,
) {
  const pixelWidth = Math.max(1, Math.round(width * dpr));
  const pixelHeight = Math.max(1, Math.round(height * dpr));
  if (canvas.width !== pixelWidth) canvas.width = pixelWidth;
  if (canvas.height !== pixelHeight) canvas.height = pixelHeight;
}
