/**
 * Shown when playback is starved and no new audio has arrived for a while.
 *
 * The reader previously spun "Buffering…" forever in this situation (the
 * backend could have stopped producing for any number of reasons). This banner
 * makes the stall visible and gives the user a way to re-activate the job
 * without reloading, while staying dismissable so it does not nag.
 */
export function RenderingStallBanner({
  onRetry,
  onDismiss,
  isRetrying = false,
}: {
  onRetry: () => void;
  onDismiss: () => void;
  isRetrying?: boolean;
}) {
  return (
    <div
      className="rounded-lg border border-[var(--amber)]/30 bg-[var(--amber)]/10 px-4 py-3 text-xs text-[var(--amber)]"
      role="status"
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span>Rendering seems stalled — no new audio has arrived recently.</span>
        <div className="ml-auto flex items-center gap-2">
          <button
            className="rounded-md border border-[var(--amber)]/40 bg-[var(--amber)]/10 px-3 py-1 font-semibold transition hover:bg-[var(--amber)]/20 disabled:cursor-not-allowed disabled:opacity-50"
            disabled={isRetrying}
            onClick={onRetry}
            type="button"
          >
            {isRetrying ? "Retrying…" : "Retry"}
          </button>
          <button
            aria-label="Dismiss rendering stall warning"
            className="rounded-md px-2 py-1 font-semibold transition hover:bg-[var(--amber)]/20"
            onClick={onDismiss}
            type="button"
          >
            ×
          </button>
        </div>
      </div>
    </div>
  );
}
