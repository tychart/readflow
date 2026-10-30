import {
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import {
  advanceConveyor,
  advanceSmoothedPlayhead,
  averageDurationSeconds,
  beginDrag,
  conveyorPxPerSecond,
  endDrag,
  gestureCenterSeconds,
  isMovingGesture,
  isRenderedState,
  isTap,
  resolveConveyorWindowSize,
  slotAtSeconds,
  slotIndexAtSeconds,
  updateDrag,
  type ConveyorBounds,
  type ConveyorGesture,
} from "../features/reader/conveyor-physics";
import { useElementWidth } from "../hooks/useElementWidth";
import { useTheme } from "../hooks/useTheme";
import {
  createConveyorScene,
  paintConveyor,
  readConveyorPalette,
  sizeConveyorCanvas,
  type ConveyorPalette,
  type ConveyorScene,
} from "../lib/conveyor-canvas";
import { formatClock } from "../lib/format";
import { buildCumulativeStartTimes, totalSlotDuration } from "../lib/waveform-timeline";
import type { ConveyorWindowSize } from "../state/reader-settings";
import type { TimelineSlotData } from "../types/timeline";

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
  /**
   * Whether the media clock is actually running. The idle slide is driven by the
   * strip's own frame clock only while it is: a frozen playhead needs no frames.
   */
  isPlaying: boolean;
  /** Playback rate of the media clock, so the slide advances at the same speed. */
  playbackRate: number;
  windowSizeSetting: ConveyorWindowSize;
  stripHeightPx?: number;
  /** Commit a seek. Fired once, when the strip comes to rest. */
  onSeek: (chunkIndex: number, seconds: number) => void;
}

/* ── Style ────────────────────────────────────────────────── */

/** Fades both edges so the track reads as a continuous strip, not a box. */
const EDGE_FADE = "linear-gradient(to right, transparent, #000 8%, #000 92%, transparent)";

/**
 * Smallest movement worth writing to the DOM. Frames that cannot move the strip
 * by this much are skipped, so a paused or reduced-motion strip costs nothing.
 */
const MIN_WRITE_PX = 0.01;

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
  isPlaying,
  playbackRate,
  windowSizeSetting,
  stripHeightPx = 64,
  onSeek,
}: ChunkConveyorProps) {
  const { attachRef, width: stripWidth } = useElementWidth<HTMLDivElement>();

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const { theme } = useTheme();
  const gestureRef = useRef<ConveyorGesture | null>(null);
  const pointerIdRef = useRef<number | null>(null);
  const stripCenterClientXRef = useRef(0);
  const [gesture, setGesture] = useState<ConveyorGesture | null>(null);

  const cumulativeStartTimes = useMemo(() => buildCumulativeStartTimes(slots), [slots]);
  const totalSeconds = useMemo(() => totalSlotDuration(slots), [slots]);
  const averageDuration = useMemo(() => averageDurationSeconds(slots), [slots]);

  const windowSize = resolveConveyorWindowSize(windowSizeSetting, stripWidth);
  const pxPerSecond = conveyorPxPerSecond(stripWidth, windowSize, averageDuration);
  const scene = useMemo(
    () => createConveyorScene(slots, cumulativeStartTimes, waveforms, pxPerSecond),
    [slots, cumulativeStartTimes, waveforms, pxPerSecond],
  );

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

  const sliding = gesture === null && motion === "animated" && isPlaying;
  const reportedSecondsRef = useRef(playheadSeconds);
  const rateRef = useRef(isPlaying ? playbackRate : 0);
  const renderedSecondsRef = useRef<number | null>(null);
  const smoothedSecondsRef = useRef<number | null>(null);
  const boundsRef = useRef(bounds);
  const pxPerSecondRef = useRef(pxPerSecond);
  const motionRef = useRef(motion);
  const cumulativeStartTimesRef = useRef(cumulativeStartTimes);
  const slotsRef = useRef(slots);
  const onSeekRef = useRef(onSeek);
  const paintRef = useRef<{
    scene: ConveyorScene;
    width: number;
    height: number;
    renderedDurationSeconds: number;
    palette: ConveyorPalette;
  } | null>(null);

  // Both animation loops and pointer handlers read committed values, never
  // stale render closures. Synchronize before the layout/paint effects below.
  useLayoutEffect(() => {
    boundsRef.current = bounds;
    pxPerSecondRef.current = pxPerSecond;
    motionRef.current = motion;
    cumulativeStartTimesRef.current = cumulativeStartTimes;
    slotsRef.current = slots;
    onSeekRef.current = onSeek;
    reportedSecondsRef.current = playheadSeconds;
    rateRef.current = isPlaying ? playbackRate : 0;
  });

  const drawSeconds = useCallback((seconds: number) => {
    renderedSecondsRef.current = seconds;
    const canvas = canvasRef.current;
    const paint = paintRef.current;
    if (!canvas || !paint || paint.width <= 0) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    sizeConveyorCanvas(canvas, paint.width, paint.height, dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    paintConveyor(ctx, paint.scene, { ...paint, centerSeconds: seconds });
  }, []);

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    paintRef.current = {
      scene,
      width: stripWidth,
      height: stripHeightPx,
      renderedDurationSeconds: maxSeekSeconds,
      palette: readConveyorPalette(canvas),
    };
    drawSeconds(renderedSecondsRef.current ?? reportedSecondsRef.current);
  }, [scene, stripWidth, stripHeightPx, maxSeekSeconds, theme, drawSeconds]);

  // A paused canvas also needs fresh backing pixels when dragged to a monitor
  // with a different scale. Re-arm the resolution query after each change.
  useEffect(() => {
    if (!canvasRef.current) return;
    let query: MediaQueryList | undefined;
    const redraw = () => drawSeconds(renderedSecondsRef.current ?? reportedSecondsRef.current);
    const watchDensity = () => {
      query?.removeEventListener?.("change", watchDensity);
      redraw();
      query = window.matchMedia?.(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
      query?.addEventListener?.("change", watchDensity);
    };
    watchDensity();
    window.addEventListener("resize", redraw);
    return () => {
      query?.removeEventListener?.("change", watchDensity);
      window.removeEventListener("resize", redraw);
    };
  }, [drawSeconds, slots.length]);

  // One painter: the frame loop owns the canvas while playing; otherwise the
  // committed gesture/paused/reduced-motion position is drawn before paint.
  useLayoutEffect(() => {
    if (!sliding) drawSeconds(centerSeconds);
  }, [centerSeconds, sliding, drawSeconds]);

  useLayoutEffect(() => {
    if (!sliding) {
      smoothedSecondsRef.current = null;
      return;
    }
    const initial = renderedSecondsRef.current ?? reportedSecondsRef.current;
    smoothedSecondsRef.current = initial;
    drawSeconds(initial);
    let frame = 0;
    let lastMs = performance.now();
    const tick = (nowMs: number) => {
      frame = requestAnimationFrame(tick);
      const dtSeconds = Math.min(0.064, Math.max(0, (nowMs - lastMs) / 1000));
      lastMs = nowMs;
      const smoothed = advanceSmoothedPlayhead({
        smoothedSeconds: smoothedSecondsRef.current ?? reportedSecondsRef.current,
        reportedSeconds: reportedSecondsRef.current,
        rate: rateRef.current,
        dtSeconds,
        maxSeconds: boundsRef.current.maxVisualSeconds,
      });
      smoothedSecondsRef.current = smoothed;
      const shown = renderedSecondsRef.current;
      if (shown !== null && Math.abs(smoothed - shown) * pxPerSecondRef.current < MIN_WRITE_PX) return;
      drawSeconds(smoothed);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [sliding, drawSeconds]);

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
    const started = beginDrag(renderedSecondsRef.current ?? centerSeconds, event.clientX, performance.now());
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
      {/* The viewport never moves: fractional vector positions are painted
          directly, avoiding Gecko's low-speed DOM/rounded-rectangle jitter. */}
      <canvas
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 h-full w-full"
        data-testid="conveyor-canvas"
        ref={canvasRef}
        style={{ maskImage: EDGE_FADE, WebkitMaskImage: EDGE_FADE }}
      />

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
