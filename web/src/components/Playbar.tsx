import { useCallback, useEffect, useMemo, useRef } from "react";

import { WaveformTimeline, type TimelineSlotData } from "./WaveformTimeline";
import { useWaveformAnalyser } from "../hooks/useWaveformAnalyser";

/* ── Types ────────────────────────────────────────────────── */

export interface PlaybarProps {
  audioRef: React.RefObject<HTMLAudioElement | null>;
  /** Ordered timeline slots. Updated as chunks arrive. */
  slots: TimelineSlotData[];
  /** Index of the chunk currently being played, or null. */
  activeChunkIndex: number | null;
  /** Current playhead position in seconds. */
  currentTimeSeconds: number;
  /** Total rendered duration, or 0 if none. */
  renderedDurationSeconds: number;
  /** True when audio is actually playing (not paused/blocked). */
  isPlaying: boolean;
  /** True when the user has requested playback (even if not started yet). */
  playIntent: boolean;
  /** True when the browser has blocked autoplay. */
  isAutoplayBlocked: boolean;
  /** True if the job is in a terminal state (completed/failed). */
  isJobTerminal: boolean;
  /** True when the player is waiting for buffered data. */
  isWaitingForData: boolean;
  /** Whether the download button should be enabled. */
  canDownload: boolean;
  /** True when all chunks have been downloaded (full audio available). */
  isDownloadComplete: boolean;
  /** Called when the user presses play. */
  onPlay: () => void;
  /** Called when the user presses pause. */
  onPause: () => void;
  /** Seek to an absolute time in seconds. */
  onSeek: (seconds: number) => void;
  /** Seek targeting a specific chunk at an offset within it. */
  onSeekToChunk: (chunkIndex: number, seekSeconds: number) => void;
  /** Trigger audio download. */
  onDownload: () => void;
  isDownloading?: boolean;
  /** Total number of chunks in the job (for display). */
  totalChunks: number;
  /** Number of chunks currently written/ready. */
  writtenChunks: number;
  /**
   * Scroll progress from 0 to 1.
   * 0 = fully expanded (at top of page)
   * 1 = fully compact (scrolled past playbar)
   * Drives smooth inline-style transitions on padding, sizes, opacity.
   */
  scrollProgress: number;
}

/* ── Helpers ──────────────────────────────────────────────── */

function formatClock(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

/* ── Component ────────────────────────────────────────────── */

/**
 * Playbar — Full-width playback control bar for the Reader page.
 *
 * Orchestrates the audio waveform analyser and timeline, providing
 * play/pause, seek, time display, download, and keyboard shortcuts.
 */
export function Playbar({
  audioRef,
  slots,
  activeChunkIndex,
  currentTimeSeconds,
  renderedDurationSeconds,
  isPlaying,
  playIntent,
  isAutoplayBlocked,
  isJobTerminal,
  isWaitingForData,
  canDownload,
  isDownloadComplete,
  onPlay,
  onPause,
  onSeek,
  onSeekToChunk,
  onDownload,
  isDownloading = false,
  totalChunks,
  writtenChunks,
  scrollProgress,
}: PlaybarProps) {
  const barRef = useRef<HTMLDivElement>(null);

  // ── Waveform analyser ─────────────────────────────────────
  const {
    liveWaveform,
    captureSnapshot,
    getCaptured,
    reset: resetWaveforms,
  } = useWaveformAnalyser(audioRef, { binCount: 96 });

  // Capture waveform snapshot when the active chunk changes
  const prevActiveRef = useRef<number | null>(null);
  useEffect(() => {
    if (prevActiveRef.current !== activeChunkIndex && prevActiveRef.current !== null) {
      captureSnapshot(prevActiveRef.current);
    }
    prevActiveRef.current = activeChunkIndex;
  }, [activeChunkIndex, captureSnapshot]);

  // Reset captured waveforms when slots change (new job loaded)
  useEffect(() => {
    resetWaveforms();
  }, [slots.length, resetWaveforms]);

  // Build capturedWaveforms map for the timeline
  const capturedWaveforms = useMemo(() => {
    const map = new Map<number, Float32Array>();
    for (const slot of slots) {
      const captured = getCaptured(slot.chunkIndex);
      if (captured) {
        map.set(slot.chunkIndex, captured);
      }
    }
    return map;
  }, [slots, getCaptured]);

  // ── Player state for display ──────────────────────────────
  const playerStateLabel = useMemo(() => {
    if (isAutoplayBlocked) return "Playback blocked by browser";
    if (isJobTerminal && renderedDurationSeconds > 0 && currentTimeSeconds >= renderedDurationSeconds) {
      return "Playback complete";
    }
    if (isPlaying) return "Playing";
    if (playIntent && isWaitingForData) return "Buffering…";
    if (playIntent && !isPlaying && renderedDurationSeconds <= 0) return "Preparing stream…";
    if (playIntent) return "Starting…";
    return "Ready";
  }, [isAutoplayBlocked, isJobTerminal, renderedDurationSeconds, currentTimeSeconds, isPlaying, playIntent, isWaitingForData]);

  const showSpinner = (playIntent && !isAutoplayBlocked && !isPlaying) || isWaitingForData;

  // ── Keyboard shortcuts ────────────────────────────────────
  useEffect(() => {
    const bar = barRef.current;
    if (!bar) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      // Only capture when playbar is focused or no input is focused
      const tag = (event.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;

      switch (event.key) {
        case " ":
          event.preventDefault();
          if (isPlaying) {
            onPause();
          } else {
            onPlay();
          }
          break;
        case "ArrowRight":
          event.preventDefault();
          onSeek(Math.min(currentTimeSeconds + 5, renderedDurationSeconds));
          break;
        case "ArrowLeft":
          event.preventDefault();
          onSeek(Math.max(currentTimeSeconds - 5, 0));
          break;
        case "ArrowUp":
          event.preventDefault();
          onSeek(Math.min(currentTimeSeconds + 30, renderedDurationSeconds));
          break;
        case "ArrowDown":
          event.preventDefault();
          onSeek(Math.max(currentTimeSeconds - 30, 0));
          break;
      }
    };

    bar.addEventListener("keydown", handleKeyDown);
    return () => bar.removeEventListener("keydown", handleKeyDown);
  }, [isPlaying, onPlay, onPause, onSeek, currentTimeSeconds, renderedDurationSeconds]);

  // ── Seek handler for timeline clicks ──────────────────────
  const handleTimelineSeek = useCallback(
    (chunkIndex: number, seekSeconds: number) => {
      // onSeekToChunk handles activation and play intent internally
      onSeekToChunk(chunkIndex, seekSeconds);
    },
    [onSeekToChunk],
  );

  const handleTimelineClick = useCallback(
    (chunkIndex: number) => {
      // Seek to the start of the chunk — onSeekToChunk handles activation internally
      const chunkStartSeconds = slots
        .slice(0, chunkIndex < slots.length ? chunkIndex : slots.length)
        .reduce((acc, s) => acc + s.durationSeconds, 0);
      handleTimelineSeek(chunkIndex, chunkStartSeconds);
    },
    [handleTimelineSeek, slots],
  );

  // ── Render ────────────────────────────────────────────────
  // When playIntent is true (user requested play), show "Pause" even if audio hasn't started.
  // When autoplay is blocked, show "Resume" to encourage a click.
  const playButtonLabel = isAutoplayBlocked ? "Resume" : playIntent ? "Pause" : "Play";

  // ── Smooth interpolated values ────────────────────────────
  // All animate linearly as scrollProgress goes 0 → 1
  const containerPad = Math.round(20 - scrollProgress * 20); // 20px → 0px
  const btnSize = Math.round(48 - scrollProgress * 12);     // 48px → 36px
  const iconSize = Math.round(16 - scrollProgress * 4);     // 16px → 12px
  const gap = 12 - scrollProgress * 4;                      // 12px → 8px
  const metaOpacity = Math.max(0, 1 - scrollProgress * 1.2); // fades out by ~0.83
  // Fade the card border/background out as compact approaches
  const cardVisibility = 1 - Math.min(1, scrollProgress * 1.5);

  return (
    <div
      aria-label="Playback controls"
      className="flex w-full flex-col"
      ref={barRef}
      role="toolbar"
      style={{ gap: `${gap}px` }}
      tabIndex={-1}
    >
      {/* Card background/border — fades out as scrollProgress increases */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 rounded-xl border border-[var(--line)] bg-[var(--surface)]"
        style={{ opacity: cardVisibility }}
      />

      {/* Top row: play/pause + timeline */}
      <div
        className="relative z-10 flex items-center gap-3"
        style={{ padding: `${containerPad}px` }}
      >
        {/* Play/Pause button */}
        <button
          aria-label={playButtonLabel}
          className="flex shrink-0 items-center justify-center rounded-full bg-[var(--amber)] text-white shadow-lg shadow-[var(--amber-soft)] transition hover:brightness-110 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--amber)]"
          onClick={() => (isPlaying ? onPause() : onPlay())}
          style={{ width: btnSize, height: btnSize }}
          type="button"
        >
          {showSpinner ? (
            <span
              aria-hidden="true"
              className="inline-block animate-spin rounded-full border-2 border-white border-t-transparent"
              style={{ width: iconSize, height: iconSize }}
            />
          ) : isPlaying || playIntent ? (
            /* Pause icon */
            <svg aria-hidden="true" fill="currentColor" style={{ width: iconSize, height: iconSize }} viewBox="0 0 16 16">
              <rect height="14" rx="1" width="5" x="2.5" y="1" />
              <rect height="14" rx="1" width="5" x="8.5" y="1" />
            </svg>
          ) : (
            /* Play icon */
            <svg aria-hidden="true" className="ml-0.5" fill="currentColor" style={{ width: iconSize, height: iconSize }} viewBox="0 0 16 16">
              <path d="M3 1.5v13l11-6.5L3 1.5z" />
            </svg>
          )}
        </button>

        {/* Waveform Timeline */}
        <div className="min-w-0 flex-1">
          <WaveformTimeline
            capturedWaveforms={capturedWaveforms}
            scrollProgress={scrollProgress}
            currentTimeSeconds={currentTimeSeconds}
            liveWaveform={liveWaveform}
            onClickChunk={handleTimelineClick}
            onSeek={handleTimelineSeek}
            renderedDurationSeconds={renderedDurationSeconds}
            slots={slots}
          />
        </div>
      </div>

      {/* Bottom row: metadata + controls — fades out progressively */}
      <div
        className="relative z-10 flex items-center justify-between gap-4 text-xs text-[var(--ink-secondary)]"
        style={{
          opacity: metaOpacity,
          maxHeight: metaOpacity > 0 ? '50px' : '0px',
          overflow: 'hidden',
          paddingLeft: `${containerPad}px`,
          paddingRight: `${containerPad}px`,
          paddingBottom: `${containerPad > 0 ? containerPad : 0}px`,
        }}
      >
        {/* Left: time display — fixed widths prevent layout shift */}
        <div className="flex items-center gap-3 font-mono tabular-nums">
          {/* Current time */}
          <span className="inline-block min-w-[32px] text-right font-semibold text-[var(--ink-primary)]">
            {formatClock(currentTimeSeconds)}
          </span>
          <span className="opacity-40">/</span>
          <span className="inline-block min-w-[32px]">{formatClock(renderedDurationSeconds)}</span>

          {/* Player state — fixed min-width prevents layout shift */}
          <span
            aria-live="polite"
              className={`ml-2 inline-block min-w-[100px] rounded-full px-2 py-0.5 text-center text-[10px] font-medium ${
                playerStateLabel === "Playing" || playerStateLabel === "Starting…" || playerStateLabel === "Preparing stream…"
                  ? "bg-[var(--amber-soft)] text-[var(--amber)]"
                  : playerStateLabel === "Playback complete"
                    ? "bg-emerald-900/30 text-emerald-400"
                    : playerStateLabel === "Buffering…"
                      ? "bg-amber-900/30 text-amber-400"
                      : "bg-[var(--hover-bg)] text-[var(--ink-secondary)]"
              }`}
            >
              {playerStateLabel}
            </span>
          </div>

          {/* Right: chunk counter + download */}
          <div className="flex items-center gap-4">
            {/* Chunk counter */}
            <span className="tabular-nums">
              <span className="text-[var(--ink-primary)]">{writtenChunks}</span>
              <span className="opacity-40">/{totalChunks}</span>
              <span> chunks</span>
            </span>

            {/* Download button */}
            <button
              aria-label={isDownloadComplete ? "Download full audio" : canDownload ? "Download rendered audio" : "Download not available"}
              className={`flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-[11px] font-semibold transition ${
                canDownload
                  ? "border-[var(--line)] text-[var(--ink-secondary)] hover:border-[var(--amber)] hover:text-[var(--amber)]"
                  : "cursor-not-allowed border-[var(--line)] text-[var(--slate)] opacity-50"
              }`}
              disabled={!canDownload || isDownloading}
              onClick={onDownload}
              title={
                isDownloadComplete
                  ? "Download complete audio file"
                  : canDownload
                    ? "Download rendered audio so far"
                    : "No audio data available yet"
              }
              type="button"
            >
              {isDownloading ? (
                <>
                  <span className="inline-block h-3 w-3 animate-spin rounded-full border border-current border-t-transparent" />
                  Preparing…
                </>
              ) : (
                <>
                  {/* Download icon */}
                  <svg aria-hidden="true" className="h-3 w-3" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" viewBox="0 0 24 24">
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                    <polyline points="7 10 12 15 17 10" />
                    <line x1="12" x2="12" y1="15" y2="3" />
                  </svg>
                  {isDownloadComplete ? "Full audio" : "Download"}
                </>
              )}
            </button>
          </div>
        </div>
    </div>
  );
}
