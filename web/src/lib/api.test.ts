import { afterEach, expect, test, vi } from "vitest";

import { ApiError, api } from "./api";

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
  vi.restoreAllMocks();
});

function mockFailedResponse(status: number, body: unknown, throwOnJson = false) {
  global.fetch = vi.fn(async () => ({
    ok: false,
    status,
    json: async () => {
      if (throwOnJson) throw new Error("not json");
      return body;
    },
  })) as unknown as typeof fetch;
}

test("surfaces the backend error detail instead of a bare status", async () => {
  // The size limit is configurable, so the backend message is the only place
  // the user can learn what the actual limit is.
  mockFailedResponse(413, { detail: "Text is too large (limit is 64.0 MB)" });

  await expect(api.activateJob("job-1")).rejects.toThrow("Text is too large (limit is 64.0 MB)");
});

test("falls back to the status when the error body is not JSON", async () => {
  mockFailedResponse(500, null, true);

  await expect(api.activateJob("job-1")).rejects.toThrow("Request failed: 500");
});

test("attaches the request path and status to the error", async () => {
  mockFailedResponse(413, { detail: "Text is too large" });

  const error = await api.activateJob("job-1").catch((caught: unknown) => caught);

  expect(error).toBeInstanceOf(ApiError);
  expect((error as ApiError).path).toBe("/api/jobs/job-1/activate");
  expect((error as ApiError).status).toBe(413);
});
