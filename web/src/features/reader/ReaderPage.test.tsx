import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, vi } from "vitest";

import { ReaderPage } from "./ReaderPage";
import { useAppStore } from "../../state/store";
import type { Chunk } from "../../types/api";

const originalFetch = global.fetch;

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  global.fetch = originalFetch;
});

function buildReaderJob(
  chunkCount: number,
  status: "queued" | "rendering" | "playing" | "paused" = "queued",
) {
  return {
    id: "job-1",
    title: "Reader job",
    status,
    voice_id: "suzy",
    model_id: "Qwen/Qwen3-TTS-12Hz-0.6B-Base",
    is_active_listening: status === "playing",
    total_chunks_emitted: chunkCount,
    total_chunks_completed: chunkCount,
    buffered_seconds: chunkCount * 4,
    completed_seconds: 0,
    active_chunk_version: {} as Record<number, number>,
    source_kind: "text",
    source_text: "A reader page test.",
    plan_version: 1,
    chunks: Array.from({ length: chunkCount }, (_, index) => ({
      index,
      status: "written",
      duration_seconds: 4,
      start_seconds: index * 4,
      plan_version: 1,
      version: 0,
      voice_id: "suzy",
      segment_url: `/api/jobs/job-1/chunks/${index}`,
      deprecated: false,
      reprocessing: false,
    })),
    failed_reason: null,
  };
}

function buildManifest(chunkCount: number) {
  return {
    mime_type: 'audio/mp4; codecs="mp4a.40.2"',
    init_segment_url: "/api/jobs/job-1/chunks/init",
    chunks: Array.from({ length: chunkCount }, (_, index) => ({
      index,
      status: "written" as const,
      duration_seconds: 4,
      start_seconds: index * 4,
      plan_version: 1,
      version: 0,
      voice_id: "suzy",
      segment_url: `/api/jobs/job-1/chunks/${index}`,
      deprecated: false,
      reprocessing: false,
    })),
  };
}

function buildReaderJobWithChunks(
  chunks: Chunk[],
  status: "queued" | "rendering" | "playing" | "paused" = "queued",
) {
  const writtenChunkCount = chunks.filter((chunk) => chunk.status === "written").length;
  return {
    ...buildReaderJob(0, status),
    status,
    is_active_listening: status === "playing",
    total_chunks_emitted: chunks.length,
    total_chunks_completed: writtenChunkCount,
    buffered_seconds: chunks
      .filter((chunk) => chunk.status === "written")
      .reduce((total, chunk) => total + chunk.duration_seconds, 0),
    total_versioned_chunks: chunks.length,
    total_versioned_completed: writtenChunkCount,
    chunks,
  };
}

function buildManifestFromChunks(chunks: Chunk[]) {
  const enriched = chunks.map((c) => ({
    ...c,
    version: c.version ?? 0,
    deprecated: c.deprecated ?? false,
    reprocessing: c.reprocessing ?? false,
  }));
  return {
    mime_type: 'audio/mp4; codecs="mp4a.40.2"',
    init_segment_url: "/api/jobs/job-1/chunks/init",
    chunks: enriched,
  };
}

function seedStore(overrides?: Partial<ReturnType<typeof useAppStore.getState>>) {
  useAppStore.setState({
    jobs: {},
    voices: [
      { id: "suzy", display_name: "Suzy", description: null },
      { id: "howard", display_name: "Howard", description: null },
    ],
    adminState: null,
    websocketStatus: "open",
    lastSocketMessageAt: Date.now(),
    lastSocketError: null,
    reconnectAttempt: 0,
    isSocketStale: false,
    lastEvent: null,
    ...overrides,
  });
}

beforeEach(() => {
  HTMLMediaElement.prototype.play = vi.fn().mockResolvedValue(undefined);
  HTMLMediaElement.prototype.pause = vi.fn();
  HTMLMediaElement.prototype.load = vi.fn();
  Object.defineProperty(HTMLMediaElement.prototype, "buffered", {
    configurable: true,
    get() {
      return {
        length: 1,
        start: () => 0,
        end: () => 60,
      };
    },
  });
});

afterEach(() => {
  vi.useRealTimers();
});

test("loads a job and sends play plus voice actions", async () => {
  const user = userEvent.setup();
  seedStore();

  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/api/jobs/job-1")) {
      return { ok: true, json: async () => buildReaderJob(1) };
    }
    if (url.endsWith("/api/jobs/job-1/manifest")) {
      return { ok: true, json: async () => buildManifest(1) };
    }
    if (url.endsWith("/activate")) {
      return { ok: true, json: async () => buildReaderJob(1, "playing") };
    }
    if (url.endsWith("/pause")) {
      return { ok: true, json: async () => buildReaderJob(1, "paused") };
    }
    if (url.endsWith("/playback")) {
      return { ok: true, json: async () => buildReaderJob(1, "playing") };
    }
    if (url.endsWith("/voice")) {
      return {
        ok: true,
        json: async () => ({
          ...buildReaderJob(1),
          voice_id: "howard",
          plan_version: 2,
        }),
      };
    }
    return { ok: true, arrayBuffer: async () => new Uint8Array([1]).buffer };
  });
  global.fetch = fetchMock as typeof fetch;

  render(
    <MemoryRouter initialEntries={["/jobs/job-1"]}>
      <Routes>
        <Route element={<ReaderPage />} path="/jobs/:jobId" />
      </Routes>
    </MemoryRouter>,
  );

  await waitFor(() => expect(screen.getByText("Reader job")).toBeInTheDocument());
  await user.click(screen.getByRole("button", { name: "Play" }));
  await user.selectOptions(screen.getByRole("combobox"), "howard");

  expect(fetchMock).toHaveBeenCalledWith("/api/jobs/job-1/activate", expect.any(Object));
  expect(fetchMock).toHaveBeenCalledWith("/api/jobs/job-1/voice", expect.any(Object));
});

test("refreshes when a relevant websocket event arrives without page reload", async () => {
  seedStore();
  let chunkCount = 1;
  let jobFetchCount = 0;
  let manifestFetchCount = 0;

  global.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/api/jobs/job-1")) {
      jobFetchCount += 1;
      return { ok: true, json: async () => buildReaderJob(chunkCount) };
    }
    if (url.endsWith("/api/jobs/job-1/manifest")) {
      manifestFetchCount += 1;
      return { ok: true, json: async () => buildManifest(chunkCount) };
    }
    return { ok: true, arrayBuffer: async () => new Uint8Array([chunkCount]).buffer };
  }) as typeof fetch;

  render(
    <MemoryRouter initialEntries={["/jobs/job-1"]}>
      <Routes>
        <Route element={<ReaderPage />} path="/jobs/:jobId" />
      </Routes>
    </MemoryRouter>,
  );

  expect(await screen.findByText(/1\/1 chunks rendered/i)).toBeInTheDocument();
  expect(jobFetchCount).toBe(1);
  expect(manifestFetchCount).toBe(1);

  chunkCount = 2;
  act(() => {
    useAppStore.getState().applyEvent({
      type: "chunk_ready",
      payload: {
        job: buildReaderJob(2),
        chunk_index: 1,
        mime_type: 'audio/mp4; codecs="mp4a.40.2"',
        init_segment_url: "/api/jobs/job-1/chunks/init",
      },
    });
  });

  expect(await screen.findByText(/2\/2 chunks rendered/i)).toBeInTheDocument();
  expect(screen.getByText("Chunk 2")).toBeInTheDocument();
  expect(jobFetchCount).toBe(1);
  expect(manifestFetchCount).toBe(1);
});

test(
  "polling fallback updates the reader while the socket is stale",
  async () => {
    seedStore({
      websocketStatus: "reconnecting",
      isSocketStale: true,
      lastSocketError: "Live updates are stale. Polling fallback is active.",
    });

    let chunkCount = 1;
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/jobs/job-1")) {
        return { ok: true, json: async () => buildReaderJob(chunkCount, "rendering") };
      }
      if (url.endsWith("/api/jobs/job-1/manifest")) {
        return { ok: true, json: async () => buildManifest(chunkCount) };
      }
      return { ok: true, arrayBuffer: async () => new Uint8Array([chunkCount]).buffer };
    }) as typeof fetch;

    render(
      <MemoryRouter initialEntries={["/jobs/job-1"]}>
        <Routes>
          <Route element={<ReaderPage />} path="/jobs/:jobId" />
        </Routes>
      </MemoryRouter>,
    );

    expect(await screen.findByText(/Live updates degraded, using fallback sync/i)).toBeInTheDocument();
    expect(screen.getByText(/1\/1 chunks rendered/i)).toBeInTheDocument();

    chunkCount = 2;
    // The polling interval is 3 seconds; wait for it to fire
    await waitFor(() => expect(screen.getByText(/2\/2 chunks rendered/i)).toBeInTheDocument(), {
      timeout: 6_000,
    });
  },
  10_000,
);

test("shows waiting copy when play is armed before the first chunk exists and hydrates from websocket metadata", async () => {
  const user = userEvent.setup();
  seedStore();

  let job = {
    ...buildReaderJob(0, "rendering"),
    total_chunks_emitted: 1,
    total_chunks_completed: 0,
    buffered_seconds: 0,
    chunks: [],
  };

  global.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/api/jobs/job-1")) {
      return { ok: true, json: async () => job };
    }
    if (url.endsWith("/api/jobs/job-1/manifest")) {
      return {
        ok: true,
        json: async () => ({
          mime_type: 'audio/mp4; codecs="mp4a.40.2"',
          init_segment_url: null,
          chunks: [],
        }),
      };
    }
    if (url.endsWith("/activate")) {
      return { ok: true, json: async () => ({ ...job, status: "playing", is_active_listening: true }) };
    }
    if (url.endsWith("/playback")) {
      return { ok: true, json: async () => ({ ...job, status: "playing", is_active_listening: true }) };
    }
    return { ok: true, arrayBuffer: async () => new Uint8Array([1]).buffer };
  }) as typeof fetch;

  render(
    <MemoryRouter initialEntries={["/jobs/job-1"]}>
      <Routes>
        <Route element={<ReaderPage />} path="/jobs/:jobId" />
      </Routes>
    </MemoryRouter>,
  );

  await screen.findByText("Reader job");
  await user.click(screen.getByRole("button", { name: "Play" }));

  expect(await screen.findByText(/Waiting for first chunk/i)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Download not ready" })).toBeDisabled();

  job = buildReaderJob(1, "playing");
  act(() => {
    useAppStore.getState().applyEvent({
      type: "chunk_ready",
      payload: {
        job,
        chunk_index: 0,
        mime_type: 'audio/mp4; codecs="mp4a.40.2"',
        init_segment_url: "/api/jobs/job-1/chunks/init",
      },
    });
  });

  expect(await screen.findByText(/1\/1 chunks rendered/i)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /pause/i })).toBeInTheDocument();
});

test("completed jobs stay local-only and can download rendered audio without backend playback churn", async () => {
  const user = userEvent.setup();
  seedStore({
    websocketStatus: "closed",
    lastSocketError: null,
  });

  const createObjectUrlSpy = vi
    .spyOn(URL, "createObjectURL")
    .mockReturnValue("blob:download-audio");
  const revokeObjectUrlSpy = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
  const anchorClickSpy = vi
    .spyOn(HTMLAnchorElement.prototype, "click")
    .mockImplementation(() => undefined);

  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/api/jobs/job-1")) {
      return { ok: true, json: async () => buildReaderJob(2, "completed") };
    }
    if (url.endsWith("/api/jobs/job-1/manifest")) {
      return { ok: true, json: async () => buildManifest(2) };
    }
    if (url.endsWith("/api/jobs/job-1/download")) {
      return {
        ok: true,
        blob: async () => new Blob([new Uint8Array([1, 2, 3])], { type: "audio/mp4" }),
        headers: {
          get: (name: string) =>
            name.toLowerCase() === "content-disposition"
              ? 'attachment; filename="reader-job.m4a"'
              : null,
        },
      };
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });
  global.fetch = fetchMock as typeof fetch;

  render(
    <MemoryRouter initialEntries={["/jobs/job-1"]}>
      <Routes>
        <Route element={<ReaderPage />} path="/jobs/:jobId" />
      </Routes>
    </MemoryRouter>,
  );

  await screen.findByText("Reader job");
  expect(screen.getByText(/Reader is local-only/i)).toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: "Play" }));
  await user.click(screen.getByRole("button", { name: "Pause" }));
  await user.click(screen.getByRole("button", { name: /download full audio/i }));
  await user.click(screen.getByRole("button", { name: "Play" }));

  expect(fetchMock).not.toHaveBeenCalledWith("/api/jobs/job-1/activate", expect.anything());
  expect(fetchMock).not.toHaveBeenCalledWith("/api/jobs/job-1/pause", expect.anything());
  expect(fetchMock).not.toHaveBeenCalledWith("/api/jobs/job-1/playback", expect.anything());
  expect(fetchMock).toHaveBeenCalledWith("/api/jobs/job-1/download");
  expect(anchorClickSpy).toHaveBeenCalled();

  createObjectUrlSpy.mockRestore();
  revokeObjectUrlSpy.mockRestore();
  anchorClickSpy.mockRestore();
});

test("completed jobs sync the play button when local playback resumes after reaching the end", async () => {
  const user = userEvent.setup();
  seedStore({
    websocketStatus: "closed",
    lastSocketError: null,
  });

  global.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/api/jobs/job-1")) {
      return { ok: true, json: async () => buildReaderJob(2, "completed") };
    }
    if (url.endsWith("/api/jobs/job-1/manifest")) {
      return { ok: true, json: async () => buildManifest(2) };
    }
    throw new Error(`Unexpected fetch: ${url}`);
  }) as typeof fetch;

  const { container } = render(
    <MemoryRouter initialEntries={["/jobs/job-1"]}>
      <Routes>
        <Route element={<ReaderPage />} path="/jobs/:jobId" />
      </Routes>
    </MemoryRouter>,
  );

  await screen.findByText("Reader job");
  const audio = container.querySelector("audio");
  expect(audio).not.toBeNull();

  await user.click(screen.getByRole("button", { name: "Play" }));
  expect(screen.getByRole("button", { name: "Pause" })).toBeInTheDocument();

  act(() => {
    if (audio) {
      audio.currentTime = 8;
      audio.dispatchEvent(new Event("ended"));
    }
  });

  await waitFor(() => expect(screen.getByRole("button", { name: "Play" })).toBeInTheDocument());

  await user.click(screen.getByRole("button", { name: "Chunk 1 played" }));

  await waitFor(() => expect(screen.getByRole("button", { name: "Pause" })).toBeInTheDocument());
});

test("renders gap-aware slots and allows manual jump to a later ready chunk without auto-skipping", async () => {
  seedStore();

  const chunks: Chunk[] = [
    {
      index: 0,
      status: "written",
      duration_seconds: 4,
      start_seconds: 0,
      plan_version: 1,
      version: 0,
      voice_id: "suzy",
      segment_url: "/api/jobs/job-1/chunks/0",
      deprecated: false,
      reprocessing: false,
    },
    {
      index: 1,
      status: "written",
      duration_seconds: 4,
      start_seconds: 4,
      plan_version: 1,
      version: 0,
      voice_id: "suzy",
      segment_url: "/api/jobs/job-1/chunks/1",
      deprecated: false,
      reprocessing: false,
    },
    {
      index: 2,
      status: "written",
      duration_seconds: 4,
      start_seconds: 8,
      plan_version: 1,
      version: 0,
      voice_id: "suzy",
      segment_url: "/api/jobs/job-1/chunks/2",
      deprecated: false,
      reprocessing: false,
    },
    {
      index: 3,
      status: "queued",
      duration_seconds: 0,
      start_seconds: 0,
      plan_version: 1,
      version: 0,
      voice_id: "suzy",
      segment_url: null,
      deprecated: false,
      reprocessing: false,
    },
    {
      index: 4,
      status: "rendering",
      duration_seconds: 0,
      start_seconds: 0,
      plan_version: 1,
      version: 0,
      voice_id: "suzy",
      segment_url: null,
      deprecated: false,
      reprocessing: false,
    },
    {
      index: 5,
      status: "written",
      duration_seconds: 4,
      start_seconds: 20,
      plan_version: 1,
      version: 0,
      voice_id: "suzy",
      segment_url: "/api/jobs/job-1/chunks/5",
      deprecated: false,
      reprocessing: false,
    },
  ];

  const activateMock = vi.fn(async () => ({
    ok: true,
    json: async () => buildReaderJobWithChunks(chunks, "playing"),
  }));

  global.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/api/jobs/job-1")) {
      return { ok: true, json: async () => buildReaderJobWithChunks(chunks, "queued") };
    }
    if (url.endsWith("/api/jobs/job-1/manifest")) {
      return { ok: true, json: async () => buildManifestFromChunks(chunks) };
    }
    if (url.endsWith("/activate")) {
      return activateMock();
    }
    if (url.endsWith("/playback")) {
      return { ok: true, json: async () => buildReaderJobWithChunks(chunks, "playing") };
    }
    return { ok: true, arrayBuffer: async () => new Uint8Array([1]).buffer };
  }) as typeof fetch;

  render(
    <MemoryRouter initialEntries={["/jobs/job-1"]}>
      <Routes>
        <Route element={<ReaderPage />} path="/jobs/:jobId" />
      </Routes>
    </MemoryRouter>,
  );

  await screen.findByText("Reader job");

  expect(screen.getByRole("button", { name: "Download rendered audio so far" })).toBeEnabled();

  expect(screen.getByRole("button", { name: "Chunk 1 active" })).toHaveAttribute(
    "data-slot-state",
    "playing",
  );
  expect(screen.getByRole("button", { name: "Chunk 4 expected but not received" })).toHaveAttribute(
    "data-slot-state",
    "missing_expected",
  );
  expect(screen.getByRole("button", { name: "Chunk 5 expected but not received" })).toHaveAttribute(
    "data-slot-state",
    "missing_expected",
  );
  expect(screen.getByRole("button", { name: "Chunk 6 ready after gap" })).toHaveAttribute(
    "data-slot-state",
    "ready_after_gap",
  );

  await userEvent.setup().click(screen.getByRole("button", { name: "Chunk 6 ready after gap" }));

  await waitFor(() =>
    expect(screen.getByText(/Playback anchor: Chunk 6/i)).toBeInTheDocument(),
  );
  expect(activateMock).toHaveBeenCalledTimes(1);
});

test("stays in buffering mode when playback reaches the end of the current contiguous run", async () => {
  const user = userEvent.setup();
  seedStore();

  let bufferedEnd = 60;
  Object.defineProperty(HTMLMediaElement.prototype, "buffered", {
    configurable: true,
    get() {
      return {
        length: bufferedEnd > 0 ? 1 : 0,
        start: () => 0,
        end: () => bufferedEnd,
      };
    },
  });

  const chunks: Chunk[] = [
    {
      index: 0,
      status: "written",
      duration_seconds: 4,
      start_seconds: 0,
      plan_version: 1,
      version: 0,
      voice_id: "suzy",
      segment_url: "/api/jobs/job-1/chunks/0",
      deprecated: false,
      reprocessing: false,
    },
    {
      index: 1,
      status: "written",
      duration_seconds: 4,
      start_seconds: 4,
      plan_version: 1,
      version: 0,
      voice_id: "suzy",
      segment_url: "/api/jobs/job-1/chunks/1",
      deprecated: false,
      reprocessing: false,
    },
    {
      index: 2,
      status: "written",
      duration_seconds: 4,
      start_seconds: 8,
      plan_version: 1,
      version: 0,
      voice_id: "suzy",
      segment_url: "/api/jobs/job-1/chunks/2",
      deprecated: false,
      reprocessing: false,
    },
    {
      index: 3,
      status: "queued",
      duration_seconds: 0,
      start_seconds: 0,
      plan_version: 1,
      version: 0,
      voice_id: "suzy",
      segment_url: null,
      deprecated: false,
      reprocessing: false,
    },
  ];

  global.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/api/jobs/job-1")) {
      return { ok: true, json: async () => buildReaderJobWithChunks(chunks, "queued") };
    }
    if (url.endsWith("/api/jobs/job-1/manifest")) {
      return { ok: true, json: async () => buildManifestFromChunks(chunks) };
    }
    if (url.endsWith("/activate")) {
      return { ok: true, json: async () => buildReaderJobWithChunks(chunks, "playing") };
    }
    if (url.endsWith("/playback")) {
      return { ok: true, json: async () => buildReaderJobWithChunks(chunks, "playing") };
    }
    return { ok: true, arrayBuffer: async () => new Uint8Array([1]).buffer };
  }) as typeof fetch;

  const { container } = render(
    <MemoryRouter initialEntries={["/jobs/job-1"]}>
      <Routes>
        <Route element={<ReaderPage />} path="/jobs/:jobId" />
      </Routes>
    </MemoryRouter>,
  );

  await screen.findByText("Reader job");
  await user.click(screen.getByRole("button", { name: "Play" }));

  const audio = container.querySelector("audio");
  expect(audio).not.toBeNull();

  act(() => {
    bufferedEnd = 12;
    if (audio) {
      audio.currentTime = 12;
      audio.dispatchEvent(new Event("ended"));
    }
  });

  expect(await screen.findByText(/Waiting for next chunk/i)).toBeInTheDocument();
  expect(container.querySelector(".animate-spin")).not.toBeNull();
  expect(screen.getByRole("button", { name: "Pause" })).toBeInTheDocument();

  const completedChunks: Chunk[] = [
    ...chunks.slice(0, 3),
    {
      index: 3,
      status: "written",
      duration_seconds: 0.5,
      start_seconds: 12,
      plan_version: 1,
      voice_id: "suzy",
      segment_url: "/api/jobs/job-1/chunks/3",
    },
  ];

  act(() => {
    useAppStore.getState().applyEvent({
      type: "job_completed",
      payload: {
        job: buildReaderJobWithChunks(completedChunks, "completed"),
        chunk_index: 3,
        mime_type: 'audio/mp4; codecs="mp4a.40.2"',
        init_segment_url: "/api/jobs/job-1/chunks/init",
      },
    });
  });

  await waitFor(() =>
    expect(screen.queryByText(/Waiting for next chunk/i)).not.toBeInTheDocument(),
  );
  expect(container.querySelector(".animate-spin")).toBeNull();
  expect(screen.getByRole("button", { name: "Play" })).toBeInTheDocument();
});

describe("chunk versioning & reprocessing", () => {
  beforeEach(() => {
    seedStore();
  });

  test("shows version badges for chunk with multiple versions", async () => {
    const multiVersionChunks: Chunk[] = [
      {
        index: 0,
        status: "written",
        duration_seconds: 4,
        start_seconds: 0,
        plan_version: 1,
        version: 0,
        voice_id: "suzy",
        segment_url: "/api/jobs/job-1/chunks/0",
        deprecated: true,
        reprocessing: false,
      },
      {
        index: 0,
        status: "written",
        duration_seconds: 4,
        start_seconds: 0,
        plan_version: 2,
        version: 1,
        voice_id: "suzy",
        segment_url: "/api/jobs/job-1/chunks/0",
        deprecated: false,
        reprocessing: false,
      },
    ];

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/api/jobs/job-1")) {
          return new Response(
            JSON.stringify(buildReaderJobWithChunks(multiVersionChunks, "queued")),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        if (url.endsWith("/api/jobs/job-1/manifest")) {
          return new Response(
            JSON.stringify(buildManifestFromChunks(multiVersionChunks)),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        return new Response(new Uint8Array([1]).buffer, {
          status: 200,
          headers: { "Content-Type": "application/octet-stream" },
        });
      }),
    );

    render(
      <MemoryRouter initialEntries={["/jobs/job-1"]}>
        <Routes>
          <Route element={<ReaderPage />} path="/jobs/:jobId" />
        </Routes>
      </MemoryRouter>,
    );

    await screen.findByText("Reader job");

    // Both version buttons (V0, V1) should appear in the Chunk status panel
    await vi.waitFor(() => {
      expect(screen.getByRole("button", { name: "V0" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "V1" })).toBeInTheDocument();
    });
  });

  test("written chunk status shows emerald badge", async () => {
    const chunks: Chunk[] = [
      {
        index: 0,
        status: "written",
        duration_seconds: 4,
        start_seconds: 0,
        plan_version: 1,
        version: 0,
        voice_id: "suzy",
        segment_url: "/api/jobs/job-1/chunks/0",
        deprecated: false,
        reprocessing: false,
      },
    ];

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/api/jobs/job-1")) {
          return new Response(
            JSON.stringify(buildReaderJobWithChunks(chunks, "queued")),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        if (url.endsWith("/api/jobs/job-1/manifest")) {
          return new Response(
            JSON.stringify(buildManifestFromChunks(chunks)),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        return new Response(new Uint8Array([1]).buffer, {
          status: 200,
          headers: { "Content-Type": "application/octet-stream" },
        });
      }),
    );

    const { container } = render(
      <MemoryRouter initialEntries={["/jobs/job-1"]}>
        <Routes>
          <Route element={<ReaderPage />} path="/jobs/:jobId" />
        </Routes>
      </MemoryRouter>,
    );

    await screen.findByText("Reader job");

    // Find the status badge for the written chunk - uses bg-emerald-100
    const statusBadges = container.querySelectorAll('[class*="rounded-full"]');
    const writtenBadge = Array.from(statusBadges).find((badge) =>
      badge.textContent?.includes("written"),
    );
    expect(writtenBadge).toBeDefined();
    expect(writtenBadge?.className).toContain("bg-emerald-100");
  });

  test("chunks with max_retries_exceeded status are treated as failed", async () => {
    const chunks: Chunk[] = [
      {
        index: 0,
        status: "max_retries_exceeded",
        duration_seconds: 0,
        start_seconds: 0,
        plan_version: 1,
        version: 0,
        voice_id: "suzy",
        segment_url: null,
        deprecated: false,
        reprocessing: false,
      },
    ];

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/api/jobs/job-1")) {
          return new Response(
            JSON.stringify(buildReaderJobWithChunks(chunks, "queued")),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        if (url.endsWith("/api/jobs/job-1/manifest")) {
          return new Response(
            JSON.stringify(buildManifestFromChunks(chunks)),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        return new Response(new Uint8Array([1]).buffer, {
          status: 200,
          headers: { "Content-Type": "application/octet-stream" },
        });
      }),
    );

    const { container } = render(
      <MemoryRouter initialEntries={["/jobs/job-1"]}>
        <Routes>
          <Route element={<ReaderPage />} path="/jobs/:jobId" />
        </Routes>
      </MemoryRouter>,
    );

    await screen.findByText("Reader job");

    // max_retries_exceeded chunks should render as "failed" in the timeline
    expect(screen.getByRole("button", { name: "Chunk 1 failed" })).toHaveAttribute(
      "data-slot-state",
      "failed",
    );

    // Status badge should use rose (rose-100) styling
    const statusBadges = container.querySelectorAll('[class*="rounded-full"]');
    const failedBadge = Array.from(statusBadges).find((badge) =>
      badge.textContent?.includes("max_retries_exceeded"),
    );
    expect(failedBadge).toBeDefined();
    expect(failedBadge?.className).toContain("bg-rose-100");
  });

  test("shows reprocessing indicator on reprocessing chunks", async () => {
    const chunks: Chunk[] = [
      {
        index: 0,
        status: "reprocessing",
        duration_seconds: 4,
        start_seconds: 0,
        plan_version: 1,
        version: 0,
        voice_id: "suzy",
        segment_url: "/api/jobs/job-1/chunks/0",
        deprecated: false,
        reprocessing: true,
      },
    ];

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/api/jobs/job-1")) {
          return new Response(
            JSON.stringify(buildReaderJobWithChunks(chunks, "queued")),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        if (url.endsWith("/api/jobs/job-1/manifest")) {
          return new Response(
            JSON.stringify(buildManifestFromChunks(chunks)),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        return new Response(new Uint8Array([1]).buffer, {
          status: 200,
          headers: { "Content-Type": "application/octet-stream" },
        });
      }),
    );

    const { container } = render(
      <MemoryRouter initialEntries={["/jobs/job-1"]}>
        <Routes>
          <Route element={<ReaderPage />} path="/jobs/:jobId" />
        </Routes>
      </MemoryRouter>,
    );

    await screen.findByText("Reader job");

    // The reprocessing indicator text should appear
    await vi.waitFor(() => {
      expect(screen.getByText(/↻ reprocessing/)).toBeInTheDocument();
    });

    // The status badge should have amber styling
    const statusBadges = container.querySelectorAll('[class*="rounded-full"]');
    const reprocessingBadge = Array.from(statusBadges).find((badge) =>
      badge.textContent?.includes("reprocessing"),
    );
    expect(reprocessingBadge).toBeDefined();
    expect(reprocessingBadge?.className).toContain("bg-amber-100");
  });

  test("shows duration for written chunks in status list", async () => {
    const chunks: Chunk[] = [
      {
        index: 0,
        status: "written",
        duration_seconds: 4.5,
        start_seconds: 0,
        plan_version: 1,
        version: 0,
        voice_id: "suzy",
        segment_url: "/api/jobs/job-1/chunks/0",
        deprecated: false,
        reprocessing: false,
      },
    ];

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/api/jobs/job-1")) {
          return new Response(
            JSON.stringify(buildReaderJobWithChunks(chunks, "queued")),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        if (url.endsWith("/api/jobs/job-1/manifest")) {
          return new Response(
            JSON.stringify(buildManifestFromChunks(chunks)),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        return new Response(new Uint8Array([1]).buffer, {
          status: 200,
          headers: { "Content-Type": "application/octet-stream" },
        });
      }),
    );

    render(
      <MemoryRouter initialEntries={["/jobs/job-1"]}>
        <Routes>
          <Route element={<ReaderPage />} path="/jobs/:jobId" />
        </Routes>
      </MemoryRouter>,
    );

    await screen.findByText("Reader job");

    // Duration should be shown in the Chunk status panel
    await waitFor(() =>
      expect(screen.getByText("• 4.5s")).toBeInTheDocument(),
    );
  });

  test("shows version badges in chunk status list", async () => {
    const chunks: Chunk[] = [
      {
        index: 0,
        status: "written",
        duration_seconds: 4,
        start_seconds: 0,
        plan_version: 1,
        version: 1,
        voice_id: "suzy",
        segment_url: "/api/jobs/job-1/chunks/0",
        deprecated: false,
        reprocessing: false,
      },
    ];

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/api/jobs/job-1")) {
          return new Response(
            JSON.stringify(buildReaderJobWithChunks(chunks, "queued")),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        if (url.endsWith("/api/jobs/job-1/manifest")) {
          return new Response(
            JSON.stringify(buildManifestFromChunks(chunks)),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        return new Response(new Uint8Array([1]).buffer, {
          status: 200,
          headers: { "Content-Type": "application/octet-stream" },
        });
      }),
    );

    render(
      <MemoryRouter initialEntries={["/jobs/job-1"]}>
        <Routes>
          <Route element={<ReaderPage />} path="/jobs/:jobId" />
        </Routes>
      </MemoryRouter>,
    );

    await screen.findByText("Reader job");

    // Version span "V1" should appear in the status list
    await waitFor(() =>
      expect(screen.queryAllByText("V1").length).toBeGreaterThan(0),
    );
  });
});

describe("playback speed control", () => {
  beforeEach(() => {
    seedStore();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/api/jobs/job-1")) {
          return new Response(
            JSON.stringify(buildReaderJob(2, "completed")),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        if (url.endsWith("/api/jobs/job-1/manifest")) {
          return new Response(
            JSON.stringify(buildManifest(2)),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        return new Response(new Uint8Array([1]).buffer, {
          status: 200,
          headers: { "Content-Type": "application/octet-stream" },
        });
      }),
    );
  });

  test("renders the speed slider and text input in the player controls", async () => {
    render(
      <MemoryRouter initialEntries={["/jobs/job-1"]}>
        <Routes>
          <Route element={<ReaderPage />} path="/jobs/:jobId" />
        </Routes>
      </MemoryRouter>,
    );

    await screen.findByText("Reader job");

    expect(
      screen.getByRole("slider", { name: /playback speed slider/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("textbox", { name: /playback speed value/i }),
    ).toBeInTheDocument();
  });

  test("slider starts at 1.0 and input shows 1", async () => {
    render(
      <MemoryRouter initialEntries={["/jobs/job-1"]}>
        <Routes>
          <Route element={<ReaderPage />} path="/jobs/:jobId" />
        </Routes>
      </MemoryRouter>,
    );

    await screen.findByText("Reader job");

    const slider = screen.getByRole("slider", { name: /playback speed slider/i });
    expect(slider).toHaveValue("1");

    const input = screen.getByRole("textbox", { name: /playback speed value/i });
    expect(input).toHaveValue("1");
  });

  test("changing the speed slider updates the displayed speed value", async () => {
    render(
      <MemoryRouter initialEntries={["/jobs/job-1"]}>
        <Routes>
          <Route element={<ReaderPage />} path="/jobs/:jobId" />
        </Routes>
      </MemoryRouter>,
    );

    await screen.findByText("Reader job");

    const slider = screen.getByRole("slider", { name: /playback speed slider/i });
    const input = screen.getByRole("textbox", { name: /playback speed value/i });

    fireEvent.change(slider, { target: { value: "2" } });

    expect(input).toHaveValue("2");
  });

  test("typing a speed in the input and pressing Enter updates the displayed speed", async () => {
    render(
      <MemoryRouter initialEntries={["/jobs/job-1"]}>
        <Routes>
          <Route element={<ReaderPage />} path="/jobs/:jobId" />
        </Routes>
      </MemoryRouter>,
    );

    await screen.findByText("Reader job");

    const input = screen.getByRole("textbox", { name: /playback speed value/i });

    fireEvent.change(input, { target: { value: "0.75" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(input).toHaveValue("0.75");
  });

  test("speed control co-exists with play/pause and clock", async () => {
    render(
      <MemoryRouter initialEntries={["/jobs/job-1"]}>
        <Routes>
          <Route element={<ReaderPage />} path="/jobs/:jobId" />
        </Routes>
      </MemoryRouter>,
    );

    await screen.findByText("Reader job");

    // All key player controls should be in the DOM together
    expect(screen.getByRole("button", { name: /play/i })).toBeInTheDocument();
    expect(screen.getByRole("slider", { name: /playback speed slider/i })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: /playback speed value/i })).toBeInTheDocument();
  });

  test("invalid speed input reverts to the current value", async () => {
    render(
      <MemoryRouter initialEntries={["/jobs/job-1"]}>
        <Routes>
          <Route element={<ReaderPage />} path="/jobs/:jobId" />
        </Routes>
      </MemoryRouter>,
    );

    await screen.findByText("Reader job");

    const input = screen.getByRole("textbox", { name: /playback speed value/i });

    // Default is 1. Type invalid, blur — should revert
    fireEvent.change(input, { target: { value: "abc" } });
    fireEvent.blur(input);

    expect(input).toHaveValue("1");
  });
});
