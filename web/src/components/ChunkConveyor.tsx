import { type PointerEvent as ReactPointerEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  advanceConveyor,
  averageDurationSeconds,
  beginDrag,
  conveyorPxPerSecond,
  conveyorTrackOriginPx,
  endDrag,
  gestureCenterSeconds,
  isMovingGesture,
  isRenderedState,
  isTap,
  resolveConveyorWindowSize,
  slotAtSeconds,
  slotIndexAtSeconds,
  updateDrag,
  visibleSlotIndexes,
  type ConveyorBounds,
  type ConveyorGesture,
} from "../features/reader/conveyor-physics";
import { useElementWidth } from "../hooks/useElementWidth";
import { formatClock } from "../lib/format";
import {
  barCountForWidth,
  barStepPx,
  buildCumulativeStartTimes,
  totalSlotDuration,
  waveformForSlot,
} from "../lib/waveform-timeline";
import type { ConveyorWindowSize } from "../state/reader-settings";
import type { TimelineSlotData } from "../types/timeline";
import {
  BAR_GAP_PX,
  BAR_WIDTH_PX,
  SLOT_H_PADDING_PX,
  WaveformSlot,
  type WaveformSlotInteraction,
} from "./WaveformSlot";

/* ── Types ────────────────────────────────────────────────── */

export interface ChunkConveyorProps {
  /** Timeline slots (original job-timeline coordinates, like the main playbar). */
  slots: TimelineSlotData[];
  /** Analyzed peaks per chunk index. */
  waveforms: Map<number, Float32Array>;
  /**
   * Where playback actually is, in original timeline coordinates. While a seek
   * is pending the reader passes the seek target, so the strip never snaps back.
   */
  playheadSeconds: number;
  /** End of contiguous rendered audio: commits never land beyond this. */
  maxSeekSeconds: number;
  /** Motion after combining the reader setting with the OS preference. */
  motion: "animated" | "reduced";
  windowSizeSetting: ConveyorWindowSize;
  stripHeightPx?: number;
  /** Commit a seek. Fired once, when the strip comes to rest. */
  onSeek: (chunkIndex: number, seconds: number) => void;
}

/* ── Style ────────────────────────────────────────────────── */

/** Fades both edges so the track reads as a continuous strip, not a box. */
const EDGE_FADE = "linear-gradient(to right, transparent, #000 8%, #000 92%, transparent)";

/**
 * Smoothing for the idle slide. The playhead prop updates at ~20Hz but the
 * strip should move at display rate, so the browser interpolates between
 * updates. Disabled during a gesture so the track tracks the finger exactly.
 */
const IDLE_TRANSITION = "transform 60ms linear";

/* ── Component ────────────────────────────────────────────── */

/**
 * Chunk conveyor — the reader's zoomed-in scrub strip.
 *
 * A fixed playhead marker sits at the horizontal centre and the chunk track
 * slides under it, so the strip's position *is* the timeline value being
 * edited. The gesture rules follow from that:
 *
 * - drag the track 1:1 with the finger (drag right = earlier audio),
 * - tap moves the strip so the tapped point lands under the playhead,
 * - a flick coasts with friction and settles with a small overshoot,
 * - and playback is committed only once the strip is at rest and no pointer is
 *   down. Audio therefore never chases the finger and never lands on a moving
 *   strip; a commit that lands past the rendered audio clamps to the boundary
 *   and lets the player wait for the next chunk.
 *
 * Audio keeps playing throughout — only the commit jumps.
 */
export function ChunkConveyor({
  slots,
  waveforms,
  playheadSeconds,
  maxSeekSeconds,
  motion,
  windowSizeSetting,
  stripHeightPx = 64,
  onSeek,
}: ChunkConveyorProps) {
  const { attachRef, width: stripWidth } = useElementWidth<HTMLDivElement>();

  const gestureRef = useRef<ConveyorGesture | null>(null);
  const pointerIdRef = useRef<number | null>(null);
  const stripCenterClientXRef = useRef(0);
  const [gesture, setGesture] = useState<ConveyorGesture | null>(null);

  const cumulativeStartTimes = useMemo(() => buildCumulativeStartTimes(slots), [slots]);
  const totalSeconds = useMemo(() => totalSlotDuration(slots), [slots]);
  const averageDuration = useMemo(() => averageDurationSeconds(slots), [slots]);

  const windowSize = resolveConveyorWindowSize(windowSizeSetting, stripWidth);
  const pxPerSecond = conveyorPxPerSecond(stripWidth, windowSize, averageDuration);
  const barStep = barStepPx(BAR_WIDTH_PX, BAR_GAP_PX);

  const bounds = useMemo<ConveyorBounds>(
    () => ({
      maxSeekSeconds,
      // The strip may be dragged past the rendered audio (so upcoming chunks are
      // visible) but never past the end of the document.
      maxVisualSeconds: Math.max(totalSeconds, maxSeekSeconds),
    }),
    [maxSeekSeconds, totalSeconds],
  );

  /**
   * Idle position. Animated motion follows the playhead continuously; reduced
   * motion snaps to the start of the chunk under the playhead, so the strip
   * advances one chunk at a time instead of sliding.
   */
  const idleCenterSeconds = useMemo(() => {
    if (motion === "animated") return playheadSeconds;
    return cumulativeStartTimes[slotIndexAtSeconds(cumulativeStartTimes, playheadSeconds)] ?? 0;
  }, [cumulativeStartTimes, motion, playheadSeconds]);

  const centerSeconds = gesture ? gestureCenterSeconds(gesture) : idleCenterSeconds;

  // Latest values for the imperative gesture code (pointer handlers and the
  // animation loop run outside React's render cycle).
  const boundsRef = useRef(bounds);
  const pxPerSecondRef = useRef(pxPerSecond);
  const motionRef = useRef(motion);
  const cumulativeStartTimesRef = useRef(cumulativeStartTimes);
  const slotsRef = useRef(slots);
  const onSeekRef = useRef(onSeek);
  useEffect(() => {
    boundsRef.current = bounds;
    pxPerSecondRef.current = pxPerSecond;
    motionRef.current = motion;
    cumulativeStartTimesRef.current = cumulativeStartTimes;
    slotsRef.current = slots;
    onSeekRef.current = onSeek;
  });

  /**
   * The single place a gesture turns into playback.
   *
   * The physics has already resolved the final target, including whether an
   * explicit tap may land past the contiguous rendered run, so this only bounds
   * the value to the document.
   */
  const commitSeek = useCallback((seconds: number) => {
    gestureRef.current = null;
    setGesture(null);
    const clamped = Math.min(Math.max(0, seconds), boundsRef.current.maxVisualSeconds);
    const index = slotIndexAtSeconds(cumulativeStartTimesRef.current, clamped);
    onSeekRef.current(index, clamped);
  }, []);

  // Momentum/settle animation. Runs only while the strip is moving on its own.
  const moving = isMovingGesture(gesture);
  useEffect(() => {
    if (!moving) return;
    let frame = 0;
    let lastMs = performance.now();
    const tick = (nowMs: number) => {
      frame = requestAnimationFrame(tick);
      const current = gestureRef.current;
      if (!current || current.phase === "dragging") return;
      // Clamp dt so a backgrounded tab does not teleport the strip on return.
      const dtSeconds = Math.min(0.064, Math.max(0, (nowMs - lastMs) / 1000));
      lastMs = nowMs;
      const { gesture: next, restSeconds } = advanceConveyor(current, dtSeconds, boundsRef.current);
      gestureRef.current = next;
      setGesture(next);
      if (restSeconds !== null) commitSeek(restSeconds);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [commitSeek, moving]);

  /* ── Pointer gestures ──────────────────────────────────── */

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const element = event.currentTarget;
    const rect = element.getBoundingClientRect();
    stripCenterClientXRef.current = rect.left + rect.width / 2;
    pointerIdRef.current = event.pointerId;
    if (typeof element.setPointerCapture === "function") {
      element.setPointerCapture(event.pointerId);
    }
    // Freeze the current position as the gesture base so grabbing a moving
    // strip does not make it jump.
    const started = beginDrag(centerSeconds, event.clientX, performance.now());
    gestureRef.current = started;
    setGesture(started);
    event.preventDefault();
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (pointerIdRef.current !== event.pointerId) return;
    const current = gestureRef.current;
    if (!current || current.phase !== "dragging") return;
    const next = updateDrag(
      current,
      event.clientX,
      performance.now(),
      pxPerSecondRef.current,
      boundsRef.current,
    );
    gestureRef.current = next;
    setGesture(next);
  };

  const handlePointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (pointerIdRef.current !== event.pointerId) return;
    pointerIdRef.current = null;
    const current = gestureRef.current;
    if (!current || current.phase !== "dragging") return;

    const pxPerSecond = pxPerSecondRef.current;
    // A tap means "put this point under the playhead"; a drag already moved the
    // track with the finger. A tap that lands on a chunk which already has audio
    // is an explicit request to go there, like a click on the main timeline, so
    // it may commit past the contiguous rendered run.
    const alignmentOffsetSeconds =
      isTap(current.pointerStartX, event.clientX) && pxPerSecond > 0
        ? (event.clientX - stripCenterClientXRef.current) / pxPerSecond
        : null;
    const allowsUnrenderedTarget =
      alignmentOffsetSeconds !== null &&
      isRenderedState(
        slotAtSeconds(
          slotsRef.current,
          cumulativeStartTimesRef.current,
          current.baseSeconds + alignmentOffsetSeconds,
        )?.state ?? "missing_expected",
      );

    const next = endDrag(
      current,
      performance.now(),
      pxPerSecond,
      motionRef.current,
      boundsRef.current,
      { alignmentOffsetSeconds, allowsUnrenderedTarget },
    );
    gestureRef.current = next;
    setGesture(next);
  };

  const handlePointerCancel = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (pointerIdRef.current !== event.pointerId) return;
    // Abandoned gesture: discard it rather than committing an accidental seek.
    pointerIdRef.current = null;
    gestureRef.current = null;
    setGesture(null);
  };

  /* ── Layout ────────────────────────────────────────────── */

  const trackOriginPx = conveyorTrackOriginPx(stripWidth, centerSeconds, pxPerSecond);
  const visibleSeconds = pxPerSecond > 0 ? stripWidth / pxPerSecond : 0;
  const marginSeconds = averageDuration * 2;
  const { first, last } = visibleSlotIndexes(
    cumulativeStartTimes,
    slots,
    centerSeconds - visibleSeconds / 2 - marginSeconds,
    centerSeconds + visibleSeconds / 2 + marginSeconds,
  );

  const renderedSlots: React.ReactNode[] = [];
  for (let index = first; index <= last; index += 1) {
    const slot = slots[index];
    const slotStartSeconds = cumulativeStartTimes[index] ?? 0;
    const widthPx = slot.durationSeconds * pxPerSecond;
    const barCount = barCountForWidth(widthPx, barStep, SLOT_H_PADDING_PX);
    renderedSlots.push(
      <WaveformSlot
        barCount={barCount}
        bars={waveformForSlot(waveforms.get(slot.chunkIndex), slot, barCount)}
        compact={false}
        interaction={CONVEYOR_INTERACTION}
        interactive={false}
        key={slot.chunkIndex}
        playheadSeconds={centerSeconds}
        renderedDurationSeconds={maxSeekSeconds}
        showSeparator={false}
        slot={slot}
        slotStartSeconds={slotStartSeconds}
        style={{
          left: `${slotStartSeconds * pxPerSecond}px`,
          position: "absolute",
          top: 0,
          bottom: 0,
          width: `${widthPx}px`,
        }}
      />,
    );
  }

  const centerSlotIndex = slotIndexAtSeconds(cumulativeStartTimes, centerSeconds);
  const centerChunkNumber = (slots[centerSlotIndex]?.chunkIndex ?? 0) + 1;
  const centerClock = formatClock(centerSeconds);

  if (slots.length === 0) {
    return (
      <div
        className="flex items-center justify-center rounded-xl border border-[var(--line)] bg-[var(--surface)] text-xs text-[var(--ink-secondary)]"
        data-testid="chunk-conveyor"
        style={{ height: stripHeightPx }}
      >
        No chunks to display
      </div>
    );
  }

  return (
    <div
      aria-label="Chunk conveyor"
      className="relative w-full select-none overflow-hidden rounded-xl border border-[var(--line)] bg-[var(--surface)]"
      data-testid="chunk-conveyor"
      onPointerCancel={handlePointerCancel}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      ref={attachRef}
      role="group"
      style={{
        cursor: moving ? "grabbing" : "grab",
        height: stripHeightPx,
        // Vertical page scrolling keeps working over the strip; only the
        // horizontal axis belongs to the conveyor.
        touchAction: "pan-y",
      }}
    >
      {/* Sliding track. Masked so both edges fade instead of clipping hard. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0"
        style={{
          maskImage: EDGE_FADE,
          WebkitMaskImage: EDGE_FADE,
        }}
      >
        <div
          className="relative h-full"
          data-testid="conveyor-track"
          style={{
            transform: `translate3d(${trackOriginPx}px, 0, 0)`,
            transition: gesture === null ? IDLE_TRANSITION : "none",
            willChange: "transform",
          }}
        >
          {renderedSlots}
        </div>
      </div>

      {/* Fixed playhead marker at the centre of the strip. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-y-0 left-1/2 z-20 w-0.5 -translate-x-1/2 rounded-full bg-[var(--amber)]"
        data-testid="conveyor-playhead"
        style={{ boxShadow: "0 0 8px rgba(245,158,11,0.65)" }}
      />

      {/* Live position readout, so the fixed marker is legible as "you are here". */}
      <div
        className="pointer-events-none absolute left-1/2 top-1 z-30 -translate-x-1/2 rounded-full border border-[var(--line)] bg-[var(--canvas)]/85 px-2 py-0.5 font-mono text-[10px] font-semibold tabular-nums text-[var(--ink-primary)] backdrop-blur-sm"
        data-testid="conveyor-readout"
      >
        {centerClock}
      </div>

      <span aria-live="polite" className="sr-only">
        Chunk {centerChunkNumber}, {centerClock}
      </span>
    </div>
  );
}

/**
 * The conveyor handles pointer input at the strip level (it needs the tap
 * position, not the slot), so its slots are decorative: the same chunk states
 * are already exposed as real sliders by the main timeline, and nesting sliders
 * inside a slider is invalid.
 */
const CONVEYOR_INTERACTION: WaveformSlotInteraction = {
  onPointerDown: () => {},
  onPointerMove: () => {},
  onPointerUp: () => {},
  onPointerCancel: () => {},
  onActivate: () => {},
};
