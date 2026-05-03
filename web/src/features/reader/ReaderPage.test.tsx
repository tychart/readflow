import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";

import { ReaderPage } from "./ReaderPage";
import { useAppStore } from "../../state/store";

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
  await user.click(screen.getByRole("button", { name: /play/i }));
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
  await user.click(screen.getByRole("button", { name: /play/i }));

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
