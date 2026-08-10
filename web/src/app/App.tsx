import { useEffect, useRef, useState } from "react";
import { BrowserRouter, Link, Navigate, NavLink, Route, Routes } from "react-router-dom";
import { useShallow } from "zustand/shallow";

import { AdminPage } from "../features/admin/AdminPage";
import { JobsPage } from "../features/jobs/JobsPage";
import { ReaderPage } from "../features/reader/ReaderPage";
import { ThemeToggle } from "../components/ThemeToggle";
import { useAppStore } from "../state/store";
import readflowIcon from "../assets/brand/readflow-icon.svg";

/* ── Connection Badge ─────────────────────────────────────── */

interface ConnectionBadgeState {
  websocketStatus: string;
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
  const isError = websocketStatus === "closed" && !!lastSocketError;

  const label =
    websocketStatus === "closed" && !lastSocketError
      ? "idle"
      : isSocketStale
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
      <span className="font-medium uppercase tracking-wider">{label}</span>
      <span className="opacity-60">{formatSocketMessageAge(lastSocketMessageAt)}</span>
    </div>
  );
}

/* ── Shell ────────────────────────────────────────────────── */

function Shell() {
  // Periodically re-render to update the "seconds ago" display
  const [, forceUpdate] = useState(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    timerRef.current = setInterval(() => forceUpdate((n) => n + 1), 10_000);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, []);

  return (
    <div className="app-shell flex min-h-screen flex-col bg-[var(--canvas)] text-[var(--ink-primary)]">
      {/* Header */}
      <header className="sticky top-0 z-50 border-b border-[var(--line)] bg-[var(--surface)]/80 backdrop-blur-md">
        <div className="mx-auto flex h-14 max-w-7xl items-center justify-between px-4 md:px-6">
          {/* Brand + Nav */}
          <div className="flex items-center gap-6">
            {/* Brand — click to return to the jobs page */}
            <Link
              aria-label="ReadFlow home"
              className="flex items-center gap-2 transition hover:opacity-80"
              to="/"
            >
              {/* Brand icon — decorative mark; the link label carries the accessible name */}
              <img
                alt=""
                aria-hidden="true"
                className="h-7 w-7"
                draggable={false}
                src={readflowIcon}
              />
              <span className="text-sm font-semibold tracking-wide text-[var(--ink-primary)]">
                ReadFlow
              </span>
            </Link>

            {/* Navigation tabs */}
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
          </div>

          {/* Right: Connection badge + Theme toggle */}
          <div className="flex items-center gap-3">
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
