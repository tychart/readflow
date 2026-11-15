import {
  applyAuthStatus,
  clearAuth,
  resetAuthStore,
} from "../app/auth/auth-store";
import type { AuthStatus, AuthUser } from "../types/auth";

/** A signed-in administrator, for tests that just need "somebody". */
export const TEST_USER: AuthUser = {
  id: "user-1",
  username: "local",
  display_name: "Local user",
  is_admin: true,
  is_active: true,
  created_at: "2025-11-15T18:04:11Z",
};

/** A signed-in listener (no admin rights). */
export const TEST_READER: AuthUser = {
  ...TEST_USER,
  id: "user-2",
  username: "reader",
  display_name: "Reader",
  is_admin: false,
};

export function authStatusFor(user: AuthUser | null): AuthStatus {
  return {
    needs_setup: false,
    authenticated: user !== null,
    user,
  };
}

/** Put the store in its pre-fetch state (call in `beforeEach`). */
export function resetAuthForTest(): void {
  resetAuthStore();
}

/** Mark the session as signed in without going through the network. */
export function signInForTest(user: AuthUser = TEST_USER): void {
  applyAuthStatus(authStatusFor(user));
}

export function signOutForTest(): void {
  clearAuth();
}
