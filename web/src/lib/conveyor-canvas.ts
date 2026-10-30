import { conveyorTrackOriginPx, visibleSlotIndexes } from "../features/reader/conveyor-physics";
import type { TimelineSlotData } from "../types/timeline";
import {
  BAR_GAP_PX,
  BAR_RADIUS_PX,
  BAR_WIDTH_PX,
  MIN_BAR_HEIGHT,
  SLOT_H_PADDING_PX,
} from "./waveform-style";
import { barCountForWidth, isNonFillState, isSlotDimmed, waveformForSlot } from "./waveform-timeline";

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

/** Static artwork, rasterized ONCE at the viewport's native pixel density. */
function rasterizeSlot(
  slot: TimelineSlotData,
  bars: Float32Array,
  width: number,
  height: number,
  scaleX: number,
  scaleY: number,
  palette: ConveyorPalette,
  played: boolean,
): HTMLCanvasElement | null {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.ceil(width * scaleX));
  canvas.height = Math.max(1, Math.ceil(height * scaleY));
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.setTransform(scaleX, 0, 0, scaleY, 0, 0);

  let background = palette.muted;
  if (slot.state === "failed") background = "rgba(136,19,55,0.30)";
  else if (slot.state === "missing_expected") background = "rgba(136,19,55,0.15)";
  else if (slot.state === "playing") background = palette.active;
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, width, height);

  if (slot.state === "missing_expected") {
    ctx.strokeStyle = "rgba(239,68,68,0.10)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let line = -height; line < width; line += 8) {
      ctx.moveTo(line, height);
      ctx.lineTo(line + height, 0);
    }
    ctx.stroke();
  }

  const nonFill = isNonFillState(slot.state);
  ctx.fillStyle = played ? palette.amber : palette.bar;
  if (nonFill) ctx.fillStyle = slot.state === "failed" ? "rgba(244,63,94,0.6)" : palette.muted;
  if (slot.state === "ready_after_gap") ctx.globalAlpha = played ? 0.7 : 0.5;
  for (let i = 0; i < bars.length; i += 1) {
    const barX = SLOT_H_PADDING_PX / 2 + i * (BAR_WIDTH_PX + BAR_GAP_PX);
    const barHeight = Math.max(MIN_BAR_HEIGHT, bars[i]) * Math.max(0, height - 8);
    ctx.beginPath();
    ctx.roundRect(
      barX, height - barHeight, BAR_WIDTH_PX, barHeight,
      Math.min(BAR_RADIUS_PX, BAR_WIDTH_PX / 2, barHeight / 2),
    );
    ctx.fill();
  }
  ctx.globalAlpha = 1;
  ctx.fillStyle = "rgba(255,255,255,0.4)";
  ctx.font = "600 9px system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "bottom";
  ctx.fillText(String(slot.chunkIndex + 1), width / 2, height - 4);
  return canvas;
}

/**
 * Geometry/peaks/artwork cache owned by a layout, not by the playback clock.
 * Only visible slots are prepared. A new scene drops superseded slot/peak data;
 * theme or monitor-density changes replace the affected artwork lazily.
 */
export function createConveyorScene(
  slots: readonly TimelineSlotData[],
  starts: readonly number[],
  waveforms: ReadonlyMap<number, Float32Array>,
  pxPerSecond: number,
) {
  const peaks = new Map<number, Float32Array>();
  const images = new Map<number, {
    height: number;
    scaleX: number;
    scaleY: number;
    palette: ConveyorPalette;
    unplayed: HTMLCanvasElement;
    played: HTMLCanvasElement;
  }>();
  const bars = (index: number) => {
    let data = peaks.get(index);
    if (!data) {
      const slot = slots[index];
      const count = barCountForWidth(
        slot.durationSeconds * pxPerSecond, BAR_WIDTH_PX + BAR_GAP_PX, SLOT_H_PADDING_PX,
      );
      data = waveformForSlot(waveforms.get(slot.chunkIndex), slot, count);
      peaks.set(index, data);
    }
    return data;
  };
  return {
    slots, starts, pxPerSecond, bars,
    retainImages(first: number, last: number) {
      for (const index of images.keys()) {
        if (index < first || index > last) images.delete(index);
      }
    },
    texture(index: number, height: number, scaleX: number, scaleY: number, palette: ConveyorPalette) {
      let cached = images.get(index);
      if (cached && cached.height === height && cached.scaleX === scaleX
        && cached.scaleY === scaleY && cached.palette === palette) return cached;
      const slot = slots[index];
      const width = slot.durationSeconds * pxPerSecond;
      const data = bars(index);
      const unplayed = rasterizeSlot(slot, data, width, height, scaleX, scaleY, palette, false);
      const played = isNonFillState(slot.state)
        ? unplayed : rasterizeSlot(slot, data, width, height, scaleX, scaleY, palette, true);
      if (!unplayed || !played) return null;
      cached = { height, scaleX, scaleY, palette, unplayed, played };
      images.set(index, cached);
      return cached;
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
 * Stationary canvas; rigid native-resolution artwork moves inside it.
 *
 * Re-rasterizing thin rounded bars at each fractional position makes their
 * antialiased contours crawl. Native cached artwork was clean in the user's
 * same-page Firefox/Vivaldi comparison; 2x/3x caches reintroduced the artifact.
 * Never supersample these textures or scale their rounded pixel dimensions
 * back to a fractional slot width. Preserve one source pixel per backing pixel.
 */
export function paintConveyor(
  ctx: CanvasRenderingContext2D,
  scene: ConveyorScene,
  { width, height, centerSeconds, renderedDurationSeconds, palette }: ConveyorViewport,
) {
  ctx.clearRect(0, 0, width, height);
  if (width <= 0 || height <= 0 || scene.pxPerSecond <= 0) return;
  const { a: scaleX, d: scaleY } = ctx.getTransform();
  const halfWindow = width / scene.pxPerSecond / 2;
  const { first, last } = visibleSlotIndexes(
    scene.starts, scene.slots, centerSeconds - halfWindow, centerSeconds + halfWindow,
  );
  const origin = conveyorTrackOriginPx(width, centerSeconds, scene.pxPerSecond);
  scene.retainImages(first, last);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  for (let index = first; index <= last; index += 1) {
    const slot = scene.slots[index];
    const start = scene.starts[index];
    const x = origin + start * scene.pxPerSecond;
    const slotWidth = slot.durationSeconds * scene.pxPerSecond;
    const texture = scene.texture(index, height, scaleX, scaleY, palette);
    if (!texture) continue;
    const fillWidth = isNonFillState(slot.state) || renderedDurationSeconds <= 0
      ? 0 : Math.max(0, Math.min(slotWidth, (centerSeconds - start) * scene.pxPerSecond));
    ctx.save();
    ctx.globalAlpha = isSlotDimmed(slot, start, centerSeconds) ? 0.4 : 1;
    // Disjoint color regions: no amber-over-muted edge double-compositing.
    for (const [image, left, regionWidth] of [
      [texture.played, 0, fillWidth],
      [texture.unplayed, fillWidth, slotWidth - fillWidth],
    ] as const) {
      if (regionWidth <= 0) continue;
      ctx.save();
      ctx.beginPath();
      ctx.rect(x + left, 0, regionWidth, height);
      ctx.clip();
      ctx.drawImage(image, x, 0, image.width / scaleX, image.height / scaleY);
      ctx.restore();
    }
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
