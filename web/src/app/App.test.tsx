import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

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

/** jsdom does not implement window.scrollY; provide it as a plain value. */
function setScrollY(value: number) {
  Object.defineProperty(window, "scrollY", {
    configurable: true,
    value,
    writable: true,
  });
}

/** The expanded-brand link that contains the lockup image. */
function lockupBrandLink(): HTMLElement {
  const lockup = screen.getByAltText(/turn your reading into listening/i);
  const link = lockup.closest("a");
  expect(link).not.toBeNull();
  return link as HTMLElement;
}

function seedStore() {
  useAppStore.setState({
    jobs: {},
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
  setScrollY(0);
  MockWebSocket.instances = [];
  MockWebSocket.latest = null;
  vi.stubGlobal("WebSocket", MockWebSocket);
  // Stub matchMedia for useTheme hook (not available in jsdom)
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
  global.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/api/jobs")) {
      return {
        ok: true,
        json: async () => [
          {
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
          },
        ],
      };
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
  expect(await screen.findByText(/just now/i)).toBeInTheDocument();

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

  expect(await screen.findByText(/reconnecting #1/i)).toBeInTheDocument();

  await waitFor(() => expect(MockWebSocket.instances).toHaveLength(2), {
    timeout: 2_500,
  });
  await waitFor(() => expect(screen.getByText(/just now/i)).toBeInTheDocument(), {
    timeout: 2_500,
  });
});

test("unknown routes redirect to the jobs page", async () => {
  window.history.pushState({}, "", "/this-page-does-not-exist");

  await act(async () => {
    render(<App />);
    await Promise.resolve();
  });

  // The catch-all redirect replaces the bad URL and lands on the jobs page.
  expect(await screen.findByText("Live job")).toBeInTheDocument();
  expect(window.location.pathname).toBe("/");
});

test("clicking the brand navigates back to the jobs page", async () => {
  const user = userEvent.setup();
  window.history.pushState({}, "", "/admin");

  await act(async () => {
    render(<App />);
    await Promise.resolve();
  });

  expect(window.location.pathname).toBe("/admin");

  await user.click(screen.getByRole("link", { name: "ReadFlow home" }));

  await waitFor(() => expect(window.location.pathname).toBe("/"));
  expect(await screen.findByText("Live job")).toBeInTheDocument();
});

test("jobs page navbar is expanded with the full lockup at the top", async () => {
  await act(async () => {
    render(<App />);
    await Promise.resolve();
  });

  expect(screen.getByTestId("navbar")).toHaveStyle({ height: "96px" });
  expect(lockupBrandLink()).toHaveAttribute("aria-hidden", "false");
  // Nav tabs stay visible even while the navbar is expanded.
  expect(screen.getByRole("link", { name: "Jobs" })).toBeVisible();
  expect(screen.getByRole("link", { name: "Admin" })).toBeVisible();
});

test("navbar shrinks smoothly with scroll and collapses to icon + wordmark", async () => {
  await act(async () => {
    render(<App />);
    await Promise.resolve();
  });

  // Halfway through the shrink range → lerped intermediate height.
  setScrollY(110);
  act(() => {
    window.dispatchEvent(new Event("scroll"));
  });
  expect(screen.getByTestId("navbar")).toHaveStyle({ height: "76px" });

  // Fully scrolled → compact height; lockup hidden, compact row announced.
  setScrollY(300);
  act(() => {
    window.dispatchEvent(new Event("scroll"));
  });
  expect(screen.getByTestId("navbar")).toHaveStyle({ height: "56px" });
  expect(lockupBrandLink()).toHaveAttribute("aria-hidden", "true");
  expect(screen.getByText("ReadFlow")).toBeInTheDocument();
});

test("non-jobs pages keep the compact navbar", async () => {
  window.history.pushState({}, "", "/admin");

  await act(async () => {
    render(<App />);
    await Promise.resolve();
  });

  expect(screen.getByTestId("navbar")).toHaveStyle({ height: "56px" });
  expect(lockupBrandLink()).toHaveAttribute("aria-hidden", "true");
});
