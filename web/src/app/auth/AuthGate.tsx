import { type ReactNode, useEffect } from "react";
import { Navigate, useLocation } from "react-router-dom";

import { useAuth } from "../../hooks/useAuth";
import { api } from "../../lib/api";
import { applyAuthStatus } from "./auth-store";

/**
 * The route gate.
 *
 * It renders nothing but a splash until `GET /api/auth/status` resolves, then
 * either the app or a redirect. The redirect carries `next` so a deep link
 * (a bookmarked job, a shared folder) still lands where it was going after
 * login.
 *
 * `needs_setup` wins over everything: an install with no accounts cannot log
 * anyone in, so it must show setup even for an anonymous request.
 */
export function AuthGate({ children }: { children: ReactNode }) {
  const auth = useAuth();
  const location = useLocation();

  // Fetch the status once, on mount. It is the only place that decides the
  // phase; login/setup/logout update the store directly.
  useEffect(() => {
    let cancelled = false;
    void api
      .authStatus()
      .then((status) => {
        if (!cancelled) {
          applyAuthStatus(status);
        }
      })
      .catch(() => {
        // An unreachable API is not "logged out"; leaving the phase at loading
        // would spin forever, so show the login form, which will surface the
        // real error when it is used.
        if (!cancelled) {
          applyAuthStatus({
            needs_setup: false,
            authenticated: false,
            user: null,
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (auth.phase === "loading") {
    return (
      <div
        aria-live="polite"
        className="flex min-h-screen items-center justify-center bg-[var(--canvas)]"
        data-testid="auth-splash"
      >
        <span className="inline-block h-5 w-5 animate-spin rounded-full border-2 border-[var(--amber)] border-t-transparent" />
        <span className="sr-only">Loading…</span>
      </div>
    );
  }

  if (auth.phase === "setup") {
    return <Navigate replace to="/setup" />;
  }

  if (auth.phase !== "authenticated") {
    const next = `${location.pathname}${location.search}`;
    const target =
      next === "/" ? "/login" : `/login?next=${encodeURIComponent(next)}`;
    return <Navigate replace to={target} />;
  }

  return <>{children}</>;
}
