import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { AdminPage } from "./AdminPage";
import { useAppStore } from "../../state/store";

test("renders admin telemetry and saves config", async () => {
  const user = userEvent.setup();
  useAppStore.setState({
    jobs: [],
    voices: [],
    websocketStatus: "open",
    lastEvent: null,
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
    },
    setJobs: useAppStore.getState().setJobs,
    setVoices: useAppStore.getState().setVoices,
    setAdminState: useAppStore.getState().setAdminState,
    setWebsocketStatus: useAppStore.getState().setWebsocketStatus,
    applyEvent: useAppStore.getState().applyEvent,
  });

  global.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
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

  render(<AdminPage />);

  await user.clear(screen.getByLabelText(/idle unload seconds/i));
  await user.type(screen.getByLabelText(/idle unload seconds/i), "120");
  await user.click(screen.getByRole("button", { name: /save config/i }));

  expect(screen.getByText(/batch size: 4/i)).toBeInTheDocument();
  expect(global.fetch).toHaveBeenCalledWith("/api/admin/config", expect.any(Object));
});

