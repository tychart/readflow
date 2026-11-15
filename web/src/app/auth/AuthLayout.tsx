import type { ReactNode } from "react";

import readflowIcon from "../../assets/brand/readflow-icon.svg";

/**
 * The shared frame for the two unauthenticated screens.
 *
 * It deliberately does not show the app navbar: there is nowhere to navigate to
 * yet, and the connection badge would be a lie (the live socket needs a session).
 */
export function AuthLayout({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle: string;
  children: ReactNode;
}) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-[var(--canvas)] px-4 py-10 text-[var(--ink-primary)]">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex items-center gap-3">
          <img
            alt=""
            className="h-9 w-9"
            draggable={false}
            src={readflowIcon}
          />
          <span className="text-lg font-semibold tracking-wide">ReadFlow</span>
        </div>
        <h1 className="text-xl font-semibold">{title}</h1>
        <p className="mt-1 text-sm text-[var(--ink-secondary)]">{subtitle}</p>
        <div className="mt-6">{children}</div>
      </div>
    </div>
  );
}

/** Shared field + error styling for the auth forms. */
export const AUTH_INPUT_CLASS =
  "w-full rounded-lg border border-[var(--line)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--ink-primary)] outline-none focus:border-[var(--amber)]";

export const AUTH_LABEL_CLASS =
  "mb-1 block text-xs font-medium uppercase tracking-wider text-[var(--ink-secondary)]";

export const AUTH_BUTTON_CLASS =
  "w-full rounded-lg bg-[var(--amber)] px-3 py-2 text-sm font-semibold text-[#1a1206] transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-60";
