import type { PlayerJob } from "./player-store";

/** Same end tolerance the player uses for "reached the end". */
export const END_EPSILON_SECONDS = 0.5;

/**
 * True when `seconds` has reached the end of a job that is `durationSeconds`
 * long.
 *
 * This is deliberately about the **job's** end, not the end of the loaded
 * stream: a terminal job with a failed chunk in the middle stops at the gap,
 * and that is not the end of the document.
 */
export function isAtJobEnd(seconds: number, durationSeconds: number): boolean {
  return (
    durationSeconds > END_EPSILON_SECONDS &&
    seconds >= durationSeconds - END_EPSILON_SECONDS
  );
}

export interface AutoAdvanceInput {
  job: PlayerJob | null;
  /** The media element actually reached the end of what it could play. */
  hasEnded: boolean;
  /**
   * End of the audio the player can reach: the anchor offset plus the stream
   * duration. A gap stops playback well before the job's real end.
   */
  streamEndSeconds: number;
  /** Total known duration of the job. */
  durationSeconds: number;
  continuousPlay: boolean;
}

/**
 * Decide whether finishing this job should open the next one in its folder.
 *
 * Strict folder order is the server's `next_job_id`; this only checks that
 * playback really ended (not merely paused at the end, and not at a gap), that
 * continuous play is on, and that there is somewhere to go. Root jobs and the
 * last job of a folder return null.
 */
export function resolveAutoAdvance({
  job,
  hasEnded,
  streamEndSeconds,
  durationSeconds,
  continuousPlay,
}: AutoAdvanceInput): string | null {
  if (!job?.isTerminal || !job.nextJobId || !continuousPlay || !hasEnded) {
    return null;
  }
  if (!isAtJobEnd(streamEndSeconds, durationSeconds)) return null;
  return job.nextJobId;
}
