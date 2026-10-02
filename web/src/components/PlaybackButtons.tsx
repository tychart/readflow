import type { CSSProperties } from "react";

/**
 * Transport controls shared by the main playbar and (on phones) the reader's
 * bottom dock, so both surfaces stay pixel-identical and only need one set of
 * shortcut wiring.
 */

/* ── Play / pause ─────────────────────────────────────────── */

export interface PlayButtonProps {
  /** Accessible name, e.g. "Play", "Pause", "Resume". */
  label: string;
  /** Tooltip text, including the keyboard shortcut. */
  title: string;
  sizePx: number;
  iconSizePx: number;
  showSpinner: boolean;
  showPauseIcon: boolean;
  onClick: () => void;
}

export function PlayButton({
  label,
  title,
  sizePx,
  iconSizePx,
  showSpinner,
  showPauseIcon,
  onClick,
}: PlayButtonProps) {
  const style: CSSProperties = { width: sizePx, height: sizePx };
  const iconStyle: CSSProperties = { width: iconSizePx, height: iconSizePx };

  return (
    <button
      aria-label={label}
      className="flex shrink-0 items-center justify-center rounded-full bg-[var(--amber)] text-white shadow-lg shadow-[var(--amber-soft)] transition hover:brightness-110 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--amber)]"
      onClick={onClick}
      style={style}
      title={title}
      type="button"
    >
      {showSpinner ? (
        <span
          aria-hidden="true"
          className="inline-block animate-spin rounded-full border-2 border-white border-t-transparent"
          style={iconStyle}
        />
      ) : showPauseIcon ? (
        /* Pause icon */
        <svg aria-hidden="true" fill="currentColor" style={iconStyle} viewBox="0 0 16 16">
          <rect height="14" rx="1" width="5" x="2.5" y="1" />
          <rect height="14" rx="1" width="5" x="8.5" y="1" />
        </svg>
      ) : (
        /* Play icon */
        <svg aria-hidden="true" className="ml-0.5" fill="currentColor" style={iconStyle} viewBox="0 0 16 16">
          <path d="M3 1.5v13l11-6.5L3 1.5z" />
        </svg>
      )}
    </button>
  );
}

/* ── Skip ±N seconds ──────────────────────────────────────── */

export interface SkipButtonProps {
  direction: "back" | "forward";
  seconds: number;
  /** Shortcut hint shown in the tooltip, e.g. "←" or "→". */
  shortcut: string;
  sizePx: number;
  iconSizePx: number;
  onClick: () => void;
}

/**
 * Seek ±N seconds. Doubled chevrons plus the step count, which is the shape
 * every podcast/audiobook player uses and stays legible at 28px.
 */
export function SkipButton({
  direction,
  seconds,
  shortcut,
  sizePx,
  iconSizePx,
  onClick,
}: SkipButtonProps) {
  const label = `${direction === "back" ? "Back" : "Forward"} ${seconds} seconds`;

  return (
    <button
      aria-label={label}
      className="flex shrink-0 items-center justify-center gap-0.5 rounded-full text-[var(--ink-secondary)] transition-colors hover:bg-[var(--hover-bg)] hover:text-[var(--ink-primary)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--amber)]"
      onClick={onClick}
      style={{ width: sizePx, height: sizePx }}
      title={`${label} (${shortcut})`}
      type="button"
    >
      <svg
        aria-hidden="true"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.6"
        style={{ width: iconSizePx, height: iconSizePx }}
        viewBox="0 0 12 12"
      >
        {direction === "back" ? (
          <>
            <polyline points="7 2.5 3.5 6 7 9.5" />
            <polyline points="10.5 2.5 7 6 10.5 9.5" />
          </>
        ) : (
          <>
            <polyline points="5 2.5 8.5 6 5 9.5" />
            <polyline points="1.5 2.5 5 6 1.5 9.5" />
          </>
        )}
      </svg>
      <span
        aria-hidden="true"
        className="font-bold tabular-nums"
        style={{ fontSize: Math.max(8, Math.round(iconSizePx * 0.6)) }}
      >
        {seconds}
      </span>
    </button>
  );
}
