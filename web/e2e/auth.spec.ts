import { expect, test } from "@playwright/test";

import {
  AUTH_ADMIN,
  AUTH_READER,
  mockAnonymousSession,
  mockAuthenticatedSession,
} from "./helpers/session";

/**
 * The auth surface, end to end.
 *
 * These specs mock the API (like the rest of the suite), so they verify the
 * client's behaviour rather than the server's: the guard, the deep-link return,
 * the shape of the login form, generic errors, logout, and admin gating. The
 * server-side rules (hashing, throttling, revocation) are covered by the pytest
 * suites.
 */

test("an anonymous visit is redirected to the login page", async ({ page }) => {
  await mockAnonymousSession(page);

  await page.goto("/");

  await expect(page).toHaveURL(/\/login$/);
  await expect(
    page.getByRole("heading", { name: "Welcome back" }),
  ).toBeVisible();
});

test("a deep link returns to the requested page after login", async ({
  page,
}) => {
  await mockAnonymousSession(page);
  await page.route("**/api/auth/login", async (route) => {
    await route.fulfill({
      json: { needs_setup: false, authenticated: true, user: AUTH_ADMIN },
    });
  });
  await page.route("**/api/library", async (route) => {
    await route.fulfill({ json: { folders: [], jobs: [], trash_count: 0 } });
  });
  await page.route("**/api/status", async (route) => {
    await route.fulfill({
      json: {
        resident_model_id: null,
        resident_voice_id: null,
        model_state: "unloaded",
        model_residency_batches: 10,
        voice_residency_batches: 3,
      },
    });
  });
  await page.route("**/api/voices", async (route) => {
    await route.fulfill({ json: [] });
  });
  await page.route("**/api/preferences", async (route) => {
    await route.fulfill({ json: { model_id: null, voice_id: null } });
  });

  await page.goto("/trash");
  await expect(page).toHaveURL(/\/login\?next=%2Ftrash$/);

  await page.getByLabel("Username").fill("local");
  await page.getByLabel("Password").fill("readflow-local-dev");
  await page.getByRole("button", { name: "Sign in" }).click();

  await expect(page).toHaveURL(/\/trash$/);
});

test("a wrong password shows the server's generic message", async ({
  page,
}) => {
  await mockAnonymousSession(page);
  await page.route("**/api/auth/login", async (route) => {
    await route.fulfill({
      status: 401,
      json: { detail: "Invalid username or password" },
    });
  });

  await page.goto("/login");
  await page.getByLabel("Username").fill("local");
  await page.getByLabel("Password").fill("wrong password");
  await page.getByRole("button", { name: "Sign in" }).click();

  await expect(page.getByRole("alert")).toHaveText(
    "Invalid username or password",
  );
  // Still on the login page: no bounce through the global 401 handler.
  await expect(page).toHaveURL(/\/login$/);
});

test("a first-run install lands on the setup page", async ({ page }) => {
  await mockAuthenticatedSession(page, { user: null, needsSetup: true });
  await page.route("**/api/auth/setup", async (route) => {
    await route.fulfill({
      json: { needs_setup: false, authenticated: true, user: AUTH_ADMIN },
    });
  });
  await page.route("**/api/library", async (route) => {
    await route.fulfill({ json: { folders: [], jobs: [], trash_count: 0 } });
  });

  await page.goto("/");

  await expect(page).toHaveURL(/\/setup$/);
  await expect(
    page.getByRole("heading", { name: "Set up ReadFlow" }),
  ).toBeVisible();

  await page.getByLabel("Username").fill("admin");
  await page.getByLabel("Password", { exact: true }).fill("a long password 1");
  await page.getByLabel("Confirm password").fill("a long password 1");
  await page.getByRole("button", { name: "Create administrator" }).click();

  await expect(page).toHaveURL(/\/$/);
});

test("the setup form refuses mismatched passwords", async ({ page }) => {
  await mockAuthenticatedSession(page, { user: null, needsSetup: true });

  await page.goto("/setup");
  await page.getByLabel("Username").fill("admin");
  await page.getByLabel("Password", { exact: true }).fill("a long password 1");
  await page.getByLabel("Confirm password").fill("a different password");
  await page.getByRole("button", { name: "Create administrator" }).click();

  await expect(page.getByRole("alert")).toHaveText(
    "The two passwords do not match",
  );
});

test("logging out returns to the login page", async ({ page }) => {
  await mockAuthenticatedSession(page);
  await page.route("**/api/library", async (route) => {
    await route.fulfill({ json: { folders: [], jobs: [], trash_count: 0 } });
  });

  await page.goto("/");

  await page.getByTestId("user-menu-trigger").click();
  await page.getByRole("menuitem", { name: "Log out" }).click();

  await expect(page).toHaveURL(/\/login$/);
});

test("a listener does not see the Admin tab and is redirected from /admin", async ({
  page,
}) => {
  await mockAuthenticatedSession(page, { user: AUTH_READER });
  await page.route("**/api/library", async (route) => {
    await route.fulfill({ json: { folders: [], jobs: [], trash_count: 0 } });
  });

  await page.goto("/");

  await expect(page.getByRole("link", { name: "Admin" })).toHaveCount(0);

  await page.goto("/admin");
  await expect(page).toHaveURL(/\/$/);
});

test("an admin can create an account from the Users tab", async ({ page }) => {
  const created: Record<string, unknown>[] = [];
  await mockAuthenticatedSession(page, {
    onCreateUser: (body) => created.push(body),
  });
  await page.route("**/api/library", async (route) => {
    await route.fulfill({ json: { folders: [], jobs: [], trash_count: 0 } });
  });
  await page.route("**/api/jobs", async (route) => {
    await route.fulfill({ json: [] });
  });
  await page.route("**/api/voices", async (route) => {
    await route.fulfill({ json: [] });
  });
  await page.route("**/api/admin/state", async (route) => {
    await route.fulfill({
      json: {
        config: {
          device: "auto",
          idle_unload_seconds: 300,
          max_prebuffer_seconds: 300,
          target_buffer_seconds: 60,
          up_next_prebuffer_seconds: 120,
          render_ahead_seconds: 0,
          active_listener_timeout_seconds: 60,
          plan_ahead_chunks: 16,
          batch_candidates_small_model: [8, 7],
          batch_candidates_large_model: [6, 5],
          vram_soft_limit_mb: 9000,
          vram_hard_limit_mb: 11000,
          chunk_max_attempts: 3,
          model_load_timeout_seconds: 900,
          synthesis_timeout_seconds: 300,
          dispatch_stall_seconds: 45,
          model_residency_batches: 10,
          voice_residency_batches: 3,
        },
        scheduler: { queue_depth: 0, batch_candidates: [8, 7] },
        telemetry: {
          queue_depth: 0,
          model_state: "unloaded",
          idle_deadline: null,
          oom_count: 0,
          recent_batches: [],
          recent_events: [],
        },
        memory: null,
      },
    });
  });

  await page.goto("/admin");
  await page.getByRole("tab", { name: "Users" }).click();

  await expect(page.getByRole("heading", { name: "Accounts" })).toBeVisible();
  await page.getByLabel("Username").fill("reader");
  await page.getByLabel("Password (12+ characters)").fill("a reader password");
  await page.getByRole("button", { name: "Create account" }).click();

  // Scoped to the tab: the connection badge is also a `role="status"`.
  await expect(
    page.getByTestId("admin-users-tab").getByRole("status"),
  ).toContainText("Created reader");
  expect(created[0]).toMatchObject({ username: "reader", is_admin: false });
});
