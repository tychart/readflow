import { useCallback, useMemo } from "react";

import {
  resolvePlayButtonLabel,
  resolvePlayerStateLabel,
  resolveShowSpinner,
} from "../features/reader/transport";
import { formatClock } from "../lib/format";
import type { TimelineSlotData } from "../types/timeline";
import { TransportControls } from "./TransportControls";
import { WaveformTimeline } from "./WaveformTimeline";

/* ── Types ────────────────────────────────────────────────── */

export interface PlaybarProps {
  /** Ordered timeline slots. Updated as chunks arrive. */
  slots: TimelineSlotData[];
  /**
   * Analyzed waveform peaks per chunk index (from the backend), rendered
   * statically by the timeline.
   */
  waveforms: Map<number, Float32Array>;
  /** Current playhead position in seconds (stream-normalized for the playhead visual). */
  /** Total rendered duration in the stream, or 0 if none. */
  renderedDurationSeconds: number;
  /** Position to display on the clock (original timeline coords, not normalized). */
  displayTimeSeconds: number;
  /** Total duration to display on the clock (original timeline). */
  displayDurationSeconds: number;
  /**
   * End of the playable range in original timeline coordinates (not
   * stream-normalized). Drives the timeline's playhead maximum.
   */
  displayRenderedDurationSeconds: number;
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
  /** Seek by a relative offset in seconds (the −10s / +10s buttons). */
  onSkip: (deltaSeconds: number) => void;
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
  /**
   * Reader settings control. Rendered outside the fading metadata row so it
   * stays reachable after the playbar compacts.
   */
  settingsSlot?: React.ReactNode;
  /**
   * Playback speed control. Like the settings gear this lives in the top row,
   * not the metadata row: that row fades out as the playbar compacts on scroll,
   * and on main the speed control was always visible.
   */
  speedSlot?: React.ReactNode;
  /**
   * Whether this bar renders the −10s / play-pause / +10s controls. Phones move
   * them into the bottom dock and keep this bar as the whole-document overview.
   */
  showTransport?: boolean;
}

/* ── Component ────────────────────────────────────────────── */

/**
 * Playbar — Full-width playback control bar for the Reader page.
 *
 * Orchestrates the static waveform timeline, providing transport controls, seek,
 * time display and download. Keyboard shortcuts are deliberately NOT handled
 * here: they live in `usePlaybackShortcuts` and are page-wide, so the keys work
 * without the playbar holding focus.
 */
export function Playbar({
  slots,
  waveforms,
  renderedDurationSeconds,
  displayTimeSeconds,
  displayDurationSeconds,
  displayRenderedDurationSeconds,
  isPlaying,
  playIntent,
  isAutoplayBlocked,
  isJobTerminal,
  isWaitingForData,
  canDownload,
  isDownloadComplete,
  onPlay,
  onPause,
  onSkip,
  onSeekToChunk,
  onDownload,
  isDownloading = false,
  totalChunks,
  writtenChunks,
  scrollProgress,
  settingsSlot,
  showTransport = true,
  speedSlot,
}: PlaybarProps) {
  // ── Player state for display ──────────────────────────────
  const playerStateLabel = useMemo(
    () =>
      resolvePlayerStateLabel({
        displayDurationSeconds,
        displayTimeSeconds,
        isAutoplayBlocked,
        isJobTerminal,
        isPlaying,
        isWaitingForData,
        playIntent,
        renderedDurationSeconds,
      }),
    [
      displayDurationSeconds,
      displayTimeSeconds,
      isAutoplayBlocked,
      isJobTerminal,
      isPlaying,
      isWaitingForData,
      playIntent,
      renderedDurationSeconds,
    ],
  );

  const playButtonLabel = resolvePlayButtonLabel({ isAutoplayBlocked, playIntent });
  const showSpinner = resolveShowSpinner({
    isAutoplayBlocked,
    isPlaying,
    isWaitingForData,
    playIntent,
  });

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
  // "Pause" while playIntent is set (even before audio starts), "Resume" when
  // the browser blocked autoplay — both come from `resolvePlayButtonLabel` so
  // the top bar and the phone dock cannot disagree.

  // ── Smooth interpolated values ────────────────────────────
  // All animate linearly as scrollProgress goes 0 → 1
  const containerPad = Math.round(20 - scrollProgress * 20); // 20px → 0px
  const btnSize = Math.round(48 - scrollProgress * 12); // 48px → 36px
  const iconSize = Math.round(16 - scrollProgress * 4); // 16px → 12px
  const skipSize = Math.round(36 - scrollProgress * 8); // 36px → 28px
  const skipIconSize = Math.round(14 - scrollProgress * 3); // 14px → 11px
  const transportGap = Math.max(2, Math.round(8 - scrollProgress * 4)); // 8px → 4px
  const gap = 12 - scrollProgress * 4;                      // 12px → 8px
  const metaOpacity = Math.max(0, 1 - scrollProgress * 1.2); // fades out by ~0.83
  // Fade the card border/background out as compact approaches
  const cardVisibility = 1 - Math.min(1, scrollProgress * 1.5);

  return (
    <div
      aria-label="Playback controls"
      className="relative flex w-full flex-col"
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

      {/* Top row: transport + timeline + settings.
          z-20 keeps this row (and the settings popover anchored inside it) above
          the metadata row below, which is a sibling stacking context at z-10. */}
      <div
        className="relative z-20 flex items-center gap-3"
        style={{ padding: `${containerPad}px` }}
      >
        {/* Transport: −10s / play-pause / +10s. Phones render these in the
            bottom dock instead, so this bar stays the overview. */}
        {showTransport ? (
          <TransportControls
            gapPx={transportGap}
            onPause={onPause}
            onPlay={onPlay}
            onSkip={onSkip}
            playButtonSizePx={btnSize}
            playIconSizePx={iconSize}
            playLabel={playButtonLabel}
            showPauseIcon={isPlaying || playIntent}
            showSpinner={showSpinner}
            skipButtonSizePx={skipSize}
            skipIconSizePx={skipIconSize}
          />
        ) : null}

        {/* Waveform Timeline */}
        <div className="min-w-0 flex-1">
          <WaveformTimeline
            scrollProgress={scrollProgress}
            playheadSeconds={displayTimeSeconds}
            onClickChunk={handleTimelineClick}
            onSeek={handleTimelineSeek}
            renderedDurationSeconds={displayRenderedDurationSeconds}
            slots={slots}
            waveforms={waveforms}
          />
        </div>

        {/* Reader settings and playback speed — outside the fading metadata row
            below so they stay reachable once the playbar has compacted. */}
        {speedSlot ? <div className="shrink-0">{speedSlot}</div> : null}
        {settingsSlot ? <div className="shrink-0">{settingsSlot}</div> : null}
      </div>

      {/* Bottom row: metadata + controls — fades out progressively */}
      <div
        className="relative z-10 flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-xs text-[var(--ink-secondary)]"
        style={{
          opacity: metaOpacity,
          maxHeight: metaOpacity > 0 ? '50px' : '0px',
          overflow: 'hidden',
          paddingLeft: `${containerPad}px`,
          paddingRight: `${containerPad}px`,
          paddingBottom: `${containerPad > 0 ? containerPad : 0}px`,
        }}
      >
        {/* Left: time display — uses original timeline coords, fixed-width */}
        <div className="flex items-center gap-3 font-mono tabular-nums">
          <span className="inline-block min-w-[44px] text-right font-semibold text-[var(--ink-primary)]">
            {formatClock(displayTimeSeconds)}
          </span>
          <span className="opacity-40">/</span>
          <span className="inline-block min-w-[44px]">{formatClock(displayDurationSeconds)}</span>

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
            {/* Chunk counter — secondary detail, dropped on phone widths */}
            <span className="hidden tabular-nums sm:inline">
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
