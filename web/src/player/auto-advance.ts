import type { PlayerJob } from "./player-store";

/** Same end tolerance the player uses for "reached the end". */
export const END_EPSILON_SECONDS = 0.5;

export interface AutoAdvanceInput {
  job: PlayerJob | null;
  currentTimeSeconds: number;
  renderedDurationSeconds: number;
  continuousPlay: boolean;
}

/**
 * Decide whether finishing this job should open the next one in its folder.
 *
 * Strict folder order is the server's `next_job_id`; this only checks that the
 * job really ended, that continuous play is on, and that there is somewhere to
 * go. Root jobs and the last job of a folder return null.
 */
export function resolveAutoAdvance({
  job,
  currentTimeSeconds,
  renderedDurationSeconds,
  continuousPlay,
}: AutoAdvanceInput): string | null {
  if (!job?.isTerminal || !job.nextJobId || !continuousPlay) return null;
  if (renderedDurationSeconds <= 0) return null;
  if (currentTimeSeconds < renderedDurationSeconds - END_EPSILON_SECONDS) {
    return null;
  }
  return job.nextJobId;
}
