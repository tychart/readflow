/**
 * "Render rest now" — let this job ignore the scheduler's lookahead cap.
 *
 * The scheduler renders every job to the end by default (`render_ahead_seconds`
 * = 0), so this is the manual escape hatch for an installation that opted into
 * a cap, or for a job that was capped before the policy changed. It is
 * deliberately not a resume button: pausing a job must stay an intentional stop.
 */
export function RenderToEndButton({
  enabled,
  isPending = false,
  isTerminal,
  onRenderToEnd,
}: {
  /** True once the job already opted out of the cap (`job.render_to_end`). */
  enabled: boolean;
  isPending?: boolean;
  isTerminal: boolean;
  onRenderToEnd: () => void;
}) {
  if (isTerminal) return null;
  const label = enabled ? "Rendering rest" : "Render rest";
  return (
    <button
      aria-label={
        enabled
          ? "This job already renders to the end regardless of the lookahead cap"
          : "Render the rest of this job now, ignoring the lookahead cap"
      }
      className={`flex h-8 items-center gap-1.5 rounded-lg border px-2 text-[11px] font-semibold transition ${
        enabled
          ? "cursor-default border-[var(--line)] text-[var(--amber)]"
          : "border-[var(--line)] text-[var(--ink-secondary)] hover:border-[var(--amber)] hover:text-[var(--amber)] disabled:cursor-not-allowed disabled:opacity-50"
      }`}
      disabled={enabled || isPending}
      onClick={onRenderToEnd}
      title={
        enabled
          ? "This job renders to the end even if a lookahead cap is configured"
          : "Ignore the lookahead cap and render the rest of this job"
      }
      type="button"
    >
      {/* Fast-forward icon: two chevrons = "keep going to the end". */}
      <svg
        aria-hidden="true"
        className="h-3 w-3"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="2"
        viewBox="0 0 24 24"
      >
        <polyline points="5 5 12 12 5 19" />
        <polyline points="13 5 20 12 13 19" />
      </svg>
      <span className="hidden sm:inline">{isPending ? "Starting…" : label}</span>
    </button>
  );
}
