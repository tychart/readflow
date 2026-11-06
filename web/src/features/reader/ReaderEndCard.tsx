interface ReaderEndCardProps {
  folderName: string | null;
  onReplay: () => void;
  onBackToLibrary: () => void;
}

/** Shown when the last job of a folder finishes (and playback has stopped). */
export function ReaderEndCard({
  folderName,
  onReplay,
  onBackToLibrary,
}: ReaderEndCardProps) {
  return (
    <div
      className="mx-auto mt-4 w-full max-w-3xl rounded-xl border border-[var(--line)] bg-[var(--surface-raised)] px-5 py-4 text-center"
      data-testid="end-of-folder"
      role="status"
    >
      <p className="text-sm font-medium text-[var(--ink-primary)]">
        {folderName ? `End of ${folderName}` : "You reached the end"}
      </p>
      <p className="mt-1 text-xs text-[var(--ink-secondary)]">
        {folderName
          ? "This was the last job in the folder."
          : "Turn on continuous play and put this job in a folder to keep going automatically."}
      </p>
      <div className="mt-3 flex justify-center gap-2">
        <button
          className="rounded-lg bg-[var(--amber)] px-3 py-1.5 text-xs font-medium text-[var(--canvas)] transition hover:brightness-110"
          onClick={onReplay}
          type="button"
        >
          Replay
        </button>
        <button
          className="rounded-lg border border-[var(--line)] px-3 py-1.5 text-xs text-[var(--ink-primary)] transition hover:bg-[var(--hover-bg)]"
          onClick={onBackToLibrary}
          type="button"
        >
          Back to library
        </button>
      </div>
    </div>
  );
}
