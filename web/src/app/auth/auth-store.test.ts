import { beforeEach, describe, expect, it } from "vitest";

import { authStatusFor, signInForTest, TEST_USER } from "../../test-utils/auth";
import {
  applyAuthStatus,
  clearAuth,
  getAuthState,
  resetAuthStore,
  subscribeAuth,
} from "./auth-store";

/**
 * The auth store is the only state the route gate reads, so its transitions are
 * worth pinning: a phase that never leaves `loading` is an infinite splash, and
 * an `anonymous` that keeps the user object leaks a name into the header.
 */

beforeEach(() => {
  resetAuthStore();
});

describe("the auth store", () => {
  it("starts in the loading phase", () => {
    expect(getAuthState()).toEqual({
      phase: "loading",
      user: null,
      needsSetup: false,
    });
  });

  it("becomes authenticated from a status payload", () => {
    applyAuthStatus(authStatusFor(TEST_USER));

    const state = getAuthState();
    expect(state.phase).toBe("authenticated");
    expect(state.user?.username).toBe("local");
    expect(state.needsSetup).toBe(false);
  });

  it("becomes anonymous when the payload has no session", () => {
    applyAuthStatus(authStatusFor(null));

    const state = getAuthState();
    expect(state.phase).toBe("anonymous");
    expect(state.user).toBeNull();
  });

  it("prefers setup over anonymous when the install has no users", () => {
    applyAuthStatus({ needs_setup: true, authenticated: false, user: null });

    expect(getAuthState().phase).toBe("setup");
    expect(getAuthState().needsSetup).toBe(true);
  });

  it("clears the user on logout", () => {
    signInForTest();
    clearAuth();

    expect(getAuthState().phase).toBe("anonymous");
    expect(getAuthState().user).toBeNull();
  });

  it("notifies subscribers on every transition", () => {
    const seen: string[] = [];
    const unsubscribe = subscribeAuth(() => seen.push(getAuthState().phase));

    applyAuthStatus(authStatusFor(TEST_USER));
    clearAuth();
    unsubscribe();
    clearAuth();

    expect(seen).toEqual(["authenticated", "anonymous"]);
  });

  it("does not notify when already anonymous", () => {
    applyAuthStatus(authStatusFor(null));
    let calls = 0;
    const unsubscribe = subscribeAuth(() => {
      calls += 1;
    });

    clearAuth();

    expect(calls).toBe(0);
    unsubscribe();
  });
});

describe("a stale status payload", () => {
  it("cannot sign out a session that just logged in", () => {
    applyAuthStatus(authStatusFor(TEST_USER));

    // The gate's mount-time fetch can resolve after the login request.
    applyAuthStatus(authStatusFor(null));

    expect(getAuthState().phase).toBe("authenticated");
  });

  it("still reports setup when the install is empty", () => {
    applyAuthStatus(authStatusFor(TEST_USER));

    applyAuthStatus({ needs_setup: true, authenticated: false, user: null });

    expect(getAuthState().phase).toBe("setup");
  });
});
