import { useEffect, useRef, useState } from "react";
import { BrowserRouter, Link, Navigate, NavLink, Route, Routes, useLocation } from "react-router-dom";
import { useShallow } from "zustand/shallow";

import { AdminPage } from "../features/admin/AdminPage";
import { JobsPage } from "../features/jobs/JobsPage";
import { ReaderPage } from "../features/reader/ReaderPage";
import { ThemeToggle } from "../components/ThemeToggle";
import { useAppStore } from "../state/store";
import { useTheme } from "../hooks/useTheme";
import { useScrollProgressVar } from "../hooks/useScrollProgress";
import type { WebSocketStatus } from "../types/events";
import readflowIcon from "../assets/brand/readflow-icon.svg";
import readflowLockupDark from "../assets/brand/readflow-lockup-dark.svg";
import readflowLockupLight from "../assets/brand/readflow-lockup-light.svg";

/* ── Connection Badge ─────────────────────────────────────── */

interface ConnectionBadgeState {
  websocketStatus: WebSocketStatus;
  lastSocketMessageAt: number | null;
  lastSocketError: string | null;
  reconnectAttempt: number;
  isSocketStale: boolean;
}

function formatSocketMessageAge(timestamp: number | null): string {
  if (!timestamp) return "no live events yet";
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  return seconds === 0 ? "just now" : `${seconds}s ago`;
}

function ConnectionBadge() {
  const {
    websocketStatus,
    lastSocketMessageAt,
    lastSocketError,
    reconnectAttempt,
    isSocketStale,
  } = useAppStore(
    useShallow(
      (state): ConnectionBadgeState => ({
        websocketStatus: state.websocketStatus,
        lastSocketMessageAt: state.lastSocketMessageAt,
        lastSocketError: state.lastSocketError,
        reconnectAttempt: state.reconnectAttempt,
        isSocketStale: state.isSocketStale,
      }),
    ),
  );

  // Derive visual state
  const isHealthy = websocketStatus === "open" && !isSocketStale;
  const isConnecting = websocketStatus === "connecting" || websocketStatus === "reconnecting";
  const isError = websocketStatus === "error";

  const label = isSocketStale
    ? "stale"
    : websocketStatus === "reconnecting"
      ? `reconnecting${reconnectAttempt ? ` #${reconnectAttempt}` : ""}`
      : websocketStatus;

  return (
    <div
      aria-label={`Connection: ${label}. Last message ${formatSocketMessageAge(lastSocketMessageAt)}`}
      aria-live="polite"
      className={`flex items-center gap-2 rounded-lg border px-3 py-1.5 text-xs ${
        isHealthy
          ? "border-emerald-900/30 bg-emerald-950/30 text-emerald-400"
          : isConnecting
            ? "border-amber-900/30 bg-amber-950/30 text-amber-400"
            : isError
              ? "border-rose-900/30 bg-rose-950/30 text-rose-400"
              : "border-[var(--line)] bg-[var(--hover-bg)] text-[var(--ink-secondary)]"
      }`}
      title={lastSocketError ?? "WebSocket connection status"}
    >
      {/* Status dot */}
      <span
        aria-hidden="true"
        className={`inline-block h-1.5 w-1.5 rounded-full ${
          isHealthy
            ? "bg-[var(--emerald)]"
            : isConnecting
              ? "bg-[var(--amber)]"
              : isError
                ? "bg-[var(--rose)]"
                : "bg-[var(--ink-secondary)]"
        } ${isConnecting ? "animate-pulse" : ""}`}
      />
      <span className="hidden font-medium uppercase tracking-wider sm:inline">{label}</span>
      <span className="hidden opacity-60 sm:inline">{formatSocketMessageAge(lastSocketMessageAt)}</span>
    </div>
  );
}

/* ── Navbar scroll shrink ─────────────────────────────────────── */

/** Expanded (top of jobs page) and compact (scrolled / other pages) navbar heights in px. */
const NAVBAR_EXPANDED_HEIGHT = 96;
const NAVBAR_COMPACT_HEIGHT = 56;

/* ── Shell ────────────────────────────────────────────────── */

function Shell() {
  const location = useLocation();
  const { theme } = useTheme();
  // Periodically re-render to update the "seconds ago" display
  const [, forceUpdate] = useState(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // The expanded brand (lockup + tagline) only appears at the top of the jobs
  // page; every other route keeps the compact navbar.
  const isJobsPage = location.pathname === "/";

  // Collapse the navbar as the user scrolls by writing progress into a CSS
  // custom property instead of component state: a scroll-rate re-render of the
  // whole shell (and the page inside it) is pure waste. Routes other than the
  // jobs page pin the value at 1, i.e. fully compact.
  const attachNavbarProgress = useScrollProgressVar<HTMLElement>({
    variable: "--navbar-progress",
    forced: isJobsPage ? undefined : 1,
  });

  useEffect(() => {
    timerRef.current = setInterval(() => forceUpdate((n) => n + 1), 10_000);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, []);

  const lockupSrc = theme === "dark" ? readflowLockupDark : readflowLockupLight;

  return (
    <div className="app-shell flex min-h-screen flex-col bg-[var(--canvas)] text-[var(--ink-primary)]">
      {/* Header — expands on the jobs page, shrinks smoothly on scroll */}
      <header
        className="sticky top-0 z-50 bg-[var(--surface)]/80 backdrop-blur-md"
        data-testid="navbar"
        ref={attachNavbarProgress}
        style={{
          height: `calc(${NAVBAR_EXPANDED_HEIGHT}px - var(--navbar-progress, 1) * ${
            NAVBAR_EXPANDED_HEIGHT - NAVBAR_COMPACT_HEIGHT
          }px)`,
        }}
      >
        {/* Hairline border — fades in with the collapse instead of being toggled
            on a threshold (a toggle repainted the header mid-scroll). */}
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 bottom-0 h-px bg-[var(--line)]"
          style={{ opacity: "var(--navbar-progress, 1)" }}
        />
        <div className="relative mx-auto flex h-full max-w-7xl items-center justify-between px-4 md:px-6">
          {/* Expanded brand lockup — a decorative overlay behind the compact
              brand link (which is the real, always-present home link), so it
              never pushes layout around and needs no interactivity of its own.
              Hidden on small screens where it would crowd the nav. */}
          <span
            aria-hidden="true"
            className="pointer-events-none absolute left-0 top-1/2 hidden h-12 w-auto -translate-y-1/2 md:block md:h-16"
            data-testid="navbar-lockup"
            style={{ opacity: "calc(1 - var(--navbar-progress, 1))" }}
          >
            <img
              alt=""
              className="h-full w-auto"
              draggable={false}
              src={lockupSrc}
            />
          </span>

          {/* Compact brand — always present; cross-fades under the lockup */}
          <Link
            aria-label="ReadFlow home"
            className="flex items-center transition hover:opacity-80"
            style={{ opacity: "var(--navbar-progress, 1)" }}
            to="/"
          >
            <img
              alt=""
              className="h-7 w-7"
              draggable={false}
              src={readflowIcon}
            />
            <span className="text-sm font-semibold tracking-wide text-[var(--ink-primary)]">
              ReadFlow
            </span>
          </Link>

          {/* Right: nav tabs + connection badge + theme toggle */}
          <div className="flex items-center gap-3">
            <nav className="flex gap-1">
              {[
                ["/", "Jobs"],
                ["/admin", "Admin"],
              ].map(([to, label]) => (
                <NavLink
                  className={({ isActive }) =>
                    `rounded-lg px-3 py-1.5 text-sm font-medium transition ${
                      isActive
                        ? "bg-[var(--amber-soft)] text-[var(--amber)]"
                        : "text-[var(--ink-secondary)] hover:text-[var(--ink-primary)] hover:bg-[var(--hover-bg)]"
                    }`
                  }
                  end={to === "/"}
                  key={to}
                  to={to}
                >
                  {label}
                </NavLink>
              ))}
            </nav>
            <ConnectionBadge />
            <ThemeToggle />
          </div>
        </div>
      </header>

      {/* Main content — each page owns its own layout container */}
      <main className="flex-1">
        <Routes>
          <Route element={<JobsPage />} path="/" />
          <Route element={<ReaderPage />} path="/jobs/:jobId" />
          <Route element={<AdminPage />} path="/admin" />
          {/* Unknown URLs redirect to the jobs page (replace keeps history clean) */}
          <Route element={<Navigate replace to="/" />} path="*" />
        </Routes>
      </main>
    </div>
  );
}

/* ── App ──────────────────────────────────────────────────── */

export function App() {
  return (
    <BrowserRouter>
      <Shell />
    </BrowserRouter>
  );
}
