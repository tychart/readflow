/**
 * Shared timeline vocabulary.
 *
 * These types are imported by the pure geometry helpers (`lib/waveform-timeline`)
 * and by every waveform surface that renders them (the main `WaveformTimeline`
 * and the reader's chunk conveyor), so they live outside any one component.
 */

/** Visual/playback state of a single chunk slot. */
export type TimelineSlotState =
  | "played"
  | "playing"
  | "ready"
  | "ready_after_gap"
  | "missing_expected"
  | "failed";

/** One chunk-sized slot on a waveform timeline. */
export interface TimelineSlotData {
  chunkIndex: number;
  state: TimelineSlotState;
  durationSeconds: number;
}
