import { type PointerEvent as ReactPointerEvent, useCallback, useMemo, useRef } from "react";

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
  /** True when this slot is the currently-active/live chunk */
  isLive: boolean;
}

export interface WaveformTimelineProps {
  /** Ordered list of timeline slots to render. */
  slots: TimelineSlotData[];
  /** Captured waveform data per chunk index (0..1 normalized amplitudes). */
  capturedWaveforms: Map<number, Float32Array>;
  /** The current live waveform frame from the AnalyserNode (0..1 normalized). */
  liveWaveform: Float32Array | null;
  /** Current playback position in seconds (for the playhead). */
  currentTimeSeconds: number;
  /** Total rendered duration in seconds (for the playhead position). */
  renderedDurationSeconds: number;
  /**
   * Called when the user clicks/seeks within a slot.
   * `seekSeconds` is the audio-relative target timestamp.
   */
  onSeek: (chunkIndex: number, seekSeconds: number) => void;
  /** Called when a slot is clicked (not a seek). */
  onClickChunk?: (chunkIndex: number) => void;
}

/* ── Constants ────────────────────────────────────────────── */

/** Number of waveform bars to render per chunk. */
const BARS_PER_CHUNK = 48;

/** Minimum bar height as a fraction of the slot height. */
const MIN_BAR_HEIGHT = 0.05;

/** Placeholder waveform for future/ready chunks (deterministic from index). */
function generatePlaceholderWaveform(chunkIndex: number, length: number): Float32Array {
  const data = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    // Deterministic pseudo-random from chunkIndex + bin position
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

/* ── Helpers ──────────────────────────────────────────────── */

function calculateChunkSeekTargetSeconds(
  clientX: number,
  rect: { left: number; width: number },
  chunkStartSeconds: number,
  chunkDurationSeconds: number,
): number {
  if (rect.width <= 0 || chunkDurationSeconds <= 0) return chunkStartSeconds;
  const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
  return chunkStartSeconds + ratio * chunkDurationSeconds;
}

/* ── Component ────────────────────────────────────────────── */

/**
 * WaveformTimeline — The signature visual element of ReadFlow.
 *
 * Renders each narration chunk as a waveform visualization with
 * real captured audio data. The timeline is full-width, interactive,
 * and supports click/seek via pointer events.
 */
export function WaveformTimeline({
  slots,
  capturedWaveforms,
  liveWaveform,
  currentTimeSeconds,
  renderedDurationSeconds,
  onSeek,
  onClickChunk,
}: WaveformTimelineProps) {
  const seekingPointerIdRef = useRef<number | null>(null);
  const suppressClickRef = useRef<number | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const handlePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>, slot: TimelineSlotData) => {
      if (event.button !== 0) return;

      const target = event.currentTarget;
      const rect = target.getBoundingClientRect();

      if (slot.state === "failed") {
        onClickChunk?.(slot.chunkIndex);
        return;
      }

      // Calculate seek target
      const chunkStartSeconds = slots
        .slice(0, slot.chunkIndex < slots.length ? slot.chunkIndex : slots.length)
        .reduce((acc, s) => acc + (s.state !== "failed" ? s.durationSeconds : 0), 0);

      const seekSeconds = calculateChunkSeekTargetSeconds(
        event.clientX,
        rect,
        chunkStartSeconds,
        slot.durationSeconds,
      );

      onSeek(slot.chunkIndex, seekSeconds);

      // Start drag-seeking
      suppressClickRef.current = slot.chunkIndex;
      seekingPointerIdRef.current = event.pointerId;
      if (typeof target.setPointerCapture === "function") {
        target.setPointerCapture(event.pointerId);
      }
      event.preventDefault();
    },
    [onSeek, onClickChunk, slots],
  );

  const handlePointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>, slot: TimelineSlotData) => {
      if (seekingPointerIdRef.current !== event.pointerId) return;

      const target = event.currentTarget;
      const rect = target.getBoundingClientRect();

      const chunkStartSeconds = slots
        .slice(0, slot.chunkIndex < slots.length ? slot.chunkIndex : slots.length)
        .reduce((acc, s) => acc + (s.state !== "failed" ? s.durationSeconds : 0), 0);

      const seekSeconds = calculateChunkSeekTargetSeconds(
        event.clientX,
        rect,
        chunkStartSeconds,
        slot.durationSeconds,
      );

      onSeek(slot.chunkIndex, seekSeconds);
    },
    [onSeek, slots],
  );

  const handlePointerUp = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (seekingPointerIdRef.current === event.pointerId) {
      seekingPointerIdRef.current = null;
    }
  }, []);

  const handlePointerCancel = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (seekingPointerIdRef.current === event.pointerId) {
      seekingPointerIdRef.current = null;
    }
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

  if (slots.length === 0) {
    return (
      <div
        aria-label="Timeline"
        className="flex h-16 items-center justify-center rounded-xl border border-[var(--line)] bg-[var(--surface)] text-xs text-[var(--ink-secondary)]"
        role="slider"
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
      aria-valuenow={currentTimeSeconds}
      className="relative flex h-16 w-full overflow-hidden rounded-xl border border-[var(--line)] bg-[var(--surface)]"
      ref={containerRef}
      role="slider"
      tabIndex={-1}
    >
      {slots.map((slot, slotIndex) => {
        const waveform = slot.isLive && liveWaveform
          ? liveWaveform
          : (capturedWaveforms.get(slot.chunkIndex) ??
             (slot.state === "missing_expected" || slot.state === "failed"
               ? generateBrokenWaveform(slot.chunkIndex, BARS_PER_CHUNK)
               : generatePlaceholderWaveform(slot.chunkIndex, BARS_PER_CHUNK)));

        const chunkStartSeconds = cumulativeStartTimes[slotIndex] ?? 0;

        return (
          <div
            aria-label={`Chunk ${slot.chunkIndex + 1}: ${slot.state}`}
            className={`relative flex h-full cursor-pointer items-end overflow-hidden transition-colors ${
              slot.state === "played" && currentTimeSeconds > (chunkStartSeconds + slot.durationSeconds)
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
            onPointerMove={(e) => handlePointerMove(e, slot)}
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
                      : slot.state === "played"
                        ? "bg-[var(--waveform-bar-muted)]"
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

            {/* Waveform bars — smooth left-to-right amber fill, pixel-perfect at playhead */}
            <div className="relative z-10 flex h-[calc(100%-8px)] w-full items-end gap-[2px] px-1">
              {Array.from({ length: BARS_PER_CHUNK }, (_, i) => {
                const binIndex = Math.floor((i / BARS_PER_CHUNK) * waveform.length);
                const amplitude = Math.max(MIN_BAR_HEIGHT, waveform[binIndex] ?? MIN_BAR_HEIGHT);

                // Compute horizontal (left-to-right) fill percentage for this bar
                const barStartTime = chunkStartSeconds + (i / BARS_PER_CHUNK) * slot.durationSeconds;
                const barEndTime = chunkStartSeconds + ((i + 1) / BARS_PER_CHUNK) * slot.durationSeconds;

                // horizontalFillPercent: how much of this bar's width is amber (left-to-right)
                // - Playhead fully right of bar → 1.0 (entire bar amber)
                // - Playhead fully left of bar → 0.0 (entire bar muted)
                // - Playhead inside bar → proportional (smooth pixel movement)
                const isSpecialState = slot.state === "failed" || slot.state === "missing_expected";
                const isGap = slot.state === "ready_after_gap";

                let horizontalFillPercent = 0;
                if (!isSpecialState && renderedDurationSeconds > 0) {
                  if (currentTimeSeconds >= barEndTime) {
                    horizontalFillPercent = 1;
                  } else if (currentTimeSeconds > barStartTime) {
                    const barDuration = barEndTime - barStartTime;
                    horizontalFillPercent = barDuration > 0
                      ? Math.min(1, (currentTimeSeconds - barStartTime) / barDuration)
                      : 0;
                  }
                }

                return (
                  <div
                    className="relative w-full"
                    key={i}
                    style={{ height: `${amplitude * 100}%` }}
                  >
                    {isSpecialState ? (
                      <div
                        className={`absolute inset-0 w-full rounded-[2px] ${
                          slot.state === "failed" ? "bg-rose-500/60" : "bg-[var(--waveform-bar-muted)]"
                        }`}
                      />
                    ) : (
                      <>
                        {/* Muted background — full bar height & width */}
                        <div
                          className={`absolute inset-0 w-full rounded-[2px] ${
                            isGap ? "bg-[var(--waveform-bar-dim)]/50" : "bg-[var(--waveform-bar-dim)]"
                          }`}
                        />
                        {/* Amber foreground — fills left-to-right with playhead */}
                        {horizontalFillPercent > 0 ? (
                          <div
                            className={`absolute inset-y-0 left-0 rounded-[2px] ${
                              isGap ? "bg-[var(--amber)]/70" : "bg-[var(--amber)]"
                            }`}
                            style={{
                              width: `${horizontalFillPercent * 100}%`,
                              minWidth: '1px',
                            }}
                          />
                        ) : null}
                      </>
                    )}
                  </div>
                );
              })}
            </div>

            {/* Chunk index label */}
            <div
              aria-hidden="true"
              className="absolute bottom-1 left-1/2 z-20 -translate-x-1/2 text-[9px] font-semibold tracking-wider text-white/40"
            >
              {slot.chunkIndex + 1}
            </div>

            {/* Separator line */}
            {slot.chunkIndex < slots.length - 1 ? (
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
