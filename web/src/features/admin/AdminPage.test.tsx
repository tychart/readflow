import { render, screen, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { AdminPage } from "./AdminPage";
import { useAppStore } from "../../state/store";

/** AdminState fixture with VRAM data */
const GPU_ADMIN_STATE = {
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
    queue_depth: 2,
    batch_candidates: [8, 7, 6, 5],
  },
  telemetry: {
    queue_depth: 2,
    model_state: "warm_idle",
    idle_deadline: null,
    oom_count: 0,
    recent_batches: [
      {
        batch_size: 4,
        duration_seconds: 0.8,
        reserved_vram_mb: 3600,
        allocated_vram_mb: 2900,
        at: Date.now(),
      },
    ],
    recent_events: [],
  },
  memory: {
    device: "cuda",
    vram_total_mb: 24000,
    vram_used_mb: 6000,
    vram_reserved_mb: 8000,
    vram_free_mb: 18000,
    ram_total_mb: 32000,
    ram_free_mb: 16000,
    ram_used_mb: 16000,
  },
} as const;

const CPU_ADMIN_STATE = {
  ...GPU_ADMIN_STATE,
  memory: {
    device: "cpu",
    vram_total_mb: 0,
    vram_used_mb: 0,
    vram_reserved_mb: 0,
    vram_free_mb: 0,
    ram_total_mb: 32000,
    ram_free_mb: 16000,
    ram_used_mb: 16000,
  },
} as const;

function mockFetch() {
  global.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/api/jobs")) {
      return { ok: true, json: async () => [] };
    }
    if (url.endsWith("/api/voices")) {
      return { ok: true, json: async () => [] };
    }
    if (url.endsWith("/api/admin/state")) {
      return {
        ok: true,
        json: async () => useAppStore.getState().adminState,
      };
    }
    if (url.endsWith("/api/admin/config")) {
      return {
        ok: true,
        json: async () => ({
          idle_unload_seconds: 120,
          max_prebuffer_seconds: 300,
          target_buffer_seconds: 45,
          batch_candidates_small_model: [8, 7, 6, 5],
          batch_candidates_large_model: [6, 5, 4, 3],
          vram_soft_limit_mb: 9000,
          vram_hard_limit_mb: 11000,
        }),
      };
    }
    return { ok: true, json: async () => ({ status: "warm" }) };
  }) as typeof fetch;
}

function setStoreWithAdminState(
  adminState: Record<string, unknown>,
  memory: Record<string, unknown> | null = null,
) {
  useAppStore.setState({
    jobs: {},
    voices: [],
    websocketStatus: "open",
    lastSocketMessageAt: Date.now(),
    lastSocketError: null,
    reconnectAttempt: 0,
    isSocketStale: false,
    lastEvent: null,
    adminState: { ...adminState, memory },
    setJobs: useAppStore.getState().setJobs,
    setVoices: useAppStore.getState().setVoices,
    setAdminState: useAppStore.getState().setAdminState,
    setSocketState: useAppStore.getState().setSocketState,
    applyEvent: useAppStore.getState().applyEvent,
  });
}

test("shows loading state when adminState is null", () => {
  useAppStore.setState({ adminState: null });

  render(<AdminPage />);

  expect(screen.getByText(/loading admin state/i)).toBeInTheDocument();
});

test("renders memory section with VRAM stats", () => {
  setStoreWithAdminState(GPU_ADMIN_STATE, GPU_ADMIN_STATE.memory);

  render(<AdminPage />);

  // VRAM value appears in both the stats display and the legend text below
  const vramElements = screen.getAllByText(/6000 MB/);
  expect(vramElements.length).toBeGreaterThanOrEqual(1);
  expect(screen.getByText(/18000 MB free/)).toBeInTheDocument();
  expect(screen.getByText(/24000 MB total/)).toBeInTheDocument();
  expect(screen.getByText(/cuda/)).toBeInTheDocument();
});

test("renders memory section with CPU fallback", () => {
  setStoreWithAdminState(CPU_ADMIN_STATE, CPU_ADMIN_STATE.memory);

  render(<AdminPage />);

  // CPU mode shows "N/A" for VRAM
  const vramLabels = screen.getAllByText(/N\/A/);
  expect(vramLabels.length).toBeGreaterThanOrEqual(2);
  expect(screen.getByText(/cpu/)).toBeInTheDocument();
});

test("renders 'unavailable' when memory is null", () => {
  setStoreWithAdminState(GPU_ADMIN_STATE, null);

  render(<AdminPage />);

  expect(
    screen.getByLabelText(/memory stats unavailable/i),
  ).toBeInTheDocument();
});

test("renders admin telemetry and saves config", async () => {
  const user = userEvent.setup();
  mockFetch();
  setStoreWithAdminState(GPU_ADMIN_STATE, GPU_ADMIN_STATE.memory);

  render(<AdminPage />);

  await user.clear(screen.getByLabelText(/idle unload seconds/i));
  await user.type(screen.getByLabelText(/idle unload seconds/i), "120");
  await user.click(screen.getByRole("button", { name: /save config/i }));

  expect(screen.getByText(/batch size: 4/i)).toBeInTheDocument();
  expect(global.fetch).toHaveBeenCalledWith("/api/admin/config", expect.any(Object));
});

test("form does not reset when adminState changes via WebSocket", () => {
  mockFetch();
  setStoreWithAdminState(GPU_ADMIN_STATE, GPU_ADMIN_STATE.memory);

  render(<AdminPage />);

  // Verify idle_unload default value is loaded into the form
  const input = screen.getByLabelText(/idle unload seconds/i) as HTMLInputElement;
  expect(input.value).toBe("300");

  // Simulate a WebSocket telemetry update (new adminState reference, same config)
  act(() => {
    useAppStore.getState().applyEvent({
      type: "telemetry",
      payload: {
        telemetry: {
          queue_depth: 5,
          model_state: "busy",
          idle_deadline: 99999,
          oom_count: 0,
          recent_batches: [],
          recent_events: [],
        },
      },
    });
  });

  // Form field should STILL be 300 (not reset by the WebSocket event)
  expect(input.value).toBe("300");
});

test("form initializes from adminState.config once", () => {
  mockFetch();
  setStoreWithAdminState(GPU_ADMIN_STATE, GPU_ADMIN_STATE.memory);

  const { rerender } = render(<AdminPage />);

  const input = screen.getByLabelText(/idle unload seconds/i) as HTMLInputElement;
  expect(input.value).toBe("300");

  // Simulate a WebSocket admin_config_updated event
  act(() => {
    useAppStore.getState().applyEvent({
      type: "admin_config_updated",
      payload: {
        device: "cpu",
        idle_unload_seconds: 600,
        max_prebuffer_seconds: 300,
        target_buffer_seconds: 45,
        batch_candidates_small_model: [4, 3, 2, 1],
        batch_candidates_large_model: [3, 2, 1],
        vram_soft_limit_mb: 4000,
        vram_hard_limit_mb: 6000,
      },
    });
  });

  // The form should NOT have reset to 600 because hasInitialized guard
  expect(input.value).toBe("300");
});
