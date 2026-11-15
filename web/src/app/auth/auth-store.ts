/**
 * The auth session, as a tiny external store.
 *
 * Why not zustand: almost nothing changes when auth changes (once per login,
 * logout or 401), and the things that read it are the route gate and the
 * navbar. A `useSyncExternalStore` store keeps that boundary explicit and lets
 * `lib/api.ts` clear the session from outside React.
 */

import type { AuthStatus, AuthUser } from "../../types/auth";

export type AuthPhase = "loading" | "anonymous" | "authenticated" | "setup";

export interface AuthState {
  phase: AuthPhase;
  user: AuthUser | null;
  needsSetup: boolean;
}

const INITIAL: AuthState = { phase: "loading", user: null, needsSetup: false };

let state: AuthState = INITIAL;
const listeners = new Set<() => void>();

function emit(next: AuthState): void {
  state = next;
  for (const listener of listeners) {
    listener();
  }
}

export function getAuthState(): AuthState {
  return state;
}

export function subscribeAuth(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Apply a status payload from the server (login, setup, refresh).
 *
 * An *anonymous* payload never downgrades an authenticated session: the gate
 * fetches `/auth/status` on mount, and a slow response can land after a login
 * and log the user straight back out (that was a real bug — the deep-link flow
 * bounced). Only `clearAuth()` (401, logout, a 1008 socket close) signs a user
 * out, and a genuine "session expired" reload starts from `loading` again.
 */
export function applyAuthStatus(status: AuthStatus): void {
  if (
    !status.authenticated &&
    !status.needs_setup &&
    state.phase === "authenticated"
  ) {
    return;
  }
  if (status.needs_setup) {
    emit({ phase: "setup", user: null, needsSetup: true });
    return;
  }
  if (status.authenticated && status.user) {
    emit({ phase: "authenticated", user: status.user, needsSetup: false });
    return;
  }
  emit({ phase: "anonymous", user: null, needsSetup: false });
}

/**
 * Forget the session locally.
 *
 * Called on logout and on any 401. It must not call the API: a 401 means the
 * cookie is already gone or rejected, and retrying would loop.
 */
export function clearAuth(): void {
  if (state.phase === "anonymous" && state.user === null) {
    return;
  }
  emit({ phase: "anonymous", user: null, needsSetup: false });
}

/** Test hook: back to the pre-fetch state. */
export function resetAuthStore(): void {
  state = INITIAL;
  listeners.clear();
}
