interface ReaderFollowButtonProps {
  enabled: boolean;
  onToggle: () => void;
  /** Raises the control clear of the phone reader dock. */
  className?: string;
}

/** Persistent reader control for the optional smart-follow mode. */
export function ReaderFollowButton({
  enabled,
  onToggle,
  className = "",
}: ReaderFollowButtonProps) {
  const label = enabled ? "Pause smart follow" : "Resume smart follow";

  return (
    <button
      aria-label={label}
      aria-pressed={enabled}
      className={`fixed right-4 z-40 flex h-11 items-center justify-center gap-2 rounded-full border px-3 shadow-lg transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--amber)] sm:right-6 ${
        enabled
          ? "border-[var(--amber)]/50 bg-[var(--amber)] text-white hover:bg-[var(--amber)]/90"
          : "border-[var(--line)] bg-[var(--surface-raised)]/90 text-[var(--ink-secondary)] opacity-65 hover:opacity-100"
      } ${className}`}
      onClick={onToggle}
      title={
        enabled
          ? "Following the current reading position"
          : "Follow the current reading position"
      }
      type="button"
    >
      <svg
        aria-hidden="true"
        className="h-5 w-5"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="2"
        viewBox="0 0 24 24"
      >
        <circle cx="12" cy="12" r="7" />
        <circle cx="12" cy="12" fill="currentColor" r="1.5" />
        <path d="M12 2v3M12 19v3M2 12h3M19 12h3" />
      </svg>
      <span className="hidden text-xs font-semibold sm:inline">
        {enabled ? "Following" : "Follow"}
      </span>
    </button>
  );
}
