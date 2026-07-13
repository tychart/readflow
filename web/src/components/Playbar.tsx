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
  /** True when the browser has blocked autoplay. */
  isAutoplayBlocked: boolean;
  /** True if the job is in a terminal state (completed/failed). */
  isJobTerminal: boolean;
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
}

/* ── Helpers ──────────────────────────────────────────────── */

function formatClock(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function describePlayerState(
  playerState: "priming" | "waiting" | "stalled" | "ready" | "playing" | "ended" | "error",
  isAutoplayBlocked: boolean,
): string {
  if (isAutoplayBlocked) return "Playback blocked by browser; tap play to resume.";
  switch (playerState) {
    case "priming":
      return "Preparing stream…";
    case "waiting":
    case "stalled":
      return "Buffering…";
    case "ready":
    case "playing":
      return isAutoplayBlocked ? "Ready — tap to play" : "Playing";
    case "ended":
      return "Playback complete";
    case "error":
      return "Playback error";
    default:
      return "";
  }
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
  isAutoplayBlocked,
  isJobTerminal,
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
}: PlaybarProps) {
  const barRef = useRef<HTMLDivElement>(null);

  // ── Waveform analyser ─────────────────────────────────────
  const {
    liveWaveform,
    isConnected,
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
    if (isAutoplayBlocked) return describePlayerState("ready", true);
    if (isPlaying) return "Playing";
    if (isJobTerminal && renderedDurationSeconds > 0 && currentTimeSeconds >= renderedDurationSeconds) {
      return "Playback complete";
    }
    return "Ready";
  }, [isAutoplayBlocked, isPlaying, isJobTerminal, renderedDurationSeconds, currentTimeSeconds]);

  const showSpinner = playerStateLabel === "Buffering…" || playerStateLabel === "Preparing stream…";

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
      if (isJobTerminal || !isPlaying) {
        onPlay();
      }
      onSeekToChunk(chunkIndex, seekSeconds);
    },
    [isJobTerminal, isPlaying, onPlay, onSeekToChunk],
  );

  const handleTimelineClick = useCallback(
    (chunkIndex: number) => {
      // Seek to the start of the chunk
      const chunkStartSeconds = slots
        .slice(0, chunkIndex < slots.length ? chunkIndex : slots.length)
        .reduce((acc, s) => acc + s.durationSeconds, 0);
      handleTimelineSeek(chunkIndex, chunkStartSeconds);
    },
    [handleTimelineSeek, slots],
  );

  // ── Render ────────────────────────────────────────────────
  const playButtonLabel = isPlaying ? "Pause" : isAutoplayBlocked ? "Resume" : "Play";

  return (
    <div
      aria-label="Playback controls"
      className="flex w-full flex-col gap-3 rounded-xl border border-[var(--line)] bg-[var(--surface)] p-4"
      ref={barRef}
      role="toolbar"
      tabIndex={-1}
    >
      {/* Top row: play/pause + timeline */}
      <div className="flex items-center gap-3">
        {/* Play/Pause button */}
        <button
          aria-label={playButtonLabel}
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[var(--amber)] text-white shadow-lg shadow-[var(--amber-soft)] transition hover:brightness-110 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--amber)]"
          onClick={() => (isPlaying ? onPause() : onPlay())}
          type="button"
        >
          {showSpinner ? (
            <span
              aria-hidden="true"
              className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent"
            />
          ) : isPlaying ? (
            /* Pause icon */
            <svg aria-hidden="true" className="h-4 w-4" fill="currentColor" viewBox="0 0 16 16">
              <rect height="14" rx="1" width="5" x="2.5" y="1" />
              <rect height="14" rx="1" width="5" x="8.5" y="1" />
            </svg>
          ) : (
            /* Play icon */
            <svg aria-hidden="true" className="ml-0.5 h-4 w-4" fill="currentColor" viewBox="0 0 16 16">
              <path d="M3 1.5v13l11-6.5L3 1.5z" />
            </svg>
          )}
        </button>

        {/* Waveform Timeline */}
        <div className="min-w-0 flex-1">
          <WaveformTimeline
            activeChunkIndex={activeChunkIndex}
            capturedWaveforms={capturedWaveforms}
            liveWaveform={liveWaveform}
            onClickChunk={handleTimelineClick}
            onSeek={handleTimelineSeek}
            slots={slots}
          />
        </div>
      </div>

      {/* Bottom row: metadata + controls */}
      <div className="flex items-center justify-between gap-4 text-xs text-[var(--ink-secondary)]">
        {/* Left: time display */}
        <div className="flex items-center gap-3 font-mono tabular-nums">
          {/* Current time */}
          <span className="font-semibold text-[var(--ink-primary)]">
            {formatClock(currentTimeSeconds)}
          </span>
          <span className="opacity-40">/</span>
          <span>{formatClock(renderedDurationSeconds)}</span>

          {/* Player state */}
          <span
            aria-live="polite"
            className={`ml-2 rounded-full px-2 py-0.5 text-[10px] font-medium ${
              playerStateLabel === "Playing"
                ? "bg-[var(--amber-soft)] text-[var(--amber)]"
                : playerStateLabel === "Playback complete"
                  ? "bg-emerald-900/30 text-emerald-400"
                  : playerStateLabel === "Buffering…" || playerStateLabel === "Preparing stream…"
                    ? "bg-white/5 text-[var(--ink-secondary)]"
                    : "bg-white/5 text-[var(--ink-secondary)]"
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
            <span className="ml-1">chunks</span>
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
