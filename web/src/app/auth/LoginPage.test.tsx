import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  authStatusFor,
  resetAuthForTest,
  TEST_USER,
} from "../../test-utils/auth";
import { getAuthState } from "./auth-store";
import { LoginPage } from "./LoginPage";

/**
 * The login form must not invent a friendlier error than the server gives: a
 * message that distinguishes "unknown user" from "wrong password" would undo the
 * server's constant-time, generic failure. It must also honour `next`.
 */

function renderLogin(search = "") {
  return render(
    <MemoryRouter initialEntries={[`/login${search}`]}>
      <Routes>
        <Route element={<LoginPage />} path="/login" />
        <Route element={<div>signed in</div>} path="/" />
        <Route element={<div>the trash page</div>} path="/trash" />
      </Routes>
    </MemoryRouter>,
  );
}

function mockLogin(
  response: () => { ok: boolean; status: number; body: object },
) {
  globalThis.fetch = vi.fn(async () => {
    const { ok, status, body } = response();
    return { ok, status, json: async () => body };
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  resetAuthForTest();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("LoginPage", () => {
  it("signs in and lands on the requested page", async () => {
    mockLogin(() => ({
      ok: true,
      status: 200,
      body: authStatusFor(TEST_USER),
    }));
    const user = userEvent.setup();

    renderLogin("?next=%2Ftrash");
    await user.type(screen.getByLabelText("Username"), "local");
    await user.type(screen.getByLabelText("Password"), "readflow-local-dev");
    await user.click(screen.getByRole("button", { name: "Sign in" }));

    expect(await screen.findByText("the trash page")).toBeInTheDocument();
    expect(getAuthState().phase).toBe("authenticated");
  });

  it("shows the server's generic failure message", async () => {
    mockLogin(() => ({
      ok: false,
      status: 401,
      body: { detail: "Invalid username or password" },
    }));
    const user = userEvent.setup();

    renderLogin();
    await user.type(screen.getByLabelText("Username"), "nobody");
    await user.type(screen.getByLabelText("Password"), "whatever it is");
    await user.click(screen.getByRole("button", { name: "Sign in" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Invalid username or password",
    );
    // A failed login is not an expired session: the store stays anonymous.
    expect(getAuthState().phase).not.toBe("authenticated");
    expect(screen.queryByText("signed in")).not.toBeInTheDocument();
  });

  it("refuses an off-site next parameter", async () => {
    mockLogin(() => ({
      ok: true,
      status: 200,
      body: authStatusFor(TEST_USER),
    }));
    const user = userEvent.setup();

    renderLogin("?next=%2F%2Fevil.example");
    await user.type(screen.getByLabelText("Username"), "local");
    await user.type(screen.getByLabelText("Password"), "readflow-local-dev");
    await user.click(screen.getByRole("button", { name: "Sign in" }));

    // `//evil.example` is not a local path, so it falls back to the library.
    expect(await screen.findByText("signed in")).toBeInTheDocument();
  });
});
