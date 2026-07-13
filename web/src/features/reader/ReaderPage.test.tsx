import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
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

  // Stub AudioContext for useWaveformAnalyser (jsdom doesn't have it)
  if (typeof AudioContext === "undefined") {
    vi.stubGlobal("AudioContext", vi.fn().mockImplementation(() => ({
      createAnalyser: vi.fn().mockReturnValue({
        fftSize: 256,
        frequencyBinCount: 128,
        connect: vi.fn(),
        disconnect: vi.fn(),
        getFloatTimeDomainData: vi.fn(),
      }),
      createMediaElementSource: vi.fn().mockReturnValue({ connect: vi.fn(), disconnect: vi.fn() }),
      close: vi.fn().mockResolvedValue(undefined),
      state: "running",
    })));
  }
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

test("shows waiting copy when play is armed before the first chunk exists", async () => {
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

  // The Playbar shows "Preparing stream…" when waiting for first chunk
  expect(await screen.findByText(/Preparing stream/i)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Download not available" })).toBeDisabled();

  // After WS event with chunk data, the chunk counter updates
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

  const chunkCountElements = await screen.findAllByText(/ chunks/);
  expect(chunkCountElements.length).toBeGreaterThan(0);
  expect(screen.getByRole("button", { name: /pause/i })).toBeInTheDocument();
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

  // Should show buffering indicator when we hit the end of contiguous chunks
  expect(await screen.findByText(/Buffering/i)).toBeInTheDocument();
  expect(container.querySelector(".animate-spin")).not.toBeNull();
  expect(screen.getByRole("button", { name: "Pause" })).toBeInTheDocument();

  // Complete the job with the last chunk
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
    expect(screen.queryByText(/Buffering/i)).not.toBeInTheDocument(),
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
      expect(screen.getAllByText("4.5s").length).toBeGreaterThan(0),
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
