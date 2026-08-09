import { describe, expect, it, beforeEach } from "vitest";

import { useAppStore } from "./store";
import type { AdminConfig, AdminState, AdminMemoryStats } from "../types/events";

function setAdminState(memory: AdminMemoryStats | null) {
  useAppStore.setState({
    adminState: {
      config: {
        device: "auto",
        idle_unload_seconds: 300,
        max_prebuffer_seconds: 300,
        target_buffer_seconds: 45,
        batch_candidates_small_model: [8, 7, 6, 5, 4, 3, 2, 1],
        batch_candidates_large_model: [6, 5, 4, 3, 2, 1],
        vram_soft_limit_mb: 9000,
        vram_hard_limit_mb: 11000,
      },
      scheduler: { queue_depth: 1, batch_candidates: [8, 7, 6, 5] },
      telemetry: {
        queue_depth: 1,
        model_state: "warm_idle",
        idle_deadline: null,
        oom_count: 0,
        recent_batches: [],
        recent_events: [],
      },
      memory,
    },
  });
}

const EMPTY_CONFIG: AdminConfig = {
  device: "cpu",
  idle_unload_seconds: 300,
  max_prebuffer_seconds: 300,
  target_buffer_seconds: 45,
  batch_candidates_small_model: [],
  batch_candidates_large_model: [],
  vram_soft_limit_mb: 0,
  vram_hard_limit_mb: 0,
};

function makeAdminState(memory: AdminMemoryStats | null): AdminState {
  return {
    config: EMPTY_CONFIG,
    scheduler: { queue_depth: 0, batch_candidates: [] },
    telemetry: null,
    memory,
  };
}

const MEMORY: AdminMemoryStats = {
  device: "cuda",
  vram_total_mb: 24000,
  vram_used_mb: 6000,
  vram_reserved_mb: 8000,
  vram_free_mb: 16000,
  ram_total_mb: 32000,
  ram_free_mb: 16000,
  ram_used_mb: 16000,
};

const DIFFERENT_MEMORY: AdminMemoryStats = {
  device: "cuda",
  vram_total_mb: 24000,
  vram_used_mb: 9000,
  vram_reserved_mb: 12000,
  vram_free_mb: 12000,
  ram_total_mb: 32000,
  ram_free_mb: 12000,
  ram_used_mb: 20000,
};

describe("applyEvent — memory_stats", () => {
  beforeEach(() => {
    useAppStore.setState({
      adminState: null,
      jobs: {},
      voices: [],
      websocketStatus: "connecting",
      lastSocketMessageAt: null,
      lastSocketError: null,
      reconnectAttempt: 0,
      isSocketStale: false,
      lastEvent: null,
    });
  });

  it("updates adminState.memory on memory_stats event", () => {
    setAdminState(null);

    useAppStore.getState().applyEvent({
      type: "memory_stats",
      payload: { memory: MEMORY },
    });

    const state = useAppStore.getState();
    expect(state.adminState?.memory).toEqual(MEMORY);
  });

  it("does nothing when adminState is null (memory_stats event)", () => {
    useAppStore.getState().applyEvent({
      type: "memory_stats",
      payload: { memory: MEMORY },
    });

    expect(useAppStore.getState().adminState).toBeNull();
  });

  it("preserves adminState.memory on telemetry event", () => {
    setAdminState(MEMORY);

    useAppStore.getState().applyEvent({
      type: "telemetry",
      payload: {
        telemetry: {
          queue_depth: 2,
          model_state: "busy",
          idle_deadline: 1000,
          oom_count: 0,
          recent_batches: [],
          recent_events: [],
        },
      },
    });

    const state = useAppStore.getState();
    expect(state.adminState?.memory).toEqual(MEMORY);
    expect(state.adminState?.telemetry.model_state).toBe("busy");
  });

  it("preserves adminState.memory on scheduler_state event", () => {
    setAdminState(MEMORY);

    useAppStore.getState().applyEvent({
      type: "scheduler_state",
      payload: { queue_depth: 5, batch_candidates: [8, 7, 6] },
    });

    const state = useAppStore.getState();
    expect(state.adminState?.memory).toEqual(MEMORY);
    expect(state.adminState?.scheduler.queue_depth).toBe(5);
  });

  it("preserves adminState.memory on admin_config_updated event", () => {
    setAdminState(MEMORY);

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

    const state = useAppStore.getState();
    expect(state.adminState?.memory).toEqual(MEMORY);
    expect(state.adminState?.config.device).toBe("cpu");
  });

  it("preserves adminState.memory on model_state event", () => {
    setAdminState(MEMORY);

    useAppStore.getState().applyEvent({
      type: "model_state",
      payload: { state: "busy" },
    });

    const state = useAppStore.getState();
    expect(state.adminState?.memory).toEqual(MEMORY);
    expect(state.adminState?.telemetry?.model_state).toBe("busy");
  });
});

describe("adminStateEqual", () => {
  it("returns true when both memory states are null", () => {
    const stateA = makeAdminState(null);
    const stateB = makeAdminState(null);

    // setAdminState uses adminStateEqual internally;
    // set to A first, then verify B doesn't trigger an update
    useAppStore.setState({ adminState: stateA });
    useAppStore.getState().setAdminState(stateB);
    expect(useAppStore.getState().adminState).toBe(stateA);
  });

  it("returns false when one has memory and the other is null", () => {
    const stateA = makeAdminState(MEMORY);
    const stateB = makeAdminState(null);

    useAppStore.setState({ adminState: stateA });
    useAppStore.getState().setAdminState(stateB);
    // Should have updated to stateB because memory differs
    expect(useAppStore.getState().adminState?.memory).toBeNull();
  });

  it("returns false when memory values differ", () => {
    const stateA = makeAdminState(MEMORY);
    const stateB = makeAdminState(DIFFERENT_MEMORY);

    useAppStore.setState({ adminState: stateA });
    useAppStore.getState().setAdminState(stateB);
    expect(useAppStore.getState().adminState?.memory).toEqual(DIFFERENT_MEMORY);
  });
});
