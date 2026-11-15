import { afterEach, expect, test, vi } from "vitest";

import { ApiError, api } from "./api";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

function mockFailedResponse(
  status: number,
  body: unknown,
  throwOnJson = false,
) {
  globalThis.fetch = vi.fn(async () => ({
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

  await expect(api.activateJob("job-1")).rejects.toThrow(
    "Text is too large (limit is 64.0 MB)",
  );
});

test("falls back to the status when the error body is not JSON", async () => {
  mockFailedResponse(500, null, true);

  await expect(api.activateJob("job-1")).rejects.toThrow("Request failed: 500");
});

test("attaches the request path and status to the error", async () => {
  mockFailedResponse(413, { detail: "Text is too large" });

  const error = await api
    .activateJob("job-1")
    .catch((caught: unknown) => caught);

  expect(error).toBeInstanceOf(ApiError);
  expect((error as ApiError).path).toBe("/api/jobs/job-1/activate");
  expect((error as ApiError).status).toBe(413);
});

test("getAdminQueue requests the admin queue endpoint", async () => {
  const payload = {
    generated_at: "2026-11-15T18:04:11Z",
    queue_depth: 0,
    active_batch: null,
    next_batch: null,
    items: [],
  };
  const fetchMock = vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => payload,
  }));
  globalThis.fetch = fetchMock as unknown as typeof fetch;

  await expect(api.getAdminQueue()).resolves.toEqual(payload);
  expect(fetchMock).toHaveBeenCalledWith(
    "/api/admin/queue",
    expect.any(Object),
  );
});

test("downloadJobAudio asks for the requested encoding", async () => {
  const blob = new Blob([new Uint8Array([1, 2, 3])]);
  const fetchMock = vi.fn(async () => ({
    ok: true,
    status: 200,
    blob: async () => blob,
    headers: new Headers({
      "content-disposition": 'attachment; filename="my-book.flac"',
    }),
  }));
  globalThis.fetch = fetchMock as unknown as typeof fetch;

  const result = await api.downloadJobAudio("job-1", "flac");

  expect(fetchMock).toHaveBeenCalledWith(
    "/api/jobs/job-1/download?format=flac",
  );
  expect(result.filename).toBe("my-book.flac");
  expect(result.blob).toBe(blob);
});

test("downloadJobAudio defaults to m4a", async () => {
  const fetchMock = vi.fn(async () => ({
    ok: true,
    status: 200,
    blob: async () => new Blob([]),
    headers: new Headers(),
  }));
  globalThis.fetch = fetchMock as unknown as typeof fetch;

  const result = await api.downloadJobAudio("job-1");

  expect(fetchMock).toHaveBeenCalledWith("/api/jobs/job-1/download?format=m4a");
  // No Content-Disposition: fall back to the requested encoding's extension.
  expect(result.filename).toBe("readflow-job-job-1.m4a");
});
