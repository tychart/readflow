import { useEffect, useRef, useState } from "react";
import { BrowserRouter, Link, Navigate, NavLink, Route, Routes, useLocation } from "react-router-dom";
import { useShallow } from "zustand/shallow";

import { AdminPage } from "../features/admin/AdminPage";
import { JobsPage } from "../features/jobs/JobsPage";
import { ReaderPage } from "../features/reader/ReaderPage";
import { ThemeToggle } from "../components/ThemeToggle";
import { useAppStore } from "../state/store";
import { useTheme } from "../hooks/useTheme";
import readflowIcon from "../assets/brand/readflow-icon.svg";
import readflowLockupDark from "../assets/brand/readflow-lockup-dark.svg";
import readflowLockupLight from "../assets/brand/readflow-lockup-light.svg";

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

/* ── Navbar scroll shrink ─────────────────────────────────────── */

/** Scroll range (px) over which the expanded jobs-page navbar collapses. Mirrors the reader playbar. */
const NAVBAR_SHRINK_SCROLL_RANGE = 220;
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
  const [scrollProgress, setScrollProgress] = useState(0);

  // Collapse the expanded navbar progressively as the user scrolls, mirroring
  // the reader playbar's scroll-linked shrinking behavior.
  useEffect(() => {
    const handleScroll = () => {
      const y = window.scrollY || 0;
      setScrollProgress(Math.min(1, Math.max(0, y / NAVBAR_SHRINK_SCROLL_RANGE)));
    };
    handleScroll();
    window.addEventListener("scroll", handleScroll, { passive: true });
    return () => window.removeEventListener("scroll", handleScroll);
  }, []);

  useEffect(() => {
    timerRef.current = setInterval(() => forceUpdate((n) => n + 1), 10_000);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, []);

  // The expanded brand (lockup + tagline) only appears at the top of the jobs
  // page; every other route keeps the compact navbar.
  const isJobsPage = location.pathname === "/";
  const progress = isJobsPage ? scrollProgress : 1;
  const navbarHeight = Math.round(
    NAVBAR_EXPANDED_HEIGHT - progress * (NAVBAR_EXPANDED_HEIGHT - NAVBAR_COMPACT_HEIGHT),
  );
  const lockupOpacity = isJobsPage ? 1 - progress : 0;
  const brandRowOpacity = isJobsPage ? progress : 1;
  const lockupVisible = isJobsPage && progress < 1;
  // Only intercept pointer events while the lockup is the dominant element;
  // once it fades below half, clicks should reach the nav/brand beneath.
  const lockupInteractive = lockupOpacity >= 0.5;
  const lockupSrc = theme === "dark" ? readflowLockupDark : readflowLockupLight;

  return (
    <div className="app-shell flex min-h-screen flex-col bg-[var(--canvas)] text-[var(--ink-primary)]">
      {/* Header — expands on the jobs page, shrinks smoothly on scroll */}
      <header
        className="sticky top-0 z-50 bg-[var(--surface)]/80 backdrop-blur-md"
        data-testid="navbar"
        style={{
          height: `${navbarHeight}px`,
          borderBottom: progress > 0.05 ? "1px solid var(--line)" : "1px solid transparent",
        }}
      >
        <div className="relative mx-auto flex h-full max-w-7xl items-center justify-between px-4 md:px-6">
          {/* Expanded brand link — the full lockup overlays the compact brand
              and nav while visible, so it never pushes the layout around. */}
          <Link
            aria-hidden={!lockupVisible}
            aria-label="ReadFlow home"
            className={`absolute left-0 top-1/2 h-12 w-auto -translate-y-1/2 md:h-16 ${
              lockupInteractive ? "" : "pointer-events-none"
            }`}
            style={{ opacity: lockupOpacity }}
            to="/"
          >
            <img
              alt="ReadFlow — Turn your reading into listening"
              className="h-full w-auto"
              draggable={false}
              src={lockupSrc}
            />
          </Link>

          {/* Brand + Nav */}
          <div className="flex items-center gap-6">
            {/* Compact brand — always present; cross-fades under the lockup */}
            <Link
              aria-hidden={lockupVisible}
              aria-label="ReadFlow home"
              className="flex items-center transition hover:opacity-80"
              style={{ opacity: brandRowOpacity }}
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

            {/* Navigation tabs — cross-fade in as the expanded lockup shrinks */}
            <nav
              aria-hidden={lockupVisible}
              className={`flex gap-1 ${lockupVisible ? "pointer-events-none" : ""}`}
              style={{ opacity: brandRowOpacity }}
            >
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
