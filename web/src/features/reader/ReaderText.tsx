import { memo } from "react";
import type { RefObject } from "react";

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
        ref={contentRef}
      >
        <div className="space-y-2">{lines}</div>
      </div>
    </>
  );
}

/* ── Chunk blocks ─────────────────────────────────────────── */

export interface ReaderChunkBlockProps {
  chunkIndex: number;
  /** Chunk text, sliced from the canonical source text. */
  text: string;
  isActive: boolean;
  isPlayed: boolean;
  /** Registers the block element so explicit seeks can scroll it into view. */
  onRegisterRef: (chunkIndex: number, element: HTMLDivElement | null) => void;
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
}: ReaderChunkBlockProps) {
  return (
    <div
      className={`relative rounded-lg border-l-2 px-4 py-3 transition-all [contain-intrinsic-size:auto_160px] [content-visibility:auto] ${
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
      {/* Chunk number indicator */}
      <div
        className={`mb-1 text-[10px] font-semibold uppercase tracking-wider ${
          isActive ? "text-[var(--amber)]" : "text-[var(--ink-secondary)]"
        }`}
      >
        Chunk {chunkIndex + 1}
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
            onRegisterRef={onRegisterChunkRef}
            text={segment.text}
          />
        ),
      )}
    </>
  );
}
