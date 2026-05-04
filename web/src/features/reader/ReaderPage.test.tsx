import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";

import { ReaderPage } from "./ReaderPage";
import { useAppStore } from "../../state/store";
import type { Chunk } from "../../types/api";

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
    source_kind: "text",
    source_text: "A reader page test.",
    plan_version: 1,
    chunks: Array.from({ length: chunkCount }, (_, index) => ({
      index,
      status: "written",
      duration_seconds: 4,
      start_seconds: index * 4,
      plan_version: 1,
      voice_id: "suzy",
      segment_url: `/api/jobs/job-1/chunks/${index}`,
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
      voice_id: "suzy",
      segment_url: `/api/jobs/job-1/chunks/${index}`,
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
    chunks,
  };
}

function buildManifestFromChunks(chunks: Chunk[]) {
  return {
    mime_type: 'audio/mp4; codecs="mp4a.40.2"',
    init_segment_url: "/api/jobs/job-1/chunks/init",
    chunks,
  };
}

function seedStore(overrides?: Partial<ReturnType<typeof useAppStore.getState>>) {
  useAppStore.setState({
    jobs: [],
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

test("polling fallback updates the reader while the socket is stale", async () => {
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
  await waitFor(() => expect(screen.getByText(/2\/2 chunks rendered/i)).toBeInTheDocument(), {
    timeout: 2_500,
  });
});

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
  const playMock = vi.mocked(HTMLMediaElement.prototype.play);
  const pauseMock = vi.mocked(HTMLMediaElement.prototype.pause);

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
    if (url.endsWith("/api/jobs/job-1/chunks/init")) {
      return { ok: true, arrayBuffer: async () => new Uint8Array([9]).buffer };
    }
    if (url.endsWith("/api/jobs/job-1/chunks/0")) {
      return { ok: true, arrayBuffer: async () => new Uint8Array([1]).buffer };
    }
    if (url.endsWith("/api/jobs/job-1/chunks/1")) {
      return { ok: true, arrayBuffer: async () => new Uint8Array([2]).buffer };
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
  const playCallsAfterFirstPlay = playMock.mock.calls.length;
  expect(playCallsAfterFirstPlay).toBeGreaterThanOrEqual(1);
  await user.click(screen.getByRole("button", { name: "Pause" }));
  expect(pauseMock).toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: /download full audio/i }));
  await user.click(screen.getByRole("button", { name: "Play" }));

  expect(playMock.mock.calls.length).toBeGreaterThan(playCallsAfterFirstPlay);

  expect(fetchMock).not.toHaveBeenCalledWith("/api/jobs/job-1/activate", expect.anything());
  expect(fetchMock).not.toHaveBeenCalledWith("/api/jobs/job-1/pause", expect.anything());
  expect(fetchMock).not.toHaveBeenCalledWith("/api/jobs/job-1/playback", expect.anything());
  expect(fetchMock).toHaveBeenCalledWith("/api/jobs/job-1/chunks/init");
  expect(anchorClickSpy).toHaveBeenCalled();

  createObjectUrlSpy.mockRestore();
  revokeObjectUrlSpy.mockRestore();
  anchorClickSpy.mockRestore();
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
      voice_id: "suzy",
      segment_url: "/api/jobs/job-1/chunks/0",
    },
    {
      index: 1,
      status: "written",
      duration_seconds: 4,
      start_seconds: 4,
      plan_version: 1,
      voice_id: "suzy",
      segment_url: "/api/jobs/job-1/chunks/1",
    },
    {
      index: 2,
      status: "written",
      duration_seconds: 4,
      start_seconds: 8,
      plan_version: 1,
      voice_id: "suzy",
      segment_url: "/api/jobs/job-1/chunks/2",
    },
    {
      index: 3,
      status: "queued",
      duration_seconds: 0,
      start_seconds: 0,
      plan_version: 1,
      voice_id: "suzy",
      segment_url: null,
    },
    {
      index: 4,
      status: "rendering",
      duration_seconds: 0,
      start_seconds: 0,
      plan_version: 1,
      voice_id: "suzy",
      segment_url: null,
    },
    {
      index: 5,
      status: "written",
      duration_seconds: 4,
      start_seconds: 20,
      plan_version: 1,
      voice_id: "suzy",
      segment_url: "/api/jobs/job-1/chunks/5",
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
