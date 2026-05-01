import { act, render, screen, waitFor } from "@testing-library/react";

import { App } from "./App";
import { useAppStore } from "../state/store";

class MockWebSocket extends EventTarget {
  static latest: MockWebSocket | null = null;
  readyState = 1;

  constructor() {
    super();
    MockWebSocket.latest = this;
    queueMicrotask(() => this.dispatchEvent(new Event("open")));
  }

  close() {
    this.dispatchEvent(new Event("close"));
  }

  send() {}

  emit(payload: object) {
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(payload) }));
  }
}

test("jobs list updates from websocket events", async () => {
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
    lastEvent: null,
    setJobs: useAppStore.getState().setJobs,
    setVoices: useAppStore.getState().setVoices,
    setAdminState: useAppStore.getState().setAdminState,
    setWebsocketStatus: useAppStore.getState().setWebsocketStatus,
    applyEvent: useAppStore.getState().applyEvent,
  });

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

  render(<App />);

  await waitFor(() => expect(MockWebSocket.latest).not.toBeNull());
  act(() => {
    MockWebSocket.latest?.emit({
      type: "job_created",
      payload: {
        job: {
          id: "job-live",
          title: "Live job",
          status: "queued",
          voice_id: "suzy",
          model_id: "qwen3-tts-0.6b",
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
