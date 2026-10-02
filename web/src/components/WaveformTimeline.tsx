import { type PointerEvent as ReactPointerEvent, useCallback, useMemo, useRef, useState } from "react";

import { useElementWidth } from "../hooks/useElementWidth";
import {
  barCountForWidth,
  barStepPx,
  buildCumulativeStartTimes,
  pointerRatio,
  secondsAtRatio,
  slotIndexAtSeconds,
  slotWidthPx,
  totalSlotDuration,
  waveformForSlot,
} from "../lib/waveform-timeline";
import type { TimelineSlotData } from "../types/timeline";
import {
  BAR_GAP_PX,
  BAR_WIDTH_PX,
  SLOT_H_PADDING_PX,
  WaveformSlot,
  type WaveformSlotInteraction,
} from "./WaveformSlot";

/* ── Types ────────────────────────────────────────────────── */

export interface WaveformTimelineProps {
  /** Ordered list of timeline slots to render. */
  slots: TimelineSlotData[];
  /**
   * Analyzed waveform peaks per chunk index (0..1 normalized), fetched from
   * the backend. Chunks without peaks render a dim placeholder.
   */
  waveforms: Map<number, Float32Array>;
  /**
   * Current playback position in seconds, in the same coordinate space as the
   * slots (job-timeline coordinates: 0 = start of the first slot).
   *
   * Do NOT pass a stream-normalized position: the media stream resets to 0 at
   * the playback anchor, so a normalized value misplaces the fill whenever the
   * anchor is non-zero (i.e. after seeking to a later chunk).
   */
  playheadSeconds: number;
  /**
   * End of the playable range in seconds, in the same coordinate space as
   * `playheadSeconds`. Used as the playhead maximum (aria) and to gate fill
   * rendering until rendered audio exists.
   */
  renderedDurationSeconds: number;
  /**
   * Called when the user clicks/drags to seek. `seekSeconds` is an absolute
   * position in job-timeline coordinates (0 = start of the first slot).
   * For drags this fires once, on pointer-up, with the final position.
   */
  onSeek: (chunkIndex: number, seekSeconds: number) => void;
  /** Called when a slot is clicked (not a seek). */
  onClickChunk?: (chunkIndex: number) => void;
  /**
   * Scroll progress from 0 to 1.
   * 0 = full height with labels/separators
   * 1 = compact height, no labels/separators
   */
  scrollProgress: number;
}

/* ── Component ────────────────────────────────────────────── */

/**
 * WaveformTimeline — the whole-document waveform overview.
 *
 * Renders each narration chunk as one static waveform slot built from
 * backend-computed peaks. The waveform never animates; playback progress is
 * shown by the amber fill sweeping left-to-right as the playhead passes each
 * bar. Slot rendering itself lives in `WaveformSlot` so the reader conveyor can
 * reuse the exact same look.
 */
export function WaveformTimeline({
  slots,
  waveforms,
  playheadSeconds,
  renderedDurationSeconds,
  onSeek,
  onClickChunk,
  scrollProgress,
}: WaveformTimelineProps) {
  const compact = scrollProgress > 0.95;
  const seekingPointerIdRef = useRef<number | null>(null);
  const suppressClickRef = useRef<number | null>(null);
  const { attachRef, elementRef: containerRef, width: containerWidth } =
    useElementWidth<HTMLDivElement>();
  /**
   * While the user is dragging, the fill previews the position under the
   * pointer immediately (standard scrubber behavior) instead of waiting for the
   * audio seek to land. The real seek is committed once on pointer-up.
   * Stored in job-timeline coordinates, matching the slots.
   */
  const [dragPreviewSeconds, setDragPreviewSeconds] = useState<number | null>(null);

  const cumulativeStartTimes = useMemo(() => buildCumulativeStartTimes(slots), [slots]);
  const totalSeconds = useMemo(() => totalSlotDuration(slots), [slots]);

  /**
   * Maps a client X position to an absolute job-timeline position (seconds)
   * using the same proportional mapping the layout uses (slot width is
   * proportional to slot duration), so the scrub preview and the committed
   * seek always agree with what the user sees.
   */
  const computeTimelinePositionSeconds = useCallback(
    (clientX: number): number => {
      const container = containerRef.current;
      if (!container || totalSeconds <= 0) return 0;
      return secondsAtRatio(pointerRatio(clientX, container.getBoundingClientRect()), totalSeconds);
    },
    [containerRef, totalSeconds],
  );

  /** Index of the slot containing an absolute job-timeline position. */
  const slotIndexAt = useCallback(
    (seconds: number): number => slotIndexAtSeconds(cumulativeStartTimes, seconds),
    [cumulativeStartTimes],
  );

  const handlePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>, slot: TimelineSlotData) => {
      if (event.button !== 0) return;

      const target = event.currentTarget;

      if (slot.state === "failed") {
        onClickChunk?.(slot.chunkIndex);
        return;
      }

      // Enter scrub mode: the fill previews the pointer position immediately,
      // but the audio seek is committed once on pointer-up (no per-move seeks).
      suppressClickRef.current = slot.chunkIndex;
      seekingPointerIdRef.current = event.pointerId;
      setDragPreviewSeconds(computeTimelinePositionSeconds(event.clientX));
      if (typeof target.setPointerCapture === "function") {
        target.setPointerCapture(event.pointerId);
      }
      event.preventDefault();
    },
    [computeTimelinePositionSeconds, onClickChunk],
  );

  const handlePointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (seekingPointerIdRef.current !== event.pointerId) return;
      setDragPreviewSeconds(computeTimelinePositionSeconds(event.clientX));
    },
    [computeTimelinePositionSeconds],
  );

  const handlePointerUp = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (seekingPointerIdRef.current !== event.pointerId) return;
      seekingPointerIdRef.current = null;
      const seekSeconds = computeTimelinePositionSeconds(event.clientX);
      const slot = slots[slotIndexAt(seekSeconds)];
      setDragPreviewSeconds(null);
      if (slot) onSeek(slot.chunkIndex, seekSeconds);
    },
    [computeTimelinePositionSeconds, onSeek, slotIndexAt, slots],
  );

  const handlePointerCancel = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (seekingPointerIdRef.current !== event.pointerId) return;
    seekingPointerIdRef.current = null;
    setDragPreviewSeconds(null);
  }, []);

  const handleActivate = useCallback(
    (slot: TimelineSlotData) => {
      if (suppressClickRef.current === slot.chunkIndex) {
        suppressClickRef.current = null;
        return;
      }

      if (slot.state === "failed") return;
      onClickChunk?.(slot.chunkIndex);
    },
    [onClickChunk],
  );

  const interaction = useMemo<WaveformSlotInteraction>(
    () => ({
      onPointerDown: handlePointerDown,
      onPointerMove: handlePointerMove,
      onPointerUp: handlePointerUp,
      onPointerCancel: handlePointerCancel,
      onActivate: handleActivate,
    }),
    [handleActivate, handlePointerCancel, handlePointerDown, handlePointerMove, handlePointerUp],
  );

  // Smooth height interpolation: 80px (h-20) → 40px (h-10)
  const timelineHeight = Math.round(80 - scrollProgress * 40);
  const barStep = barStepPx(BAR_WIDTH_PX, BAR_GAP_PX);
  // The fill follows the pointer during a drag; otherwise it tracks the real
  // playback position (both in job-timeline coordinates).
  const effectivePlayheadSeconds = dragPreviewSeconds ?? playheadSeconds;

  if (slots.length === 0) {
    return (
      <div
        aria-label="Timeline"
        className="flex items-center justify-center rounded-xl border border-[var(--line)] bg-[var(--surface)] text-xs text-[var(--ink-secondary)]"
        role="slider"
        style={{ height: timelineHeight }}
      >
        No chunks to display
      </div>
    );
  }

  return (
    <div
      aria-label="Audio waveform timeline"
      aria-valuemax={renderedDurationSeconds}
      aria-valuemin={0}
      aria-valuenow={Math.min(effectivePlayheadSeconds, renderedDurationSeconds)}
      className="relative flex w-full overflow-hidden rounded-xl border border-[var(--line)] bg-[var(--surface)]"
      ref={attachRef}
      role="slider"
      style={{ height: timelineHeight }}
      tabIndex={-1}
    >
      {slots.map((slot, slotIndex) => {
        const chunkWidthPx = slotWidthPx(containerWidth, slot.durationSeconds, totalSeconds);
        const barCount = barCountForWidth(chunkWidthPx, barStep, SLOT_H_PADDING_PX);
        return (
          <WaveformSlot
            barCount={barCount}
            bars={waveformForSlot(waveforms.get(slot.chunkIndex), slot, barCount)}
            compact={compact}
            interaction={interaction}
            key={slot.chunkIndex}
            playheadSeconds={effectivePlayheadSeconds}
            renderedDurationSeconds={renderedDurationSeconds}
            showSeparator={slot.chunkIndex < slots.length - 1}
            slot={slot}
            slotStartSeconds={cumulativeStartTimes[slotIndex] ?? 0}
            style={{ flex: `${slot.durationSeconds} 0 0` }}
          />
        );
      })}
    </div>
  );
}
