import { NavLink, Route, Routes } from "react-router-dom";
import { BrowserRouter } from "react-router-dom";

import { AdminPage } from "../features/admin/AdminPage";
import { JobsPage } from "../features/jobs/JobsPage";
import { ReaderPage } from "../features/reader/ReaderPage";
import { useAppBootstrap } from "../hooks/useAppBootstrap";

function Shell() {
  useAppBootstrap();

  return (
    <div className="app-shell px-4 py-6 md:px-8">
      <div className="mx-auto max-w-7xl">
        <header className="panel mb-6 flex flex-col gap-4 rounded-[2rem] px-6 py-5 md:flex-row md:items-center md:justify-between">
          <div>
            <div className="text-sm uppercase tracking-[0.4em] text-stone-600">ReadFlow</div>
            <div className="display-font text-3xl">Batched long-form narration</div>
          </div>
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

