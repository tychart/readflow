import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, vi } from "vitest";

import { QueueInspector } from "./QueueInspector";
import { useAppStore } from "../../state/store";
import type {
  AdminQueue,
  AdminState,
  QueueChunk,
  QueueJobGroup,
  SchedulerState,
  Voice,
} from "../../types/api";

/* ── Fixtures ─────────────────────────────────────────────── */

const NOW = 1_700_000_000;

function buildChunk(overrides: Partial<QueueChunk> = {}): QueueChunk {
  return {
    job_id: "job-1",
    job_title: "Chapter One",
    job_status: "playing",
    job_is_active_listening: true,
    job_buffered_seconds: 12.5,
    job_target_buffer_seconds: 45,
    index: 3,
    version: 0,
    status: "planned",
    plan_version: 1,
    voice_id: "suzy",
    language: "English",
    model_id: "Qwen/Qwen3-TTS-12Hz-0.6B-Base",
    text: "The first chunk of text.",
    char_start: 0,
    char_end: 25,
    char_count: 25,
    estimated_duration_seconds: 1.4,
    duration_seconds: 0,
    start_seconds: 0,
    priority_band: 0,
    priority_label: "Urgent",
    priority_reason: "Active listener with 12.5s buffered (below 45s target).",
    rank: 1,
    is_pending: true,
    is_rendering: false,
    in_next_batch: true,
    created_at: NOW - 30,
    updated_at: NOW - 5,
    error: null,
    versions: [{ version: 0, status: "planned", deprecated: false }],
    ...overrides,
  };
}

function buildGroup(overrides: Partial<QueueJobGroup> = {}): QueueJobGroup {
  const chunks =
    overrides.chunks ??
    [
      buildChunk({
        index: 0,
        status: "written",
        is_pending: false,
        rank: 0,
        text: "An already written chunk.",
        duration_seconds: 12.4,
        versions: [{ version: 0, status: "written", deprecated: false }],
      }),
      buildChunk(),
      buildChunk({ index: 4, rank: 2, text: "Second pending chunk." }),
    ];
  return {
    job_id: "job-1",
    job_title: "Chapter One",
    job_status: "playing",
    job_is_active_listening: true,
    job_buffered_seconds: 12.5,
    job_target_buffer_seconds: 45,
    model_id: "Qwen/Qwen3-TTS-12Hz-0.6B-Base",
    language: "English",
    voice_id: "suzy",
    total_chunks: 3,
    written_chunks: 1,
    pending_chunks: 2,
    failed_chunks: 0,
    unplanned_chars: 1582,
    chunks_truncated: false,
    ...overrides,
    chunks,
  };
}

function buildQueue(overrides: Partial<AdminQueue> = {}): AdminQueue {
  return {
    generated_at: NOW,
    queue_depth: 2,
    active_batch: null,
    next_batch: null,
    jobs: [buildGroup()],
    ...overrides,
  };
}

const BASE_CONFIG = {
  device: "auto",
  idle_unload_seconds: 300,
  max_prebuffer_seconds: 300,
  target_buffer_seconds: 45,
  inactive_job_ahead_chunks: 1,
  batch_candidates_small_model: [8, 7, 6, 5],
  batch_candidates_large_model: [6, 5, 4, 3],
  vram_soft_limit_mb: 9000,
  vram_hard_limit_mb: 11000,
};

const BASE_SCHEDULER: SchedulerState = {
  queue_depth: 2,
  batch_candidates: [8, 7, 6, 5],
  active_batch: null,
};

function setStore({
  scheduler = BASE_SCHEDULER,
  voices = [],
}: { scheduler?: SchedulerState; voices?: Voice[] } = {}) {
  useAppStore.setState({
    adminState: {
      config: BASE_CONFIG,
      scheduler,
      telemetry: null,
      memory: null,
    } satisfies AdminState,
    voices,
  });
}

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body } as unknown as Response;
}

interface FetchCall {
  url: string;
  body: unknown;
}

function mockFetch(
  queue: AdminQueue,
  overrides: Record<string, () => Response> = {},
): FetchCall[] {
  const calls: FetchCall[] = [];
  global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, body: init?.body });
    for (const [suffix, make] of Object.entries(overrides)) {
      if (url.endsWith(suffix)) {
        return make();
      }
    }
    if (url.endsWith("/api/admin/queue")) {
      return jsonResponse(queue);
    }
    return jsonResponse({});
  }) as unknown as typeof fetch;
  return calls;
}

const originalFetch = global.fetch;

afterEach(() => {
  // Unmount first so the store reset below cannot update a live component
  // outside act and leak a warning into the next test.
  cleanup();
  global.fetch = originalFetch;
  vi.restoreAllMocks();
  useAppStore.setState({ adminState: null, voices: [] });
});

/** Render and flush the initial queue fetch so no state update lands outside act. */
async function renderInspector() {
  render(<QueueInspector />);
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function queueCalls(calls: FetchCall[]): FetchCall[] {
  return calls.filter((call) => call.url.endsWith("/api/admin/queue"));
}

/* ── Tests ────────────────────────────────────────────────── */

test("shows a loading state before the first fetch resolves", async () => {
  let resolveFetch: ((value: Response) => void) | undefined;
  global.fetch = vi.fn(
    () =>
      new Promise<Response>((resolve) => {
        resolveFetch = resolve;
      }),
  ) as unknown as typeof fetch;
  setStore();

  // Deliberately synchronous: the fetch never resolves until after the
  // loading assertion, so awaiting the flush here would hang.
  render(<QueueInspector />);

  expect(screen.getByText(/loading scheduler queue/i)).toBeInTheDocument();

  await act(async () => {
    resolveFetch?.(jsonResponse(buildQueue({ jobs: [], queue_depth: 0 })));
  });
});

test("renders the empty state when there are no jobs", async () => {
  mockFetch(buildQueue({ jobs: [], queue_depth: 0 }));
  setStore();

  await renderInspector();

  expect(screen.getByText(/nothing queued/i)).toBeInTheDocument();
});

test("renders the full chunk lifecycle for a job", async () => {
  mockFetch(buildQueue());
  setStore();

  await renderInspector();

  // Job header summary.
  expect(screen.getByText(/1\/3 written · 2 pending/)).toBeInTheDocument();
  expect(screen.getByText(/1,582 chars unplanned/)).toBeInTheDocument();
  // Written chunk is present with its duration, not a priority badge.
  expect(screen.getByText(/An already written chunk/i)).toBeInTheDocument();
  expect(screen.getByText("12.4s")).toBeInTheDocument();
  // Pending chunks are present with priority badges.
  expect(screen.getByText(/The first chunk of text/i)).toBeInTheDocument();
  expect(screen.getByText(/Second pending chunk/i)).toBeInTheDocument();
  expect(screen.getAllByText("Urgent")).toHaveLength(2);
  // Unplanned remainder footer.
  expect(screen.getByText(/more characters not yet planned/i)).toBeInTheDocument();
});

test("collapses and expands a job group", async () => {
  const user = userEvent.setup();
  mockFetch(buildQueue());
  setStore();

  await renderInspector();

  const header = screen.getByRole("button", { name: /Chapter One/ });
  expect(header).toHaveAttribute("aria-expanded", "true");

  await user.click(header);
  expect(header).toHaveAttribute("aria-expanded", "false");
  expect(screen.queryByText(/The first chunk of text/i)).not.toBeInTheDocument();

  await user.click(header);
  expect(screen.getByText(/The first chunk of text/i)).toBeInTheDocument();
});

test("shows the rendering batch while a batch is in flight", async () => {
  mockFetch(
    buildQueue({
      active_batch: {
        chunk_count: 2,
        model_id: "Qwen/Qwen3-TTS-12Hz-0.6B-Base",
        language: "English",
        voice_id: "suzy",
        started_at: Date.now() / 1000 - 3,
      },
    }),
  );
  setStore();

  await renderInspector();

  expect(screen.getByText(/Rendering now/i)).toBeInTheDocument();
  expect(screen.getByText(/2 chunks · voice suzy · English/)).toBeInTheDocument();
  expect(screen.getByText(/elapsed/i)).toBeInTheDocument();
});

test("shows the predicted next batch when nothing is rendering", async () => {
  mockFetch(
    buildQueue({
      next_batch: {
        chunk_count: 3,
        model_id: "Qwen/Qwen3-TTS-12Hz-0.6B-Base",
        language: "English",
        voice_id: "suzy",
        started_at: null,
      },
    }),
  );
  setStore();

  await renderInspector();

  expect(screen.getByText(/Up next/i)).toBeInTheDocument();
  expect(screen.getByText(/3 chunks · voice suzy · English/)).toBeInTheDocument();
  expect(screen.queryByText(/Rendering now/i)).not.toBeInTheDocument();
});

test("clicking a pending chunk reveals its text, priority, and metadata", async () => {
  const user = userEvent.setup();
  mockFetch(buildQueue());
  setStore();

  await renderInspector();

  await user.click(screen.getByRole("button", { name: /The first chunk of text/i }));

  expect(screen.getByText(/Active listener with 12.5s buffered/i)).toBeInTheDocument();
  expect(screen.getByText(/buffer 12.5s \/ target 45s/)).toBeInTheDocument();
  expect(screen.getByText(/Qwen3-TTS-12Hz-0.6B-Base/)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /Pause job/i })).toBeInTheDocument();
});

test("clicking a written chunk shows its audio duration instead of priority", async () => {
  const user = userEvent.setup();
  mockFetch(buildQueue());
  setStore();

  await renderInspector();

  await user.click(screen.getByRole("button", { name: /An already written chunk/i }));

  expect(screen.getByText(/Rendered audio · 12.4s/)).toBeInTheDocument();
  expect(screen.getByText(/Audio duration/i)).toBeInTheDocument();
  expect(screen.queryByText(/Active listener with 12.5s buffered/i)).not.toBeInTheDocument();
});

test("hides the detail sidebar until a chunk is selected", async () => {
  mockFetch(buildQueue());
  setStore();

  await renderInspector();

  expect(screen.queryByRole("complementary", { name: "Chunk details" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Close chunk details" })).not.toBeInTheDocument();
});

test("the close button dismisses the detail sidebar", async () => {
  const user = userEvent.setup();
  mockFetch(buildQueue());
  setStore();

  await renderInspector();
  await user.click(screen.getByRole("button", { name: /The first chunk of text/i }));
  expect(screen.getByRole("complementary", { name: "Chunk details" })).toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: "Close chunk details" }));

  expect(screen.queryByRole("complementary", { name: "Chunk details" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Close chunk details" })).not.toBeInTheDocument();
});

test("refetches the queue when the scheduler tick changes", async () => {
  const calls = mockFetch(buildQueue());
  setStore();

  await renderInspector();
  expect(queueCalls(calls)).toHaveLength(1);

  const current = useAppStore.getState().adminState as AdminState;
  act(() => {
    useAppStore.getState().setAdminState({
      ...current,
      scheduler: { ...BASE_SCHEDULER, queue_depth: 9 },
    });
  });

  await waitFor(() => expect(queueCalls(calls)).toHaveLength(2));
});

test("does not refetch when unrelated admin state changes", async () => {
  const calls = mockFetch(buildQueue());
  setStore();

  await renderInspector();

  const current = useAppStore.getState().adminState as AdminState;
  act(() => {
    useAppStore.getState().setAdminState({
      ...current,
      telemetry: {
        queue_depth: 2,
        model_state: "busy",
        idle_deadline: null,
        oom_count: 0,
        recent_batches: [],
        recent_events: [],
      },
    });
  });

  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(queueCalls(calls)).toHaveLength(1);
});

test("pause action calls the API and refetches", async () => {
  const user = userEvent.setup();
  const calls = mockFetch(buildQueue());
  setStore();

  await renderInspector();
  await user.click(screen.getByRole("button", { name: /The first chunk of text/i }));
  await user.click(screen.getByRole("button", { name: /Pause job/i }));

  await waitFor(() =>
    expect(calls.some((call) => call.url.endsWith("/api/jobs/job-1/pause"))).toBe(true),
  );
  expect(await screen.findByText(/Job paused/i)).toBeInTheDocument();
  await waitFor(() => expect(queueCalls(calls).length).toBeGreaterThanOrEqual(2));
});

test("offers resume for a paused job", async () => {
  const user = userEvent.setup();
  const calls = mockFetch(
    buildQueue({
      jobs: [
        buildGroup({
          job_status: "paused",
          chunks: [buildChunk({ job_status: "paused" })],
          total_chunks: 1,
          written_chunks: 0,
          pending_chunks: 1,
        }),
      ],
    }),
  );
  setStore();

  await renderInspector();
  await user.click(screen.getByRole("button", { name: /The first chunk of text/i }));
  await user.click(screen.getByRole("button", { name: /Resume job/i }));

  await waitFor(() =>
    expect(calls.some((call) => call.url.endsWith("/api/jobs/job-1/resume"))).toBe(true),
  );
  expect(await screen.findByText(/Job resumed/i)).toBeInTheDocument();
});

test("reprocess edits text and voice, then calls the API", async () => {
  const user = userEvent.setup();
  const calls = mockFetch(buildQueue());
  setStore({
    voices: [
      { id: "suzy", display_name: "Suzy", description: null },
      { id: "howard", display_name: "Howard", description: null },
    ],
  });

  await renderInspector();
  await user.click(screen.getByRole("button", { name: /The first chunk of text/i }));

  await user.click(screen.getByRole("button", { name: /Reprocess chunk/i }));
  const textarea = screen.getByLabelText(/Chunk text/i);
  expect(textarea).toHaveValue("The first chunk of text.");

  await user.clear(textarea);
  await user.type(textarea, "Rewritten chunk text.");
  await user.selectOptions(screen.getByLabelText(/^Voice$/i), "howard");
  await user.click(screen.getByRole("button", { name: /Queue reprocess/i }));

  await waitFor(() => {
    expect(calls.some((call) => call.url.endsWith("/api/jobs/job-1/chunks/3/reprocess"))).toBe(
      true,
    );
  });
  const reprocessCall = calls.find((call) =>
    call.url.endsWith("/api/jobs/job-1/chunks/3/reprocess"),
  );
  expect(JSON.parse(String(reprocessCall?.body))).toEqual({
    new_text: "Rewritten chunk text.",
    new_voice_id: "howard",
  });
});

test("set-active-version calls the API", async () => {
  const user = userEvent.setup();
  const queue = buildQueue({
    jobs: [
      buildGroup({
        chunks: [
          buildChunk({
            version: 1,
            versions: [
              { version: 0, status: "written", deprecated: true },
              { version: 1, status: "planned", deprecated: false },
            ],
          }),
        ],
        total_chunks: 1,
        written_chunks: 0,
        pending_chunks: 1,
      }),
    ],
  });
  const calls = mockFetch(queue);
  setStore();

  await renderInspector();
  await user.click(screen.getByRole("button", { name: /The first chunk of text/i }));
  await user.click(screen.getByRole("button", { name: /v0 · written/i }));

  await waitFor(() =>
    expect(
      calls.some((call) => call.url.endsWith("/api/jobs/job-1/chunks/3/set-active-version")),
    ).toBe(true),
  );
  expect(await screen.findByText(/Version 0 activated/i)).toBeInTheDocument();
});

test("surfaces action errors without crashing", async () => {
  const user = userEvent.setup();
  mockFetch(buildQueue(), {
    "/api/jobs/job-1/pause": () => jsonResponse({ detail: "Model exploded" }, false, 500),
  });
  setStore();

  await renderInspector();
  await user.click(screen.getByRole("button", { name: /The first chunk of text/i }));
  await user.click(screen.getByRole("button", { name: /Pause job/i }));

  expect(await screen.findByText(/Model exploded/i)).toBeInTheDocument();
});

test("surfaces queue load errors", async () => {
  global.fetch = vi.fn(async () => jsonResponse({ detail: "Backend offline" }, false, 503)) as unknown as typeof fetch;
  setStore();

  await renderInspector();

  expect(await screen.findByText(/Backend offline/i)).toBeInTheDocument();
  // A failed request must not be reported as an idle scheduler.
  expect(screen.getByText(/Queue unavailable/i)).toBeInTheDocument();
  expect(screen.queryByText(/Nothing queued/i)).not.toBeInTheDocument();
});
