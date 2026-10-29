import { useCallback, useMemo } from "react";

import {
  resolvePlayButtonLabel,
  resolvePlayerStateLabel,
  resolveShowSpinner,
} from "../features/reader/transport";
import { formatClock, formatSpeed } from "../lib/format";
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
  /** True when the job is in a terminal state (completed/failed). */
  isJobTerminal: boolean;
  /**
   * True while the client is still fetching/priming the audio the listener
   * asked for (a seek outside the loaded window, or a stream that has not
   * opened yet). Drives the spinner and the "Loading audio…" pill instead of
   * "Buffering…", which means the producer has not rendered far enough yet.
   */
  isLoadingAudio: boolean;
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
   * Live playback speed. Shown as a small badge in the metadata row (only when
   * it is not 1×); the control that changes it lives in the reader settings.
   */
  playbackRate: number;
  /**
   * Reader settings control. Rendered outside the fading metadata row so it
   * stays reachable after the playbar compacts.
   */
  settingsSlot?: React.ReactNode;
  /**
   * Manual "render the rest of this job" action. Lives in the top row like the
   * settings control, because the metadata row fades out on scroll.
   */
  renderAheadSlot?: React.ReactNode;
  /**
   * Whether this bar renders the −10s / play-pause / +10s controls. Phones move
   * them into the bottom dock and keep this bar as the whole-document overview.
   */
  showTransport?: boolean;
}

/* ── Scroll-linked geometry ───────────────────────────────── */

/**
 * A CSS length that interpolates between the expanded (top of page) value and
 * the compact (scrolled) one.
 *
 * Progress arrives as the `--scroll-progress` custom property, written onto the
 * sticky wrapper by `useScrollProgressVar`. Keeping the interpolation in CSS is
 * intentional: this value changes on every scroll frame, and computing it in
 * React (or routing it through state) re-rendered the page per frame. It also
 * means there are no hard thresholds left to flip a size on and off.
 */
const shrink = (expandedPx: number, compactPx: number) =>
  `calc(${expandedPx}px - var(--scroll-progress, 0) * ${expandedPx - compactPx}px)`;

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
  isLoadingAudio,
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
  playbackRate,
  settingsSlot,
  showTransport = true,
  renderAheadSlot,
}: PlaybarProps) {
  // ── Player state for display ──────────────────────────────
  const playerStateLabel = useMemo(
    () =>
      resolvePlayerStateLabel({
        displayDurationSeconds,
        displayTimeSeconds,
        isAutoplayBlocked,
        isJobTerminal,
        isLoadingAudio,
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
      isLoadingAudio,
      isPlaying,
      isWaitingForData,
      playIntent,
      renderedDurationSeconds,
    ],
  );

  const playButtonLabel = resolvePlayButtonLabel({ isAutoplayBlocked, playIntent });
  const showSpinner = resolveShowSpinner({
    isAutoplayBlocked,
    isLoadingAudio,
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
  // All interpolate linearly as --scroll-progress goes 0 → 1, in CSS, so no
  // React render is needed per scroll frame.
  const containerPad = shrink(20, 0); // 20px → 0px
  const btnSize = shrink(48, 36); // 48px → 36px
  const iconSize = shrink(16, 12); // 16px → 12px
  const skipSize = shrink(36, 28); // 36px → 28px
  const skipIconSize = shrink(14, 11); // 14px → 11px
  const transportGap = shrink(8, 4); // 8px → 4px
  const gap = shrink(12, 8); // 12px → 8px

  return (
    <div
      aria-label="Playback controls"
      className="relative flex w-full flex-col"
      role="toolbar"
      style={{ gap }}
      tabIndex={-1}
    >
      {/* Card background/border — fades out as the bar compacts. Absolute, so it
          never contributes layout. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 rounded-xl border border-[var(--line)] bg-[var(--surface)]"
        style={{ opacity: "calc(1 - var(--scroll-progress, 0) * 1.5)" }}
      />

      {/* Top row: transport + timeline + settings.
          z-20 keeps this row (and the settings popover anchored inside it) above
          the metadata row below, which is a sibling stacking context at z-10. */}
      <div
        className="relative z-20 flex items-center gap-3"
        data-testid="playbar-top-row"
        style={{ padding: containerPad }}
      >
        {/* Transport: −10s / play-pause / +10s. Phones render these in the
            bottom dock instead, so this bar stays the overview. */}
        {showTransport ? (
          <TransportControls
            gap={transportGap}
            onPause={onPause}
            onPlay={onPlay}
            onSkip={onSkip}
            playButtonSize={btnSize}
            playIconSize={iconSize}
            playLabel={playButtonLabel}
            showPauseIcon={isPlaying || playIntent}
            showSpinner={showSpinner}
            skipButtonSize={skipSize}
            skipIconSize={skipIconSize}
          />
        ) : null}

        {/* Waveform Timeline */}
        <div className="min-w-0 flex-1">
          <WaveformTimeline
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
        {renderAheadSlot ? <div className="shrink-0">{renderAheadSlot}</div> : null}
        {settingsSlot ? <div className="shrink-0">{settingsSlot}</div> : null}
      </div>

      {/* Bottom row: metadata + controls — fades out and collapses progressively.
          The max-height interpolation replaces the old hard 50px→0px snap, which
          flipped the row in and out of layout at one scroll offset. */}
      <div
        className="relative z-10 flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-xs text-[var(--ink-secondary)]"
        data-testid="playbar-meta"
        style={{
          opacity: "calc(1 - var(--scroll-progress, 0) * 1.2)",
          maxHeight: shrink(50, 0),
          overflow: "hidden",
          paddingLeft: containerPad,
          paddingRight: containerPad,
          paddingBottom: containerPad,
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
                    : playerStateLabel === "Buffering…" || playerStateLabel === "Loading audio…"
                      ? "bg-amber-900/30 text-amber-400"
                      : "bg-[var(--hover-bg)] text-[var(--ink-secondary)]"
              }`}
            >
              {playerStateLabel}
            </span>

            {/* Playback speed — only worth surfacing when it is off the default.
                It lives in the metadata row on purpose: that row fades away on
                scroll, so the badge costs the compact bar no space. */}
            {playbackRate !== 1 ? (
              <span
                className="ml-2 inline-block rounded-full bg-[var(--hover-bg)] px-2 py-0.5 text-[10px] font-semibold tabular-nums text-[var(--ink-secondary)]"
                data-testid="playback-rate-indicator"
                title={`Playback speed ${formatSpeed(playbackRate)}×`}
              >
                {formatSpeed(playbackRate)}×
              </span>
            ) : null}
          </div>

          {/* Right: chunk counter + download */}

          {/* Chunk counter + download */}
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
