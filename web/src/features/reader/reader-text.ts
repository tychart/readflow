import type { Chunk } from "../../types/api";
import { sortChunks } from "./chunk-utils";

/**
 * Reader text layout.
 *
 * The reader renders blocks derived from the canonical text, never from the raw
 * paste: one block per planned chunk (these carry the active/played styling,
 * the refs used for scroll sync, and the chunk numbers) plus a trailing dimmed
 * block for text the planner has not reached yet.
 */

/** Above this many unplanned characters the reader shows a bounded preview
 *  instead of the whole tail, so book-sized sources stay responsive. */
export const FULL_TAIL_RENDER_CHARS = 200_000;
export const UPCOMING_PREVIEW_CHARS = 12_000;

export interface ReaderTextSegment {
  key: string;
  kind: "chunk" | "upcoming";
  chunkIndex: number | null;
  text: string;
  /** Unplanned characters this block does not render (0 when nothing is hidden). */
  hiddenChars: number;
}

/**
 * Lay the canonical source text out as one block per planned chunk plus a
 * trailing block for text the planner has not reached yet.
 *
 * Chunk planning is buffer-aware and deliberately lazy, so a long paste used to
 * look truncated: only the handful of already-planned chunks were rendered and
 * the rest of the document simply was not there. Showing the upcoming tail (for
 * as long as it is cheap to render) makes the whole paste visible from the
 * start while keeping the chunk blocks that drive highlighting and seeking.
 */
export function buildReaderTextSegments(chunks: Chunk[], sourceText: string): ReaderTextSegment[] {
  const segments: ReaderTextSegment[] = [];
  let cursor = 0;
  for (const chunk of sortChunks(chunks)) {
    const start = Math.max(cursor, chunk.char_start);
    const end = Math.max(start, chunk.char_end);
    if (start > cursor) {
      segments.push({
        key: `gap-${cursor}`,
        kind: "upcoming",
        chunkIndex: null,
        text: sourceText.slice(cursor, start),
        hiddenChars: 0,
      });
    }
    segments.push({
      key: `chunk-${chunk.index}`,
      kind: "chunk",
      chunkIndex: chunk.index,
      text: sourceText.slice(start, end),
      hiddenChars: 0,
    });
    cursor = end;
  }

  const remaining = sourceText.length - cursor;
  if (remaining > 0) {
    const rendered = remaining <= FULL_TAIL_RENDER_CHARS ? remaining : UPCOMING_PREVIEW_CHARS;
    segments.push({
      key: "upcoming",
      kind: "upcoming",
      chunkIndex: null,
      text: sourceText.slice(cursor, cursor + rendered),
      hiddenChars: remaining - rendered,
    });
  }
  return segments;
}
