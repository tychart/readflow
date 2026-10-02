import { memo } from "react";
import type { CSSProperties, RefObject } from "react";

import type { ReaderTextSegment } from "./reader-text";

/* ── Reader chrome ────────────────────────────────────────── */

export interface ReaderContentProps {
  contentRef: RefObject<HTMLDivElement | null>;
  title: string;
  status: string | undefined;
  lines: React.ReactNode;
  isLargeScreen: boolean;
  sidebarOpen: boolean;
  onToggleSidebar: () => void;
  /**
   * Whether audio is actually running. Drives the now-playing equalizer's
   * paused state through a single attribute on the text container, so a
   * play/pause flip costs one attribute change instead of re-rendering every
   * memoized chunk block.
   */
  isPlaying: boolean;
  /** Reader motion setting; keeps the now-playing marker static when reduced. */
  motion: "animated" | "reduced";
}

/**
 * Reader header + document container.
 *
 * This MUST stay a module-scope component. It was once defined inside
 * `ReaderPage`, which gave it a new identity on every render; during playback
 * the reader re-renders ~20x/s, so React unmounted and remounted the entire
 * content subtree (including the sidebar toggle button) on every tick and
 * swallowed clicks.
 */
export function ReaderContent({
  contentRef,
  title,
  status,
  lines,
  isLargeScreen,
  sidebarOpen,
  onToggleSidebar,
  isPlaying,
  motion,
}: ReaderContentProps) {
  return (
    <>
      {/* Header row with title + toggle */}
      <div className="mb-4 flex items-center justify-between">
        <div>
          <p className="text-xs uppercase tracking-[0.2em] text-[var(--ink-secondary)]">Reader</p>
          <h2 className="mt-1 text-xl font-bold text-[var(--ink-primary)]">{title}</h2>
        </div>
        <div className="flex items-center gap-2">
          <span className="rounded-md border border-[var(--line)] px-3 py-1 text-xs font-medium text-[var(--ink-secondary)]">
            {status}
          </span>
          {/* Sidebar toggle — only on large screens when sidebar is inline */}
          {isLargeScreen && (
            <button
              aria-label={sidebarOpen ? "Close sidebar" : "Open sidebar"}
              className="flex h-8 w-8 items-center justify-center rounded-md text-[var(--ink-secondary)] transition-colors hover:bg-[var(--hover-bg)] hover:text-[var(--ink-primary)]"
              onClick={onToggleSidebar}
              type="button"
            >
              {sidebarOpen ? (
                <svg
                  aria-hidden="true"
                  className="h-4 w-4"
                  fill="none"
                  stroke="currentColor"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth="2"
                  viewBox="0 0 24 24"
                >
                  <rect height="18" rx="2" ry="2" width="18" x="3" y="3" />
                  <line x1="15" x2="15" y1="3" y2="21" />
                </svg>
              ) : (
                <svg
                  aria-hidden="true"
                  className="h-4 w-4"
                  fill="none"
                  stroke="currentColor"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth="2"
                  viewBox="0 0 24 24"
                >
                  <rect height="18" rx="2" ry="2" width="18" x="3" y="3" />
                  <line x1="9" x2="9" y1="3" y2="21" />
                </svg>
              )}
            </button>
          )}
        </div>
      </div>

      {/* Source text — no inner scroll, flows with page */}
      <div
        className="rounded-xl border border-[var(--line)] bg-[var(--surface)] p-5"
        data-motion={motion}
        data-now-playing={isPlaying ? "running" : "paused"}
        ref={contentRef}
      >
        <div className="space-y-2">{lines}</div>
      </div>
    </>
  );
}

/* ── Chunk blocks ─────────────────────────────────────────── */

/**
 * Bar heights for the now-playing equalizer, as a percentage of the icon box.
 * Deliberately uneven so the bars read as a live signal rather than a chart.
 */
const NOW_PLAYING_BAR_HEIGHTS = [58, 100, 74, 90];

export interface ReaderChunkBlockProps {
  chunkIndex: number;
  /** Chunk text, sliced from the canonical source text. */
  text: string;
  isActive: boolean;
  isPlayed: boolean;
  /** Registers the block element so explicit seeks can scroll it into view. */
  onRegisterRef: (chunkIndex: number, element: HTMLDivElement | null) => void;
  /** Renders the jump control (reader setting; hiding it hides no status). */
  showJumpButton: boolean;
  /** Jumps playback to this chunk. Must be stable or memoization is defeated. */
  onJump: (chunkIndex: number) => void;
}

/**
 * One planned chunk of narration.
 *
 * Memoized on purpose: a book has thousands of these blocks and playback
 * re-renders the reader ~20x/s, while only the active/played state of at most a
 * couple of chunks changes per tick. `onRegisterRef` must be stable from the
 * parent or memoization is defeated.
 *
 * `content-visibility: auto` is load-bearing — it is what keeps thousands of
 * offscreen blocks cheap.
 */
export const ReaderChunkBlock = memo(function ReaderChunkBlock({
  chunkIndex,
  text,
  isActive,
  isPlayed,
  onRegisterRef,
  showJumpButton,
  onJump,
}: ReaderChunkBlockProps) {
  return (
    <div
      className={`group relative rounded-lg border-l-2 px-4 py-3 transition-all [contain-intrinsic-size:auto_160px] [content-visibility:auto] ${
        isActive
          ? "border-l-[var(--amber)] bg-[var(--amber-soft)] shadow-[var(--amber-glow)]"
          : isPlayed
            ? "border-l-white/5 opacity-60"
            : "border-l-white/5"
      }`}
      data-chunk-block={chunkIndex}
      data-chunk-state={isActive ? "active" : isPlayed ? "played" : "idle"}
      ref={(element) => onRegisterRef(chunkIndex, element)}
    >
      {/* Header row: chunk number + jump control */}
      <div className="mb-1 flex items-center justify-between gap-2">
        <div
          className={`text-[10px] font-semibold uppercase tracking-wider ${
            isActive ? "text-[var(--amber)]" : "text-[var(--ink-secondary)]"
          }`}
        >
          Chunk {chunkIndex + 1}
        </div>

        {showJumpButton ? (
          isActive ? (
            /* The control is a no-op on the chunk already playing, so it becomes
               a status marker instead. */
            <span
              aria-label="Currently playing"
              className="flex h-5 w-5 items-center justify-center text-[var(--amber)]"
              data-testid={`chunk-${chunkIndex}-now-playing`}
              role="img"
              title="Currently playing"
            >
              {/* Equalizer bars — the standard "this is what's playing" marker.
                  Applied only when reader motion allows it; paused by CSS while
                  audio is not actually running. */}
              <span aria-hidden="true" className="flex h-3.5 items-end justify-center gap-[1.5px]">
                {NOW_PLAYING_BAR_HEIGHTS.map((heightPercent, barIndex) => (
                  <span
                    className="w-[2px] origin-bottom rounded-full bg-current"
                    data-now-playing-bar
                    key={barIndex}
                    style={
                      {
                        "--equalizer-delay": `${barIndex * 130}ms`,
                        "--equalizer-duration": `${800 + barIndex * 170}ms`,
                        height: `${heightPercent}%`,
                      } as CSSProperties
                    }
                  />
                ))}
              </span>
            </span>
          ) : (
            <button
              aria-label={`Jump playback to chunk ${chunkIndex + 1}`}
              className="flex h-5 w-5 items-center justify-center rounded text-[var(--ink-secondary)] opacity-50 transition-opacity hover:text-[var(--amber)] hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--amber)] group-hover:opacity-100"
              data-testid={`chunk-${chunkIndex}-jump`}
              onClick={() => onJump(chunkIndex)}
              title="Jump playback here"
              type="button"
            >
              {/* Curved return arrow: "bring playback back to here". The previous
                  arrow-down-to-a-line glyph read as a download icon. */}
              <svg
                aria-hidden="true"
                className="h-3.5 w-3.5"
                fill="none"
                stroke="currentColor"
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth="2"
                viewBox="0 0 24 24"
              >
                <path d="M9 14 4 9l5-5" />
                <path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" />
              </svg>
            </button>
          )
        ) : null}
      </div>

      <p className="whitespace-pre-wrap text-sm leading-relaxed text-[var(--ink-primary)]">
        {text.trim() || "(empty text)"}
      </p>
    </div>
  );
});

export interface ReaderUpcomingBlockProps {
  text: string;
  /** Unplanned characters this block does not render (0 when nothing is hidden). */
  hiddenChars: number;
}

/** Dimmed tail block for text the planner has not reached yet. */
export function ReaderUpcomingBlock({ text, hiddenChars }: ReaderUpcomingBlockProps) {
  return (
    <div className="relative rounded-lg border-l-2 border-l-white/5 px-4 py-3 opacity-45 [contain-intrinsic-size:auto_160px] [content-visibility:auto]">
      <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-[var(--ink-secondary)]">
        Upcoming text
        {hiddenChars > 0
          ? ` — ${hiddenChars.toLocaleString()} more characters not shown`
          : " — not queued yet"}
      </div>
      <p className="whitespace-pre-wrap text-sm leading-relaxed text-[var(--ink-primary)]">{text}</p>
    </div>
  );
}

/* ── Body ─────────────────────────────────────────────────── */

export interface ReaderTextBodyProps {
  segments: ReaderTextSegment[];
  activeChunkIndex: number | null;
  playedIndexes: Set<number>;
  onRegisterChunkRef: (chunkIndex: number, element: HTMLDivElement | null) => void;
  /** Reader setting: show the per-chunk jump control. */
  showJumpButtons: boolean;
  onJumpToChunk: (chunkIndex: number) => void;
}

/**
 * The document body: one memoized block per chunk segment plus dimmed tail
 * blocks, or an empty-state message before any chunk exists.
 */
export function ReaderTextBody({
  segments,
  activeChunkIndex,
  playedIndexes,
  onRegisterChunkRef,
  showJumpButtons,
  onJumpToChunk,
}: ReaderTextBodyProps) {
  if (segments.length === 0) {
    return (
      <p className="py-8 text-center text-sm text-[var(--ink-secondary)]">
        No chunks available yet. Press play to start.
      </p>
    );
  }

  return (
    <>
      {segments.map((segment) =>
        segment.kind === "upcoming" ? (
          <ReaderUpcomingBlock hiddenChars={segment.hiddenChars} key={segment.key} text={segment.text} />
        ) : (
          <ReaderChunkBlock
            chunkIndex={segment.chunkIndex ?? 0}
            isActive={segment.chunkIndex === activeChunkIndex}
            isPlayed={segment.chunkIndex !== null && playedIndexes.has(segment.chunkIndex)}
            key={segment.key}
            onJump={onJumpToChunk}
            onRegisterRef={onRegisterChunkRef}
            showJumpButton={showJumpButtons}
            text={segment.text}
          />
        ),
      )}
    </>
  );
}
