import { type PointerEvent as ReactPointerEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { maxPool } from "../lib/waveform";

/* ── Types ────────────────────────────────────────────────── */

export type TimelineSlotState =
  | "played"
  | "playing"
  | "ready"
  | "ready_after_gap"
  | "missing_expected"
  | "failed";

export interface TimelineSlotData {
  chunkIndex: number;
  state: TimelineSlotState;
  durationSeconds: number;
}

export interface WaveformTimelineProps {
  /** Ordered list of timeline slots to render. */
  slots: TimelineSlotData[];
  /**
   * Analyzed waveform peaks per chunk index (0..1 normalized), fetched
   * from the backend. Chunks without peaks render a dim placeholder.
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

/* ── Tunable waveform style ─────────────────────────────────
 * All visual knobs for the static playbar waveform live here so the look
 * can be tuned without touching the rendering logic. */

/** Bar thickness in px. */
const BAR_WIDTH_PX = 3;
/** Gap between bars in px. */
const BAR_GAP_PX = 2;
/** Corner radius in px (BAR_WIDTH_PX / 2 = fully rounded pill). */
const BAR_RADIUS_PX = 2;
/** Minimum bar height as a fraction of the slot height. */
const MIN_BAR_HEIGHT = 0.06;
/** Horizontal padding inside each chunk slot (matches px-1 = 4px each side). */
const SLOT_H_PADDING_PX = 8;

/* ── Helpers ──────────────────────────────────────────────── */

/** Placeholder waveform for unrendered/not-yet-analyzed chunks (deterministic from index). */
function generatePlaceholderWaveform(chunkIndex: number, length: number): Float32Array {
  const data = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    // Deterministic pseudo-random from chunkIndex + bar position
    const seed = (chunkIndex * 31 + i * 7) % 9973;
    const norm = seed / 9973;
    // Create a soft wave-like pattern
    const wave = Math.sin((i / length) * Math.PI * 2 + chunkIndex * 1.7);
    data[i] = 0.15 + (norm * 0.35) + (wave * 0.1 + 0.1);
  }
  return data;
}

/** Generates a "broken" waveform for missing chunks. */
function generateBrokenWaveform(chunkIndex: number, length: number): Float32Array {
  const data = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    // Mostly flat with sharp random spikes — looks like a broken signal
    const seed = (chunkIndex * 13 + i * 17) % 9973;
    const spike = seed < 500 ? 0.6 + (seed / 9973) * 0.4 : 0.05;
    data[i] = spike;
  }
  return data;
}

/* ── Component ────────────────────────────────────────────── */

/**
 * WaveformTimeline — The signature visual element of ReadFlow.
 *
 * Renders each narration chunk as a static waveform visualization built
 * from backend-computed peaks. The waveform never animates; playback
 * progress is shown by the amber fill sweeping left-to-right as the
 * playhead passes each bar. The timeline is full-width, interactive, and
 * supports click/seek via pointer events.
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
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(0);
  /**
   * While the user is dragging, the fill previews the position under the
   * pointer immediately (standard scrubber behavior) instead of waiting for
   * the audio seek to land. The real seek is committed once on pointer-up.
   * Stored in job-timeline coordinates, matching the slots.
   */
  const [dragPreviewSeconds, setDragPreviewSeconds] = useState<number | null>(null);

  // Track the rendered container width so bar count adapts to it.
  useEffect(() => {
    const container = containerRef.current;
    if (!container || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width;
      if (width) setContainerWidth(Math.round(width));
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  // Must be before early return — React hook ordering rule
  const cumulativeStartTimes = useMemo(() => {
    const times: number[] = [];
    let running = 0;
    for (const slot of slots) {
      times.push(running);
      running += slot.durationSeconds;
    }
    return times;
  }, [slots]);

  const totalSlotDuration = useMemo(
    () => slots.reduce((acc, slot) => acc + slot.durationSeconds, 0),
    [slots],
  );

  /**
   * Maps a client X position to an absolute job-timeline position (seconds)
   * using the same proportional mapping the layout uses (slot width is
   * proportional to slot duration), so the scrub preview and the committed
   * seek always agree with what the user sees.
   */
  const computeTimelinePositionSeconds = useCallback(
    (clientX: number): number => {
      const container = containerRef.current;
      if (!container || totalSlotDuration <= 0) return 0;
      const rect = container.getBoundingClientRect();
      if (rect.width <= 0) return 0;
      const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      return ratio * totalSlotDuration;
    },
    [totalSlotDuration],
  );

  /** Index of the slot containing an absolute job-timeline position. */
  const slotIndexAtSeconds = useCallback(
    (seconds: number): number => {
      let index = 0;
      for (let i = 0; i < cumulativeStartTimes.length; i += 1) {
        if (seconds >= cumulativeStartTimes[i]) index = i;
        else break;
      }
      return index;
    },
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
      const seekSeconds = computeTimelinePositionSeconds(event.clientX);
      suppressClickRef.current = slot.chunkIndex;
      seekingPointerIdRef.current = event.pointerId;
      setDragPreviewSeconds(seekSeconds);
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
      const slot = slots[slotIndexAtSeconds(seekSeconds)];
      setDragPreviewSeconds(null);
      if (slot) {
        onSeek(slot.chunkIndex, seekSeconds);
      }
    },
    [computeTimelinePositionSeconds, onSeek, slotIndexAtSeconds, slots],
  );

  const handlePointerCancel = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (seekingPointerIdRef.current !== event.pointerId) return;
    seekingPointerIdRef.current = null;
    setDragPreviewSeconds(null);
  }, []);

  const handleClick = useCallback(
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

  // Smooth height interpolation: 80px (h-20) → 40px (h-10)
  const timelineHeight = Math.round(80 - scrollProgress * 40);
  const barStepPx = BAR_WIDTH_PX + BAR_GAP_PX;
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
      style={{ height: timelineHeight }}
      ref={containerRef}
      role="slider"
      tabIndex={-1}
    >
      {slots.map((slot, slotIndex) => {
        const chunkWidthPx =
          totalSlotDuration > 0
            ? Math.max(0, containerWidth * (slot.durationSeconds / totalSlotDuration))
            : containerWidth;
        const barCount = Math.max(1, Math.floor((chunkWidthPx - SLOT_H_PADDING_PX) / barStepPx));

        // Pick the waveform source for this slot:
        // analyzed peaks → dim placeholder → broken signal (missing/failed)
        let waveform: Float32Array;
        const analyzed = waveforms.get(slot.chunkIndex);
        if (analyzed) {
          waveform = maxPool(analyzed, barCount);
        } else if (slot.state === "missing_expected" || slot.state === "failed") {
          waveform = generateBrokenWaveform(slot.chunkIndex, barCount);
        } else {
          waveform = generatePlaceholderWaveform(slot.chunkIndex, barCount);
        }

        const chunkStartSeconds = cumulativeStartTimes[slotIndex] ?? 0;

        return (
          <div
            aria-label={`Chunk ${slot.chunkIndex + 1}: ${slot.state}`}
            className={`relative flex h-full cursor-pointer items-end overflow-hidden transition-colors ${
              slot.state === "played" && effectivePlayheadSeconds > (chunkStartSeconds + slot.durationSeconds)
                ? "opacity-40"
                : ""
            }`}
            data-slot-state={slot.state}
            key={slot.chunkIndex}
            role="slider"
            tabIndex={0}
            style={{ flex: `${slot.durationSeconds} 0 0` }}
            onClick={() => handleClick(slot)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onClickChunk?.(slot.chunkIndex);
              }
            }}
            onPointerDown={(e) => handlePointerDown(e, slot)}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerCancel={handlePointerCancel}
          >
            {/* Background tint based on state */}
            <div
              className={`absolute inset-0 ${
                slot.state === "failed"
                  ? "bg-rose-900/30"
                  : slot.state === "missing_expected"
                    ? "bg-rose-900/15"
                    : slot.state === "playing"
                      ? "bg-[var(--amber-soft)]"
                      : "bg-[var(--waveform-bar-muted)]"
              }`}
            />

            {/* Active chunk amber glow */}
            {slot.state === "playing" ? (
              <div
                className="pointer-events-none absolute inset-0"
                style={{ boxShadow: "inset 0 0 20px rgba(245,158,11,0.15)" }}
              />
            ) : null}

            {/* Missing chunk broken/diagonal pattern */}
            {slot.state === "missing_expected" ? (
              <div
                aria-hidden="true"
                className="pointer-events-none absolute inset-0 opacity-20"
                style={{
                  backgroundImage:
                    "repeating-linear-gradient(-45deg, rgba(239,68,68,0.5) 0px, rgba(239,68,68,0.5) 2px, transparent 2px, transparent 6px)",
                }}
              />
            ) : null}

            {/* Waveform bars — static shape, amber fill sweeps left-to-right with playhead */}
            <div
              className="relative z-10 flex h-[calc(100%-8px)] w-full items-end overflow-hidden px-1"
              style={{ gap: BAR_GAP_PX }}
            >
              {Array.from({ length: barCount }, (_, i) => {
                const amplitude = Math.max(MIN_BAR_HEIGHT, waveform[i] ?? MIN_BAR_HEIGHT);

                // Compute horizontal (left-to-right) fill percentage for this bar
                const barStartTime = chunkStartSeconds + (i / barCount) * slot.durationSeconds;
                const barEndTime = chunkStartSeconds + ((i + 1) / barCount) * slot.durationSeconds;

                // horizontalFillPercent: how much of this bar's width is amber (left-to-right)
                // - Playhead fully right of bar → 1.0 (entire bar amber)
                // - Playhead fully left of bar → 0.0 (entire bar muted)
                // - Playhead inside bar → proportional (smooth pixel movement)
                const isSpecialState = slot.state === "failed" || slot.state === "missing_expected";
                const isGap = slot.state === "ready_after_gap";

                let horizontalFillPercent = 0;
                if (!isSpecialState && renderedDurationSeconds > 0) {
                  if (effectivePlayheadSeconds >= barEndTime) {
                    horizontalFillPercent = 1;
                  } else if (effectivePlayheadSeconds > barStartTime) {
                    const barDuration = barEndTime - barStartTime;
                    horizontalFillPercent = barDuration > 0
                      ? Math.min(1, (effectivePlayheadSeconds - barStartTime) / barDuration)
                      : 0;
                  }
                }

                return (
                  <div
                    className="relative shrink-0"
                    data-wave-bar
                    key={i}
                    style={{ width: BAR_WIDTH_PX, height: `${amplitude * 100}%` }}
                  >
                    {isSpecialState ? (
                      <div
                        className={`absolute inset-0 w-full ${
                          slot.state === "failed" ? "bg-rose-500/60" : "bg-[var(--waveform-bar-muted)]"
                        }`}
                        style={{ borderRadius: BAR_RADIUS_PX }}
                      />
                    ) : (
                      <>
                        {/* Muted background — full bar height & width */}
                        <div
                          className={`absolute inset-0 w-full ${
                            isGap ? "bg-[var(--waveform-bar-dim)]/50" : "bg-[var(--waveform-bar-dim)]"
                          }`}
                          style={{ borderRadius: BAR_RADIUS_PX }}
                        />
                        {/* Amber foreground — fills left-to-right with playhead */}
                        {horizontalFillPercent > 0 ? (
                          <div
                            className={`absolute inset-y-0 left-0 ${
                              isGap ? "bg-[var(--amber)]/70" : "bg-[var(--amber)]"
                            }`}
                            data-wave-fill
                            style={{
                              width: `${horizontalFillPercent * 100}%`,
                              minWidth: '1px',
                              borderRadius: BAR_RADIUS_PX,
                            }}
                          />
                        ) : null}
                      </>
                    )}
                  </div>
                );
              })}
            </div>

            {/* Chunk index label — hidden in compact mode */}
            {!compact && (
              <div
                aria-hidden="true"
                className="absolute bottom-1 left-1/2 z-20 -translate-x-1/2 text-[9px] font-semibold tracking-wider text-white/40"
              >
                {slot.chunkIndex + 1}
              </div>
            )}

            {/* Separator line — hidden in compact mode */}
            {!compact && slot.chunkIndex < slots.length - 1 ? (
              <div
                aria-hidden="true"
                className="absolute inset-y-2 right-0 z-20 w-px bg-[var(--waveform-sep)]"
              />
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
