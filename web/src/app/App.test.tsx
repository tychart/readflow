import { act, cleanup, render, screen, waitFor } from "@testing-library/react";

import { App } from "./App";
import { liveClient } from "../lib/live-client";
import { useAppStore } from "../state/store";

class MockWebSocket extends EventTarget {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances: MockWebSocket[] = [];
  static latest: MockWebSocket | null = null;

  readyState = MockWebSocket.CONNECTING;

  constructor() {
    super();
    MockWebSocket.instances.push(this);
    MockWebSocket.latest = this;
    queueMicrotask(() => {
      this.readyState = MockWebSocket.OPEN;
      this.dispatchEvent(new Event("open"));
    });
  }

  close() {
    this.readyState = MockWebSocket.CLOSED;
    this.dispatchEvent(new Event("close"));
  }

  send(payload: string) {
    if (payload === "ping") {
      queueMicrotask(() => this.emit({ type: "pong", payload: {} }));
    }
  }

  emit(payload: object) {
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(payload) }));
  }

  fail() {
    this.dispatchEvent(new Event("error"));
    this.close();
  }
}

function seedStore() {
  useAppStore.setState({
    jobs: [],
    voices: [],
    adminState: {
      config: {
        idle_unload_seconds: 300,
        max_prebuffer_seconds: 300,
        target_buffer_seconds: 45,
        batch_candidates_small_model: [8, 7, 6, 5],
        batch_candidates_large_model: [6, 5, 4, 3],
        vram_soft_limit_mb: 9000,
        vram_hard_limit_mb: 11000,
      },
      scheduler: {
        queue_depth: 0,
        batch_candidates: [8, 7, 6, 5],
      },
      telemetry: {
        queue_depth: 0,
        model_state: "unloaded",
        idle_deadline: null,
        oom_count: 0,
        recent_batches: [],
        recent_events: [],
      },
    },
    websocketStatus: "connecting",
    lastSocketMessageAt: null,
    lastSocketError: null,
    reconnectAttempt: 0,
    isSocketStale: false,
    lastEvent: null,
  });
}

beforeEach(() => {
  seedStore();
  MockWebSocket.instances = [];
  MockWebSocket.latest = null;
  vi.stubGlobal("WebSocket", MockWebSocket);
  global.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/api/jobs")) {
      return { ok: true, json: async () => [] };
    }
    if (url.endsWith("/api/voices")) {
      return { ok: true, json: async () => [] };
    }
    return {
      ok: true,
      json: async () => ({
        config: useAppStore.getState().adminState?.config,
        scheduler: useAppStore.getState().adminState?.scheduler,
        telemetry: useAppStore.getState().adminState?.telemetry,
      }),
    };
  }) as typeof fetch;
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
  liveClient.resetForTests();
  vi.unstubAllGlobals();
});

test("jobs list updates from websocket events and shows live connection state", async () => {
  await act(async () => {
    render(<App />);
    await Promise.resolve();
  });

  await waitFor(() => expect(MockWebSocket.latest).not.toBeNull());
  expect(await screen.findByText(/live open/i)).toBeInTheDocument();

  act(() => {
    MockWebSocket.latest?.emit({
      type: "job_created",
      payload: {
        job: {
          id: "job-live",
          title: "Live job",
          status: "queued",
          voice_id: "suzy",
          model_id: "Qwen/Qwen3-TTS-12Hz-0.6B-Base",
          is_active_listening: false,
          total_chunks_emitted: 1,
          total_chunks_completed: 0,
          buffered_seconds: 0,
          completed_seconds: 0,
          source_kind: "text",
          source_text: "hello",
          plan_version: 1,
          chunks: [],
          failed_reason: null,
        },
      },
    });
  });

  expect(await screen.findByText("Live job")).toBeInTheDocument();
});

test("socket reconnects and surfaces reconnecting state", async () => {
  await act(async () => {
    render(<App />);
    await Promise.resolve();
  });

  await waitFor(() => expect(MockWebSocket.latest).not.toBeNull());

  act(() => {
    MockWebSocket.latest?.fail();
  });

  expect(await screen.findByText(/live reconnecting/i)).toBeInTheDocument();

  await waitFor(() => expect(MockWebSocket.instances).toHaveLength(2), {
    timeout: 2_500,
  });
  await waitFor(() => expect(screen.getByText(/live open/i)).toBeInTheDocument(), {
    timeout: 2_500,
  });
});
