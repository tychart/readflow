/**
 * Streaming window rules for the reader's MSE player.
 *
 * A job can be a whole book — hours of audio — and a `SourceBuffer` is not
 * allowed to hold all of it. Appending every rendered chunk into one
 * SourceBuffer is what produced, on a phone:
 *
 *   Failed to execute 'appendBuffer' on 'SourceBuffer': The SourceBuffer is
 *   full, and cannot free space to append additional buffers.
 *
 * (Chromium and WebKit both enforce a memory quota per SourceBuffer; it is far
 * smaller on mobile.) The player therefore keeps a bounded window of audio: a
 * few minutes ahead of the playhead and a couple of minutes behind it, evicting
 * everything older. The window is a *prefix* of the anchored stream, because in
 * `sequence` mode segments are laid out back-to-back in append order — the only
 * thing that can be trimmed is the front.
 *
 * These rules are pure so the thresholds and eviction math are testable without
 * a browser media stack.
 */

/** How much audio to keep buffered ahead of the playhead. */
export const STREAM_WINDOW_AHEAD_SECONDS = 240;
/** How much played audio to keep behind the playhead so skips stay instant. */
export const STREAM_WINDOW_KEEP_BEHIND_SECONDS = 120;
/**
 * Top the window up once less than this remains ahead. Refilling in steps
 * (rather than chunk-by-chunk on every tick) keeps append churn low.
 */
export const STREAM_WINDOW_REFILL_SECONDS = 30;
/**
 * A pending seek needs the chunk that *contains* its target, and chunks are
 * selected by their start time — so the window has to reach one second past the
 * target, not exactly to it.
 */
export const STREAM_WINDOW_SEEK_LOOKAHEAD_SECONDS = 1;
/**
 * When the browser reports a buffer quota error we free aggressively: everything
 * except the last few seconds the listener is about to hear.
 */
export const STREAM_WINDOW_EMERGENCY_KEEP_BEHIND_SECONDS = 10;
/** Sub-second slack so float noise never triggers a pointless append/removal. */
export const STREAM_WINDOW_EPSILON_SECONDS = 0.05;

export interface SecondsRange {
  start: number;
  end: number;
}

export interface WindowFillInput {
  playheadSeconds: number;
  bufferedUntilSeconds: number;
  /** Stream-normalized target of a seek that has not been applied yet. */
  pendingSeekSeconds: number | null;
}

/**
 * End (in stream seconds) of the audio we want buffered. Normally the playhead
 * plus the lookahead; a pending seek extends it so the seek's own chunk is
 * fetched even before the playhead reaches that part of the stream.
 */
export function resolveAppendWindowEnd({
  playheadSeconds,
  pendingSeekSeconds,
}: Pick<WindowFillInput, "playheadSeconds" | "pendingSeekSeconds">): number {
  const aheadEnd = Math.max(0, playheadSeconds) + STREAM_WINDOW_AHEAD_SECONDS;
  if (pendingSeekSeconds === null) {
    return aheadEnd;
  }
  return Math.max(aheadEnd, pendingSeekSeconds + STREAM_WINDOW_SEEK_LOOKAHEAD_SECONDS);
}

/**
 * True when the window is worth topping up: either the audio ahead has dropped
 * below the refill threshold, or a pending seek still needs audio that is not
 * buffered yet.
 */
export function needsWindowFill({
  playheadSeconds,
  bufferedUntilSeconds,
  pendingSeekSeconds,
}: WindowFillInput): boolean {
  if (pendingSeekSeconds !== null && pendingSeekSeconds > bufferedUntilSeconds) {
    return true;
  }
  const remainingAhead = bufferedUntilSeconds - Math.max(0, playheadSeconds);
  return remainingAhead < STREAM_WINDOW_AHEAD_SECONDS - STREAM_WINDOW_REFILL_SECONDS;
}

/**
 * Range to drop from the front of the buffer: everything before the keep-behind
 * margin. Returns `null` when there is nothing worth removing.
 *
 * The end is always strictly behind the playhead, so evicting never removes
 * audio that is about to be played.
 */
export function resolveEvictionRange(
  bufferedStartSeconds: number,
  playheadSeconds: number,
  keepBehindSeconds: number = STREAM_WINDOW_KEEP_BEHIND_SECONDS,
): SecondsRange | null {
  const end = Math.max(0, playheadSeconds) - Math.max(0, keepBehindSeconds);
  if (end - bufferedStartSeconds <= STREAM_WINDOW_EPSILON_SECONDS) {
    return null;
  }
  return { start: 0, end };
}

/**
 * Whether a position falls inside one of the element's buffered ranges. Used to
 * tell "this audio is loaded" apart from "this audio was evicted", which decides
 * between an in-stream seek and reopening the stream.
 */
export function isSecondsBuffered(ranges: SecondsRange[], targetSeconds: number): boolean {
  for (const range of ranges) {
    if (
      targetSeconds >= range.start - STREAM_WINDOW_EPSILON_SECONDS &&
      targetSeconds <= range.end + STREAM_WINDOW_EPSILON_SECONDS
    ) {
      return true;
    }
  }
  return false;
}

/** True when the position is behind the retained audio (played and evicted). */
export function isSecondsEvicted(ranges: SecondsRange[], targetSeconds: number): boolean {
  if (ranges.length === 0) {
    return false;
  }
  return targetSeconds < ranges[0].start - STREAM_WINDOW_EPSILON_SECONDS;
}
