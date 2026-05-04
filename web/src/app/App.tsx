import { NavLink, Route, Routes } from "react-router-dom";
import { BrowserRouter } from "react-router-dom";

import { AdminPage } from "../features/admin/AdminPage";
import { JobsPage } from "../features/jobs/JobsPage";
import { ReaderPage } from "../features/reader/ReaderPage";
import { useAppStore } from "../state/store";

function formatSocketMessageAge(timestamp: number | null) {
  if (!timestamp) {
    return "no live events yet";
  }
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  return seconds === 0 ? "just now" : `${seconds}s ago`;
}

function ConnectionBadge() {
  const websocketStatus = useAppStore((state) => state.websocketStatus);
  const lastSocketMessageAt = useAppStore((state) => state.lastSocketMessageAt);
  const lastSocketError = useAppStore((state) => state.lastSocketError);
  const reconnectAttempt = useAppStore((state) => state.reconnectAttempt);
  const isSocketStale = useAppStore((state) => state.isSocketStale);

  const tone =
    websocketStatus === "open" && !isSocketStale
      ? "bg-emerald-100 text-emerald-800"
      : websocketStatus === "connecting" || websocketStatus === "reconnecting"
        ? "bg-amber-100 text-amber-900"
        : websocketStatus === "closed" && !lastSocketError
          ? "bg-stone-200 text-stone-700"
          : "bg-rose-100 text-rose-800";
  const label = websocketStatus === "closed" && !lastSocketError
    ? "idle"
    : isSocketStale
    ? "stale"
    : websocketStatus === "reconnecting"
      ? `reconnecting${reconnectAttempt ? ` #${reconnectAttempt}` : ""}`
      : websocketStatus;

  return (
    <div
      aria-live="polite"
      className={`rounded-3xl px-4 py-3 text-right text-sm ${tone}`}
      title={lastSocketError ?? "Live connection diagnostics"}
    >
      <div className="font-semibold uppercase tracking-[0.2em]">Live {label}</div>
      <div className="text-xs opacity-80">Last message: {formatSocketMessageAge(lastSocketMessageAt)}</div>
      {lastSocketError ? <div className="mt-1 max-w-64 text-xs">{lastSocketError}</div> : null}
    </div>
  );
}

function Shell() {
  return (
    <div className="app-shell px-4 py-6 md:px-8">
      <div className="mx-auto max-w-7xl">
        <header className="panel mb-6 flex flex-col gap-4 rounded-[2rem] px-6 py-5 md:flex-row md:items-center md:justify-between">
          <div>
            <div className="text-sm uppercase tracking-[0.4em] text-stone-600">ReadFlow</div>
            <div className="display-font text-3xl">Batched long-form narration</div>
          </div>
          <div className="flex flex-col gap-3 md:items-end">
            <ConnectionBadge />
            <nav className="flex gap-3">
              {[
                ["/", "Jobs"],
                ["/admin", "Admin"],
              ].map(([to, label]) => (
                <NavLink
                  className={({ isActive }) =>
                    `rounded-full px-4 py-2 text-sm font-semibold ${
                      isActive ? "bg-[var(--accent)] text-white" : "bg-white/70 text-stone-700"
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
        </header>

        <Routes>
          <Route element={<JobsPage />} path="/" />
          <Route element={<ReaderPage />} path="/jobs/:jobId" />
          <Route element={<AdminPage />} path="/admin" />
        </Routes>
      </div>
    </div>
  );
}

export function App() {
  return (
    <BrowserRouter>
      <Shell />
    </BrowserRouter>
  );
}
