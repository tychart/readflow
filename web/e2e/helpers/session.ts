import type { Page, Route } from "@playwright/test";

/**
 * Auth fixtures for the e2e suite.
 *
 * The specs mock the API rather than running a backend, so "being signed in" is
 * one route stub: `/api/auth/status` reporting an authenticated user. Every spec
 * calls `mockAuthenticatedSession` in its `beforeEach`, which is what keeps the
 * auth gate from redirecting the page under the test.
 */

export const AUTH_ADMIN = {
  id: "user-admin",
  username: "local",
  display_name: "Local user",
  is_admin: true,
  is_active: true,
  created_at: "2025-11-15T18:04:11Z",
};

export const AUTH_READER = {
  ...AUTH_ADMIN,
  id: "user-reader",
  username: "reader",
  display_name: "Reader",
  is_admin: false,
};

export interface SessionMockOptions {
  user?: typeof AUTH_ADMIN | null;
  needsSetup?: boolean;
  onCreateUser?: (body: Record<string, unknown>) => void;
}

/** Stub the auth endpoints for a signed-in session (or an empty install). */
export async function mockAuthenticatedSession(
  page: Page,
  options: SessionMockOptions = {},
): Promise<void> {
  const user = options.user === undefined ? AUTH_ADMIN : options.user;
  const needsSetup = options.needsSetup ?? false;

  await page.route("**/api/auth/status", async (route) => {
    await route.fulfill({
      json: {
        needs_setup: needsSetup,
        authenticated: user !== null,
        user,
      },
    });
  });
  await page.route("**/api/auth/me", async (route) => {
    await route.fulfill({ json: user ?? {} });
  });
  await page.route("**/api/auth/logout", async (route) => {
    await route.fulfill({ status: 204, body: "" });
  });
  await page.route("**/api/admin/users", async (route) => {
    if (route.request().method() === "POST") {
      options.onCreateUser?.(parseJson(route));
    }
    await route.fulfill({ json: { users: [AUTH_ADMIN] } });
  });
}

/** Stub an anonymous browser (the session is gone). */
export async function mockAnonymousSession(page: Page): Promise<void> {
  await mockAuthenticatedSession(page, { user: null });
}

export function parseJson(route: Route): Record<string, unknown> {
  try {
    return JSON.parse(route.request().postData() ?? "{}") as Record<
      string,
      unknown
    >;
  } catch {
    return {};
  }
}

/** Navigate and wait for the auth gate to settle (splash -> content). */
export async function gotoAuthenticated(
  page: Page,
  path: string,
): Promise<void> {
  await page.goto(path);
  await page
    .getByTestId("auth-splash")
    .waitFor({ state: "detached" })
    .catch(() => undefined);
}
