/**
 * Geometry for the reader's optional smart-follow mode.
 *
 * The playhead is kept within a comfortable reading band rather than pinned to
 * one exact point on every playback tick. That prevents a long chunk from
 * causing constant micro-scrolls while still keeping the spoken text visible.
 */
export interface FollowScrollTargetInput {
  /** Document-coordinate top and rendered height of the active chunk. */
  chunkTop: number;
  chunkHeight: number;
  /** Playback's approximate position within the active chunk, from 0 to 1. */
  progress: number;
  /** Current document scroll offset and viewport height. */
  scrollY: number;
  viewportHeight: number;
  /** Screen regions occupied by fixed/sticky reader controls. */
  topInset: number;
  bottomInset: number;
  /** A new active chunk should be aligned immediately, not merely checked. */
  forceAlign: boolean;
}

const TARGET_RATIO = 0.38;
const SAFE_TOP_RATIO = 0.18;
const SAFE_BOTTOM_RATIO = 0.82;

function clampUnit(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/**
 * Return a document scroll target when the current spoken point has moved out
 * of the readable band, or `null` when no scroll is needed.
 */
export function followScrollTarget({
  chunkTop,
  chunkHeight,
  progress,
  scrollY,
  viewportHeight,
  topInset,
  bottomInset,
  forceAlign,
}: FollowScrollTargetInput): number | null {
  const readableTop = scrollY + Math.max(0, topInset);
  const readableBottom =
    scrollY + Math.max(topInset, viewportHeight - bottomInset);
  const readableHeight = readableBottom - readableTop;
  if (readableHeight <= 0 || chunkHeight <= 0) return null;

  // On entering a chunk, orient the reader from its beginning. Once it is
  // active, follow an approximate point inside it so oversized blocks can move
  // naturally through the viewport without a per-tick forced scroll.
  const spokenPoint =
    chunkTop + (forceAlign ? 0 : chunkHeight * clampUnit(progress));
  const safeTop = readableTop + readableHeight * SAFE_TOP_RATIO;
  const safeBottom = readableTop + readableHeight * SAFE_BOTTOM_RATIO;

  if (!forceAlign && spokenPoint >= safeTop && spokenPoint <= safeBottom) {
    return null;
  }

  return Math.max(0, spokenPoint - readableHeight * TARGET_RATIO - topInset);
}
