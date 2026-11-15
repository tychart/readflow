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

/** Apply a status payload from the server (login, setup, refresh). */
export function applyAuthStatus(status: AuthStatus): void {
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
