import { useSyncExternalStore } from "react";

import {
  type AuthState,
  getAuthState,
  subscribeAuth,
} from "../app/auth/auth-store";

/** Subscribe to the auth session. Re-renders only on login/logout/401. */
export function useAuth(): AuthState {
  return useSyncExternalStore(subscribeAuth, getAuthState, getAuthState);
}

/** Convenience: the signed-in user, or null. */
export function useCurrentUser() {
  return useAuth().user;
}
