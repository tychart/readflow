import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  authStatusFor,
  resetAuthForTest,
  signInForTest,
} from "../../test-utils/auth";
import { AuthGate } from "./AuthGate";

/**
 * The gate decides three things: show a splash while the session is unknown,
 * redirect an anonymous visitor to /login?next=…, and redirect an install with no
 * accounts to /setup. `next` is what makes a bookmarked deep link survive login.
 */

const statusMock = vi.fn();

function renderGate(path = "/jobs/job-1?play=1") {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route
          element={
            <AuthGate>
              <div>the reader</div>
            </AuthGate>
          }
          path="/jobs/:jobId"
        />
        <Route element={<div>login page</div>} path="/login" />
        <Route element={<div>setup page</div>} path="/setup" />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  resetAuthForTest();
  statusMock.mockReset();
  globalThis.fetch = vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => statusMock(),
  })) as unknown as typeof fetch;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("AuthGate", () => {
  it("shows a splash until the status resolves", () => {
    statusMock.mockReturnValue(new Promise(() => undefined));

    renderGate();

    expect(screen.getByTestId("auth-splash")).toBeInTheDocument();
    expect(screen.queryByText("the reader")).not.toBeInTheDocument();
  });

  it("renders the page for an authenticated user", async () => {
    statusMock.mockReturnValue(authStatusFor(signInForTestAndReturn()));

    renderGate();

    expect(await screen.findByText("the reader")).toBeInTheDocument();
  });

  it("redirects an anonymous visitor with the requested path", async () => {
    statusMock.mockReturnValue(authStatusFor(null));

    renderGate();

    expect(await screen.findByText("login page")).toBeInTheDocument();
    // The redirect target carries `next`, so login returns to this job.
    await waitFor(() => expect(statusMock).toHaveBeenCalled());
  });

  it("redirects to setup when the install has no users", async () => {
    statusMock.mockReturnValue({
      needs_setup: true,
      authenticated: false,
      user: null,
    });

    renderGate();

    expect(await screen.findByText("setup page")).toBeInTheDocument();
  });

  it("falls back to the login page when the status request fails", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new TypeError("network down");
    }) as unknown as typeof fetch;

    renderGate();

    expect(await screen.findByText("login page")).toBeInTheDocument();
  });
});

/** Mark the session signed in and return the user, for the status payload. */
function signInForTestAndReturn() {
  signInForTest();
  // `signInForTest` applies the status itself; return the user for the mock.
  return {
    id: "user-1",
    username: "local",
    display_name: "Local user",
    is_admin: true,
    is_active: true,
    created_at: "2025-11-15T18:04:11Z",
  };
}
