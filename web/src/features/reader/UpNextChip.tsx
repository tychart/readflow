import { setReaderSettings } from "../../state/reader-settings";

interface UpNextChipProps {
  nextTitle: string | null;
  continuousPlay: boolean;
}

/**
 * Names the job continuous play will open, and lets the listener turn it off
 * for good. Lives in the playbar's metadata row, which fades away on scroll, so
 * it costs the compact bar no space.
 */
export function UpNextChip({ nextTitle, continuousPlay }: UpNextChipProps) {
  return (
    <span
      className="ml-2 inline-flex max-w-[18rem] items-center gap-1 rounded-full bg-[var(--hover-bg)] px-2 py-0.5 text-[10px] text-[var(--ink-secondary)]"
      data-testid="up-next-chip"
    >
      <span className="shrink-0 opacity-70">Up next:</span>
      <span
        className="truncate text-[var(--ink-primary)]"
        title={nextTitle ?? undefined}
      >
        {nextTitle ?? "next job in this folder"}
      </span>
      <button
        aria-label={
          continuousPlay
            ? "Turn continuous play off"
            : "Turn continuous play on"
        }
        aria-pressed={continuousPlay}
        className={`shrink-0 rounded px-1 font-semibold transition hover:bg-[var(--surface)] ${
          continuousPlay ? "text-[var(--amber)]" : "text-[var(--ink-secondary)]"
        }`}
        onClick={() => setReaderSettings({ continuousPlay: !continuousPlay })}
        title={
          continuousPlay
            ? "Continuous play is on: the next job starts automatically"
            : "Continuous play is off: playback stops at the end of this job"
        }
        type="button"
      >
        auto {continuousPlay ? "on" : "off"}
      </button>
    </span>
  );
}
