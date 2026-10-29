/** Shared clock formatting for playback surfaces. */
export function formatClock(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

/**
 * Playback speed for display, without trailing zeros: 1 → "1", 1.5 → "1.5".
 * Shared so the speed control, its presets and the playbar indicator cannot
 * disagree about how the same rate is written.
 */
export function formatSpeed(value: number): string {
  return Number.parseFloat(value.toFixed(3)).toString();
}
