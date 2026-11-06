interface ReaderEndCardProps {
  folderName: string | null;
  nextJobTitle: string | null;
  continuousPlay: boolean;
  onReplay: () => void;
  onPlayNext: () => void;
  onBackToLibrary: () => void;
}

const PRIMARY_BUTTON =
  "rounded-lg bg-[var(--amber)] px-3 py-1.5 text-xs font-medium text-[var(--canvas)] transition hover:brightness-110";
const SECONDARY_BUTTON =
  "rounded-lg border border-[var(--line)] px-3 py-1.5 text-xs text-[var(--ink-primary)] transition hover:bg-[var(--hover-bg)]";

function describeEnd(
  folderName: string | null,
  nextJobTitle: string | null,
  continuousPlay: boolean,
): { title: string; description: string } {
  if (nextJobTitle !== null) {
    return {
      title: `Up next: ${nextJobTitle}`,
      description: continuousPlay
        ? "Continuous play is on, so it opens automatically."
        : "Continuous play is off: open the next job when you are ready.",
    };
  }
  if (folderName !== null) {
    return {
      title: `End of ${folderName}`,
      description: "This was the last job in the folder.",
    };
  }
  return {
    title: "You reached the end",
    description:
      "This job is not in a folder, so there is nothing to play next.",
  };
}

/**
 * Shown when playback reaches the end of a job (and has stopped).
 *
 * It has to know whether a next job exists: a folder's first job ending is not
 * "the last job in the folder". With continuous play on this card is only
 * visible for the moment before the next job opens, but the manual path
 * (continuous play off, or auto-advance failed) is where it matters.
 */
export function ReaderEndCard({
  folderName,
  nextJobTitle,
  continuousPlay,
  onReplay,
  onPlayNext,
  onBackToLibrary,
}: ReaderEndCardProps) {
  const hasNextJob = nextJobTitle !== null;
  const { title, description } = describeEnd(
    folderName,
    nextJobTitle,
    continuousPlay,
  );
  return (
    <div
      className="mx-auto mt-4 w-full max-w-3xl rounded-xl border border-[var(--line)] bg-[var(--surface-raised)] px-5 py-4 text-center"
      data-testid="end-of-folder"
      role="status"
    >
      <p className="text-sm font-medium text-[var(--ink-primary)]">{title}</p>
      <p className="mt-1 text-xs text-[var(--ink-secondary)]">{description}</p>
      <div className="mt-3 flex justify-center gap-2">
        {hasNextJob ? (
          <button className={PRIMARY_BUTTON} onClick={onPlayNext} type="button">
            Play next
          </button>
        ) : null}
        <button
          className={hasNextJob ? SECONDARY_BUTTON : PRIMARY_BUTTON}
          onClick={onReplay}
          type="button"
        >
          Replay
        </button>
        <button
          className={SECONDARY_BUTTON}
          onClick={onBackToLibrary}
          type="button"
        >
          Back to library
        </button>
      </div>
    </div>
  );
}
