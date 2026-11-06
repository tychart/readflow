import { Link } from "react-router-dom";

import { api } from "../lib/api";
import {
  playerPause,
  playerRequestGesture,
  playerSeekToSeconds,
  usePlayerStore,
} from "./player-store";

const SKIP_STEP_SECONDS = 10;

/**
 * Compact now-playing bar for every page that is not the reader.
 *
 * The reader's own playbar covers `/jobs/:id`; elsewhere this is the only
 * control surface, which is what makes "browse the library while a book plays"
 * possible without losing the play/pause affordance.
 */
export function MiniPlayer() {
  const job = usePlayerStore((state) => state.job);
  const playIntent = usePlayerStore((state) => state.playIntent);
  const isPlaying = usePlayerStore((state) => state.isActuallyPlaying);
  const isLoading = usePlayerStore((state) => state.isLoadingAudio);
  const isWaitingForData = usePlayerStore((state) => state.isWaitingForData);
  const currentTimeSeconds = usePlayerStore(
    (state) => state.currentTimeSeconds,
  );
  const renderedDurationSeconds = usePlayerStore(
    (state) => state.renderedDurationSeconds,
  );
  const anchorOffsetSeconds = usePlayerStore(
    (state) => state.anchorOffsetSeconds,
  );
  const durationSeconds = usePlayerStore((state) => state.durationSeconds);
  const setPlayIntent = usePlayerStore((state) => state.setPlayIntent);

  if (!job) return null;

  const position = currentTimeSeconds + anchorOffsetSeconds;
  const scale = Math.max(durationSeconds, position, 1);
  const percentage = Math.min(100, Math.max(0, (position / scale) * 100));
  const label = playIntent || isPlaying ? "Pause" : "Play";

  const handleToggle = async () => {
    if (playIntent || isPlaying) {
      setPlayIntent(false);
      playerPause();
      if (!job.isTerminal) {
        void api.pauseJob(job.id).catch(() => undefined);
      }
      return;
    }
    setPlayIntent(true);
    if (!job.isTerminal) {
      try {
        await api.activateJob(job.id);
      } catch {
        setPlayIntent(false);
        return;
      }
    }
    await playerRequestGesture();
  };

  const skip = (delta: number) => {
    const target = Math.max(
      0,
      Math.min(renderedDurationSeconds, currentTimeSeconds + delta),
    );
    playerSeekToSeconds(target);
  };

  return (
    <aside
      aria-label="Now playing"
      className="fixed inset-x-0 bottom-0 z-40 border-t border-[var(--line)] bg-[var(--surface)]/95 px-3 pt-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] shadow-[0_-8px_24px_rgba(0,0,0,0.18)] backdrop-blur"
    >
      <div className="mx-auto flex w-full max-w-7xl items-center gap-2 sm:gap-3">
        <button
          aria-label={label}
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[var(--amber)] text-[var(--canvas)] transition hover:brightness-110 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--amber)]"
          onClick={() => void handleToggle()}
          type="button"
        >
          {isLoading || isWaitingForData ? (
            <span
              aria-hidden="true"
              className="h-4 w-4 animate-spin rounded-full border-2 border-[var(--canvas)] border-t-transparent"
            />
          ) : playIntent || isPlaying ? (
            <svg aria-hidden="true" height="16" viewBox="0 0 16 16" width="16">
              <rect fill="currentColor" height="12" width="4" x="3" y="2" />
              <rect fill="currentColor" height="12" width="4" x="9" y="2" />
            </svg>
          ) : (
            <svg aria-hidden="true" height="16" viewBox="0 0 16 16" width="16">
              <path d="M4 2.5v11l9-5.5-9-5.5Z" fill="currentColor" />
            </svg>
          )}
        </button>

        <button
          aria-label="Back 10 seconds"
          className="hidden h-9 w-9 shrink-0 items-center justify-center rounded-full text-[var(--ink-secondary)] transition hover:bg-[var(--hover-bg)] hover:text-[var(--ink-primary)] sm:flex"
          onClick={() => skip(-SKIP_STEP_SECONDS)}
          type="button"
        >
          −10
        </button>

        <Link
          className="min-w-0 flex-1 rounded-lg px-1 py-1 transition hover:bg-[var(--hover-bg)]"
          to={`/jobs/${job.id}`}
        >
          <div className="truncate text-sm font-medium text-[var(--ink-primary)]">
            {job.title ?? "Untitled job"}
          </div>
          <div
            aria-hidden="true"
            className="mt-1 h-1 w-full overflow-hidden rounded-full bg-[var(--hover-bg)]"
          >
            <div
              className="h-full rounded-full bg-[var(--amber)] transition-[width] duration-500"
              style={{ width: `${percentage}%` }}
            />
          </div>
        </Link>

        <button
          aria-label="Forward 10 seconds"
          className="hidden h-9 w-9 shrink-0 items-center justify-center rounded-full text-[var(--ink-secondary)] transition hover:bg-[var(--hover-bg)] hover:text-[var(--ink-primary)] sm:flex"
          onClick={() => skip(SKIP_STEP_SECONDS)}
          type="button"
        >
          +10
        </button>
      </div>
    </aside>
  );
}
