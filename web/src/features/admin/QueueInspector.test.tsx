import { act, cleanup, within, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, vi } from "vitest";

import { QueueInspector } from "./QueueInspector";
import { useAppStore } from "../../state/store";
import type { AdminQueue, AdminState, QueueChunk, SchedulerState, Voice } from "../../types/api";

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
    priority_band: 0,
    priority_label: "Urgent",
    priority_reason: "Active listener with 12.5s buffered (below 45s target).",
    rank: 1,
    is_rendering: false,
    in_next_batch: true,
    created_at: NOW - 30,
    updated_at: NOW - 5,
    error: null,
    versions: [{ version: 0, status: "planned", deprecated: false }],
    ...overrides,
  };
}

function buildQueue(overrides: Partial<AdminQueue> = {}): AdminQueue {
  return {
    generated_at: NOW,
    queue_depth: 2,
    active_batch: null,
    next_batch: null,
    items: [
      buildChunk(),
      buildChunk({
        job_id: "job-2",
        job_title: "Notes",
        index: 0,
        rank: 2,
        text: "Second chunk text.",
        voice_id: "howard",
        priority_band: 2,
        priority_label: "Normal",
        priority_reason: "Queued job with no active listener.",
        in_next_batch: false,
      }),
    ],
    ...overrides,
  };
}

const BASE_CONFIG = {
  device: "auto",
  idle_unload_seconds: 300,
  max_prebuffer_seconds: 300,
  target_buffer_seconds: 45,
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

function queueCalls(calls: FetchCall[]): FetchCall[] {
  return calls.filter((call) => call.url.endsWith("/api/admin/queue"));
}

/* ── Tests ────────────────────────────────────────────────── */

/** Render and flush the initial queue fetch so no state update lands outside act. */
async function renderInspector() {
  // `render` flushes passive effects as its own act exits, which kicks off the
  // initial queue fetch. Drain that promise chain in a following act so the
  // resulting state updates are covered.
  render(<QueueInspector />);
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}


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
    resolveFetch?.(jsonResponse(buildQueue({ items: [], queue_depth: 0 })));
  });
});

test("renders the empty state when nothing is queued", async () => {
  mockFetch(buildQueue({ items: [], queue_depth: 0 }));
  setStore();

  await renderInspector();

  expect(await screen.findByText(/nothing queued/i)).toBeInTheDocument();
});

test("renders pending chunks in priority-rank order", async () => {
  mockFetch(buildQueue());
  setStore();

  await renderInspector();

  const rows = await screen.findAllByRole("listitem");
  expect(rows).toHaveLength(2);
  expect(within(rows[0]).getByText(/The first chunk of text/i)).toBeInTheDocument();
  expect(within(rows[1]).getByText(/Second chunk text/i)).toBeInTheDocument();
  expect(within(rows[0]).getByText("Urgent")).toBeInTheDocument();
  expect(within(rows[1]).getByText("Normal")).toBeInTheDocument();
  expect(within(rows[0]).getByText("1")).toBeInTheDocument();
  expect(within(rows[1]).getByText("2")).toBeInTheDocument();
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

  expect(await screen.findByText(/Rendering now/i)).toBeInTheDocument();
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

  expect(await screen.findByText(/Up next/i)).toBeInTheDocument();
  expect(screen.getByText(/3 chunks · voice suzy · English/)).toBeInTheDocument();
  expect(screen.queryByText(/Rendering now/i)).not.toBeInTheDocument();
});

test("clicking a chunk reveals its text, priority, and metadata", async () => {
  const user = userEvent.setup();
  mockFetch(buildQueue());
  setStore();

  await renderInspector();

  const rows = await screen.findAllByRole("listitem");
  await user.click(within(rows[0]).getByRole("button"));

  expect(screen.getByText(/Active listener with 12.5s buffered/i)).toBeInTheDocument();
  expect(screen.getByText(/job buffer/i)).toBeInTheDocument();
  expect(screen.getByText(/Qwen3-TTS-12Hz-0.6B-Base/)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /Pause job/i })).toBeInTheDocument();

  // The selected row is marked for assistive tech.
  expect(within(rows[0]).getByRole("button")).toHaveAttribute("aria-current", "true");
});

test("falls back to the placeholder until a chunk is selected", async () => {
  mockFetch(buildQueue());
  setStore();

  await renderInspector();

  await screen.findAllByRole("listitem");
  expect(screen.getByText(/select a chunk to inspect/i)).toBeInTheDocument();
});

test("refetches the queue when the scheduler tick changes", async () => {
  const calls = mockFetch(buildQueue());
  setStore();

  await renderInspector();
  await screen.findByText(/The first chunk of text/i);
  expect(queueCalls(calls)).toHaveLength(1);

  const current = useAppStore.getState().adminState;
  act(() => {
    useAppStore.getState().setAdminState({
      ...(current as AdminState),
      scheduler: { ...BASE_SCHEDULER, queue_depth: 9 },
    });
  });

  await waitFor(() => expect(queueCalls(calls)).toHaveLength(2));
});

test("does not refetch when unrelated admin state changes", async () => {
  const calls = mockFetch(buildQueue());
  setStore();

  await renderInspector();
  await screen.findByText(/The first chunk of text/i);

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
  const rows = await screen.findAllByRole("listitem");
  await user.click(within(rows[0]).getByRole("button"));
  await user.click(screen.getByRole("button", { name: /Pause job/i }));

  await waitFor(() =>
    expect(calls.some((call) => call.url.endsWith("/api/jobs/job-1/pause"))).toBe(true),
  );
  expect(await screen.findByText(/Job paused/i)).toBeInTheDocument();
  await waitFor(() => expect(queueCalls(calls).length).toBeGreaterThanOrEqual(2));
});

test("offers resume for a paused job", async () => {
  const user = userEvent.setup();
  const calls = mockFetch(buildQueue({ items: [buildChunk({ job_status: "paused" })] }));
  setStore();

  await renderInspector();
  const rows = await screen.findAllByRole("listitem");
  await user.click(within(rows[0]).getByRole("button"));
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
  const rows = await screen.findAllByRole("listitem");
  await user.click(within(rows[0]).getByRole("button"));

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
    items: [
      buildChunk({
        version: 1,
        versions: [
          { version: 0, status: "written", deprecated: true },
          { version: 1, status: "planned", deprecated: false },
        ],
      }),
    ],
  });
  const calls = mockFetch(queue);
  setStore();

  await renderInspector();
  const rows = await screen.findAllByRole("listitem");
  await user.click(within(rows[0]).getByRole("button"));
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
  const rows = await screen.findAllByRole("listitem");
  await user.click(within(rows[0]).getByRole("button"));
  await user.click(screen.getByRole("button", { name: /Pause job/i }));

  expect(await screen.findByText(/Model exploded/i)).toBeInTheDocument();
  expect(within(rows[0]).getByRole("button")).toBeInTheDocument();
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
