interface JobStepperProps {
  index: number | null;
  count: number | null;
  previousId: string | null;
  nextId: string | null;
  previousTitle: string | null;
  nextTitle: string | null;
  onOpenJob: (jobId: string) => void;
}

/**
 * Folder-relative job jumps, like an audiobook player's chapter stepper.
 *
 * Deliberately a small self-contained strip so its placement can move once the
 * feature has been used; the reader only supplies ids and labels.
 */
export function JobStepper({
  index,
  count,
  previousId,
  nextId,
  previousTitle,
  nextTitle,
  onOpenJob,
}: JobStepperProps) {
  if (!index || !count) return null;
  return (
    <nav
      aria-label="Job navigation"
      className="hidden shrink-0 items-center gap-0.5 rounded-lg border border-[var(--line)] px-1 text-[11px] text-[var(--ink-secondary)] sm:flex"
      data-testid="job-stepper"
    >
      <button
        aria-label={
          previousTitle ? `Previous job: ${previousTitle}` : "Previous job"
        }
        className="flex h-6 w-6 items-center justify-center rounded transition hover:bg-[var(--hover-bg)] hover:text-[var(--ink-primary)] disabled:opacity-30"
        disabled={!previousId}
        onClick={() => previousId && onOpenJob(previousId)}
        title={previousTitle ?? "No previous job"}
        type="button"
      >
        ‹
      </button>
      <span className="whitespace-nowrap tabular-nums">
        Job {index} of {count}
      </span>
      <button
        aria-label={nextTitle ? `Next job: ${nextTitle}` : "Next job"}
        className="flex h-6 w-6 items-center justify-center rounded transition hover:bg-[var(--hover-bg)] hover:text-[var(--ink-primary)] disabled:opacity-30"
        disabled={!nextId}
        onClick={() => nextId && onOpenJob(nextId)}
        title={nextTitle ?? "No next job"}
        type="button"
      >
        ›
      </button>
    </nav>
  );
}
