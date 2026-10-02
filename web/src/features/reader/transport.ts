/**
 * Transport presentation state.
 *
 * The same play/pause button appears in the top playbar and in the phone bottom
 * dock, so the rules for what it says and whether it spins live here once rather
 * than being re-derived per surface.
 */

export interface TransportState {
  isAutoplayBlocked: boolean;
  isJobTerminal: boolean;
  isPlaying: boolean;
  isWaitingForData: boolean;
  playIntent: boolean;
}

/** Accessible name and icon choice for the play/pause button. */
export function resolvePlayButtonLabel({
  isAutoplayBlocked,
  playIntent,
}: Pick<TransportState, "isAutoplayBlocked" | "playIntent">): "Play" | "Pause" | "Resume" {
  if (isAutoplayBlocked) return "Resume";
  return playIntent ? "Pause" : "Play";
}

/** True while the play button should show a spinner instead of an icon. */
export function resolveShowSpinner({
  isAutoplayBlocked,
  isPlaying,
  isWaitingForData,
  playIntent,
}: Omit<TransportState, "isJobTerminal">): boolean {
  return (playIntent && !isAutoplayBlocked && !isPlaying) || isWaitingForData;
}

export interface PlayerStateInput extends TransportState {
  renderedDurationSeconds: number;
  displayTimeSeconds: number;
  displayDurationSeconds: number;
}

/** The status pill's text, e.g. "Playing" / "Buffering…" / "Ready". */
export function resolvePlayerStateLabel(state: PlayerStateInput): string {
  if (state.isAutoplayBlocked) return "Playback blocked by browser";
  if (
    state.isJobTerminal &&
    state.renderedDurationSeconds > 0 &&
    state.displayTimeSeconds >= state.displayDurationSeconds
  ) {
    return "Playback complete";
  }
  if (state.isPlaying) return "Playing";
  if (state.playIntent && state.isWaitingForData) return "Buffering…";
  if (state.playIntent && !state.isPlaying && state.renderedDurationSeconds <= 0) {
    return "Preparing stream…";
  }
  if (state.playIntent) return "Starting…";
  return "Ready";
}
