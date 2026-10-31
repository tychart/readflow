import { render, screen, act, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { AdminPage } from "./AdminPage";
import { useAppStore } from "../../state/store";
import type { AdminMemoryStats, AdminState } from "../../types/events";

/** AdminState fixture with VRAM data */
const GPU_ADMIN_STATE = {
  config: {
    device: "auto",
    idle_unload_seconds: 300,
    max_prebuffer_seconds: 300,
    render_ahead_seconds: 0,
    active_listener_timeout_seconds: 60,
    target_buffer_seconds: 60,
    plan_ahead_chunks: 16,
    batch_candidates_small_model: [8, 7, 6, 5],
    batch_candidates_large_model: [6, 5, 4, 3],
    vram_soft_limit_mb: 9000,
    vram_hard_limit_mb: 11000,
    chunk_max_attempts: 3,
    model_load_timeout_seconds: 900,
    synthesis_timeout_seconds: 300,
    model_residency_batches: 10,
    voice_residency_batches: 3,
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
    vram_total_mb: 12288,
    vram_used_mb: 10240,
    vram_reserved_mb: 2048,
    vram_allocated_mb: 1536,
    vram_free_mb: 2048,
    ram_total_mb: 65536,
    ram_available_mb: 31744,
    ram_used_mb: 33792,
    ram_process_mb: 2048,
    ram_cgroup_used_mb: null,
    ram_cgroup_limit_mb: null,
  },
} satisfies AdminState;

const CPU_ADMIN_STATE = {
  ...GPU_ADMIN_STATE,
  memory: {
    ...GPU_ADMIN_STATE.memory,
    device: "cpu",
    vram_total_mb: null,
    vram_used_mb: null,
    vram_reserved_mb: null,
    vram_allocated_mb: null,
    vram_free_mb: null,
  },
} satisfies AdminState;

function mockFetch() {
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
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
    if (url.endsWith("/api/admin/queue")) {
      return {
        ok: true,
        json: async () => ({
          generated_at: 0,
          queue_depth: 0,
          active_batch: null,
          next_batch: null,
          items: [],
        }),
      };
    }
    if (url.endsWith("/api/admin/config")) {
      return {
        ok: true,
        json: async () => ({
          idle_unload_seconds: 120,
          max_prebuffer_seconds: 300,
    render_ahead_seconds: 0,
    active_listener_timeout_seconds: 60,
          plan_ahead_chunks: 16,
          target_buffer_seconds: 60,
          batch_candidates_small_model: [8, 7, 6, 5],
          batch_candidates_large_model: [6, 5, 4, 3],
          vram_soft_limit_mb: 9000,
          vram_hard_limit_mb: 11000,
          chunk_max_attempts: 3,
          model_load_timeout_seconds: 900,
          synthesis_timeout_seconds: 300,
          model_residency_batches: 10,
          voice_residency_batches: 3,
        }),
      };
    }
    return { ok: true, json: async () => ({ status: "warm" }) };
  }) as unknown as typeof fetch;
}

function setStoreWithAdminState(
  adminState: AdminState,
  memory: AdminMemoryStats | null = null,
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

  expect(screen.getByText("10 GiB")).toBeInTheDocument();
  expect(screen.getByText("used of 12 GiB (83%)")).toBeInTheDocument();
  expect(screen.getByRole("meter", { name: "ReadFlow (PyTorch reserved)" })).toHaveAttribute("aria-valuetext", "2 GiB used of 12 GiB");
  expect(screen.getByText("Active tensors: 1.5 GiB")).toBeInTheDocument();
  expect(screen.getByText("Free on device: 2 GiB")).toBeInTheDocument();
  expect(screen.getByRole("meter", { name: "GPU VRAM usage" })).toHaveAttribute("aria-valuenow", "10240");
});

test("renders memory section with CPU fallback", () => {
  setStoreWithAdminState(CPU_ADMIN_STATE, CPU_ADMIN_STATE.memory);

  render(<AdminPage />);

  expect(screen.getByText(/GPU statistics unavailable/)).toBeInTheDocument();
  expect(screen.queryByRole("meter", { name: "GPU VRAM usage" })).not.toBeInTheDocument();
  expect(screen.getByText("cpu")).toBeInTheDocument();
  expect(screen.getByRole("meter", { name: "ReadFlow server (RSS)" })).toHaveAttribute("aria-valuetext", "2 GiB used of 64 GiB");
});

test("renders 'unavailable' when memory is null", () => {
  setStoreWithAdminState(GPU_ADMIN_STATE, null);

  render(<AdminPage />);

  expect(
    screen.getByText("Memory stats unavailable."),
  ).toBeInTheDocument();
});

test("renders admin telemetry and saves config", async () => {
  const user = userEvent.setup();
  mockFetch();
  setStoreWithAdminState(GPU_ADMIN_STATE, GPU_ADMIN_STATE.memory);

  render(<AdminPage />);

  await user.clear(screen.getByLabelText(/Idle unload/i));
  await user.type(screen.getByLabelText(/Idle unload/i), "120");
  await user.click(screen.getByRole("button", { name: /save config/i }));

  // Batch info now appears in the Synthesis card
  expect(screen.getByText(/4 chunks/)).toBeInTheDocument();
  expect(screen.getByText(/0\.8s/)).toBeInTheDocument();
  expect(globalThis.fetch).toHaveBeenCalledWith("/api/admin/config", expect.any(Object));
});

test("form does not reset when adminState changes via WebSocket", () => {
  mockFetch();
  setStoreWithAdminState(GPU_ADMIN_STATE, GPU_ADMIN_STATE.memory);

  render(<AdminPage />);

  // Verify idle_unload default value is loaded into the form
  const input = screen.getByLabelText(/Idle unload/i) as HTMLInputElement;
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

  render(<AdminPage />);

  const input = screen.getByLabelText(/Idle unload/i) as HTMLInputElement;
  expect(input.value).toBe("300");

  // Simulate a WebSocket admin_config_updated event
  act(() => {
    useAppStore.getState().applyEvent({
      type: "admin_config_updated",
      payload: {
        device: "cpu",
        idle_unload_seconds: 600,
        max_prebuffer_seconds: 300,
    render_ahead_seconds: 0,
    active_listener_timeout_seconds: 60,
        target_buffer_seconds: 60,
        plan_ahead_chunks: 16,
        batch_candidates_small_model: [4, 3, 2, 1],
        batch_candidates_large_model: [3, 2, 1],
        vram_soft_limit_mb: 4000,
        vram_hard_limit_mb: 6000,
        chunk_max_attempts: 3,
        model_load_timeout_seconds: 900,
        synthesis_timeout_seconds: 300,
        model_residency_batches: 10,
        voice_residency_batches: 3,
      },
    });
  });

  // The form should NOT have reset to 600 because hasInitialized guard
  expect(input.value).toBe("300");
});

test("defaults to the Overview tab", () => {
  mockFetch();
  setStoreWithAdminState(GPU_ADMIN_STATE, GPU_ADMIN_STATE.memory);

  render(<AdminPage />);

  expect(screen.getByRole("tab", { name: "Overview" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  expect(screen.getByRole("tab", { name: "Queue" })).toHaveAttribute(
    "aria-selected",
    "false",
  );
  expect(screen.getByLabelText(/Idle unload/i)).toBeInTheDocument();
});

test("switches to the Queue tab and back to Overview", async () => {
  const user = userEvent.setup();
  mockFetch();
  setStoreWithAdminState(GPU_ADMIN_STATE, GPU_ADMIN_STATE.memory);

  render(<AdminPage />);

  await user.click(screen.getByRole("tab", { name: "Queue" }));

  expect(screen.getByRole("tab", { name: "Queue" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  expect(await screen.findByText(/Nothing queued/i)).toBeInTheDocument();
  expect(screen.getByRole("tabpanel")).toHaveAttribute("id", "admin-panel-queue");

  await user.click(screen.getByRole("tab", { name: "Overview" }));

  expect(screen.getByLabelText(/Idle unload/i)).toBeInTheDocument();
  expect(screen.queryByText(/Nothing queued/i)).not.toBeInTheDocument();
});

test("tabs expose tablist semantics and support arrow-key navigation", async () => {
  const user = userEvent.setup();
  mockFetch();
  setStoreWithAdminState(GPU_ADMIN_STATE, GPU_ADMIN_STATE.memory);

  render(<AdminPage />);

  expect(screen.getByRole("tablist", { name: /admin sections/i })).toBeInTheDocument();

  const overviewTab = screen.getByRole("tab", { name: "Overview" });
  overviewTab.focus();
  await user.keyboard("{ArrowRight}");

  expect(screen.getByRole("tab", { name: "Queue" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
});

test("edits and saves the plan-ahead window setting", async () => {
  const user = userEvent.setup();
  mockFetch();
  setStoreWithAdminState(GPU_ADMIN_STATE, GPU_ADMIN_STATE.memory);

  render(<AdminPage />);

  const input = screen.getByLabelText(/Plan-ahead window/i) as HTMLInputElement;
  expect(input.value).toBe("16");

  await user.clear(input);
  await user.type(input, "4");
  expect(input.value).toBe("4");

  await user.click(screen.getByRole("button", { name: /Save config/i }));

  await waitFor(() =>
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "/api/admin/config",
      expect.objectContaining({ method: "POST" }),
    ),
  );
});

test("surfaces scheduler liveness and the last error", () => {
  setStoreWithAdminState(
    {
      ...GPU_ADMIN_STATE,
      scheduler: {
        queue_depth: 2,
        batch_candidates: [8, 7, 6, 5],
        running: false,
        last_tick_at: Date.now() / 1000 - 30,
        last_error: "RuntimeError: boom",
        consecutive_errors: 2,
        warning: "VRAM hard limit reached (12000 MB >= 11000 MB); dispatch paused.",
        vram_per_chunk_mb: 670,
      },
      model_last_error: "Synthesis timed out after 300s",
    },
    GPU_ADMIN_STATE.memory,
  );

  render(<AdminPage />);

  expect(screen.getByText(/Scheduler stopped/)).toBeInTheDocument();
  expect(screen.getByText(/2 consecutive errors/)).toBeInTheDocument();
  expect(screen.getByText(/Last scheduler error: RuntimeError: boom/)).toBeInTheDocument();
  expect(screen.getByText(/670 MiB\/chunk/)).toBeInTheDocument();
  expect(screen.getByText(/VRAM hard limit reached/)).toBeInTheDocument();
  expect(screen.getByText(/Model error: Synthesis timed out after 300s/)).toBeInTheDocument();
});

test("reset provider button calls the reset endpoint", async () => {
  const user = userEvent.setup();
  mockFetch();
  setStoreWithAdminState(GPU_ADMIN_STATE, GPU_ADMIN_STATE.memory);

  render(<AdminPage />);

  await user.click(screen.getByRole("button", { name: /reset provider/i }));

  await waitFor(() =>
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "/api/admin/model/reset",
      expect.objectContaining({ method: "POST" }),
    ),
  );
});


test("shows whole-system RAM pressure separately from ReadFlow's RSS", () => {
  setStoreWithAdminState(GPU_ADMIN_STATE, GPU_ADMIN_STATE.memory);
  render(<AdminPage />);

  expect(screen.getByText("33 GiB")).toBeInTheDocument();
  expect(screen.getByText("used of 64 GiB (52%)")).toBeInTheDocument();
  expect(screen.getByText("Available to the system: 31 GiB")).toBeInTheDocument();
  expect(screen.getByRole("meter", { name: "ReadFlow server (RSS)" })).toHaveAttribute("aria-valuetext", "2 GiB used of 64 GiB");
  const meter = screen.getByRole("meter", { name: "System RAM usage" });
  expect(meter).toHaveAttribute("aria-valuenow", "33792");
  expect(meter).toHaveAttribute("aria-valuemax", "65536");
  expect(meter.firstElementChild).toHaveStyle({ width: "51.5625%" });
  expect(screen.queryByText(/Container \/ cgroup:/)).not.toBeInTheDocument();
});

test.each(["unloaded", "cpu", "loading", "evicting"])(
  "keeps device-wide GPU usage visible while the model is %s",
  (device) => {
    setStoreWithAdminState(GPU_ADMIN_STATE, { ...GPU_ADMIN_STATE.memory, device });
    render(<AdminPage />);
    expect(screen.getByText("used of 12 GiB (83%)")).toBeInTheDocument();
    expect(screen.getByRole("meter", { name: "GPU VRAM usage" })).toHaveAttribute("aria-valuenow", "10240");
  },
);

test("shows a tighter container budget without substituting it for the host RAM", () => {
  setStoreWithAdminState(GPU_ADMIN_STATE, {
    ...GPU_ADMIN_STATE.memory,
    ram_cgroup_used_mb: 2048,
    ram_cgroup_limit_mb: 4096,
  });
  render(<AdminPage />);

  expect(screen.getByText("used of 64 GiB (52%)")).toBeInTheDocument();
  expect(screen.getByText("Container / cgroup: 2 GiB used of 4 GiB limit (includes cache)")).toBeInTheDocument();
  expect(screen.getByText(/Linux VM on Docker Desktop/)).toBeInTheDocument();
});

test("updates system and process readings live without resetting the config form", () => {
  setStoreWithAdminState(GPU_ADMIN_STATE, GPU_ADMIN_STATE.memory);
  render(<AdminPage />);

  act(() => useAppStore.getState().applyEvent({
    type: "memory_stats",
    payload: { memory: {
      ...GPU_ADMIN_STATE.memory,
      ram_used_mb: 40960,
      ram_available_mb: 24576,
      ram_process_mb: 3072,
      vram_used_mb: 11264,
      vram_free_mb: 1024,
    } },
  }));

  expect(screen.getByText("40 GiB")).toBeInTheDocument();
  expect(screen.getByRole("meter", { name: "ReadFlow server (RSS)" })).toHaveAttribute("aria-valuetext", "3 GiB used of 64 GiB");
  expect(screen.getByText("11 GiB")).toBeInTheDocument();
  expect(screen.getByLabelText(/Idle unload/)).toHaveValue(300);
});

test("clears stale measurements when the monitor reports a failure", () => {
  setStoreWithAdminState(GPU_ADMIN_STATE, GPU_ADMIN_STATE.memory);
  render(<AdminPage />);

  act(() => useAppStore.getState().applyEvent({
    type: "memory_stats",
    payload: { memory: null },
  }));

  expect(screen.getByText("Memory stats unavailable.")).toBeInTheDocument();
  expect(screen.queryByRole("meter")).not.toBeInTheDocument();
});


test("compares ReadFlow and system usage with separately labeled bars on the same scale", () => {
  setStoreWithAdminState(GPU_ADMIN_STATE, GPU_ADMIN_STATE.memory);
  render(<AdminPage />);

  const system = screen.getByRole("meter", { name: "System RAM usage" });
  const process = screen.getByRole("meter", { name: "ReadFlow server (RSS)" });
  expect(process).toHaveAttribute("aria-valuemax", system.getAttribute("aria-valuemax"));
  expect(process).toHaveAttribute("aria-valuenow", "2048");
  expect(process.firstElementChild).toHaveStyle({ width: "3.125%", backgroundColor: "var(--amber)" });
  expect(system.firstElementChild).toHaveStyle({ width: "51.5625%", backgroundColor: "var(--emerald)" });
  expect(screen.getByText("of 64 GiB capacity (3%)")).toBeInTheDocument();

  const gpu = screen.getByRole("meter", { name: "GPU VRAM usage" });
  const allocator = screen.getByRole("meter", { name: "ReadFlow (PyTorch reserved)" });
  expect(allocator).toHaveAttribute("aria-valuemax", gpu.getAttribute("aria-valuemax"));
  expect(allocator).toHaveAttribute("aria-valuenow", "2048");
  expect(screen.getByText("of 12 GiB capacity (17%)")).toBeInTheDocument();
  expect(screen.getByText(/Both use the same capacity scale/)).toBeInTheDocument();
});
