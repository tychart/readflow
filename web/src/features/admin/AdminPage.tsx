import { FormEvent, useEffect, useRef, useState } from "react";

import { api } from "../../lib/api";
import { useAppBootstrap } from "../../hooks/useAppBootstrap";
import { useAppStore } from "../../state/store";
import type { AdminConfig } from "../../types/api";

const NUMBER_INPUT_PROPS = {
  className: "mt-2 w-full rounded-2xl border border-stone-300 bg-white/70 px-4 py-3",
  mode: "uncontrolled" as const,
} as const;

const SELECT_INPUT_PROPS = {
  className: "mt-2 w-full rounded-2xl border border-stone-300 bg-white/70 px-4 py-3",
} as const;

export function AdminPage() {
  useAppBootstrap(true);

  const adminState = useAppStore((state) => state.adminState);
  const setAdminState = useAppStore((state) => state.setAdminState);
  const [formState, setFormState] = useState<AdminConfig | null>(null);
  const hasInitialized = useRef(false);

  useEffect(() => {
    if (adminState) {
      return;
    }
    void api.getAdminState().then((state) => {
      setAdminState(state);
    });
  }, [adminState, setAdminState]);

  // Initialize formState once from adminState.config — don't re-sync on every
  // adminState change because WebSocket events (telemetry, model_state, etc.)
  // create new adminState references that would overwrite unsaved local edits.
  useEffect(() => {
    if (adminState && adminState.config && !hasInitialized.current) {
      hasInitialized.current = true;
      setFormState({
        ...adminState.config,
        device: adminState.config.device ?? "auto",
      });
    }
  }, [adminState]);

  if (!adminState || !formState) {
    return <div aria-label="Loading" className="panel rounded-[2rem] p-8">Loading admin state…</div>;
  }

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    try {
      const nextConfig = await api.updateAdminConfig(formState);
      setFormState(nextConfig);
      setAdminState({ ...adminState, config: nextConfig });
    } catch (error) {
      console.error("Failed to update config:", error);
    }
  };

  const recentBatch = adminState.telemetry?.recent_batches[0];

  const batchProps = { className: "rounded-2xl bg-white/70 p-4" } as const;

  return (
    <div className="grid gap-6 xl:grid-cols-[0.95fr_1.05fr]">
      <form className="panel rounded-[2rem] p-6" onSubmit={(event) => void handleSubmit(event)}>
        <div className="mb-6">
          <p className="text-sm uppercase tracking-[0.3em] text-stone-600">Admin</p>
          <h1 className="display-font text-4xl">Warmth and flow control</h1>
        </div>
        <div className="grid gap-4 md:grid-cols-2">
          <label className="text-sm font-medium">
            Device
            <select
              {...SELECT_INPUT_PROPS}
              value={formState.device}
              onChange={(event) =>
                setFormState({ ...formState, device: event.target.value })
              }
            >
              <option value="auto">Auto (GPU when available)</option>
              <option value="cuda">GPU (CUDA only)</option>
              <option value="cpu">CPU (fallback)</option>
            </select>
            <span className="mt-1 block text-xs text-stone-500">
              {formState.device === "auto" && "Uses GPU if CUDA is available, otherwise falls back to CPU."}
              {formState.device === "cuda" && "Forces CUDA. Will fail if no GPU is present."}
              {formState.device === "cpu" && "Forces CPU. Slower but uses no VRAM."}
            </span>
          </label>
          <label className="text-sm font-medium">
            Idle unload seconds
            <input
              {...NUMBER_INPUT_PROPS}
              type="number"
              min="0"
              value={formState.idle_unload_seconds}
              onChange={(event) =>
                setFormState({ ...formState, idle_unload_seconds: Number(event.target.value) })
              }
            />
          </label>
          <label className="text-sm font-medium">
            Target buffer seconds
            <input
              {...NUMBER_INPUT_PROPS}
              type="number"
              min="0"
              value={formState.target_buffer_seconds}
              onChange={(event) =>
                setFormState({ ...formState, target_buffer_seconds: Number(event.target.value) })
              }
            />
          </label>
          <label className="text-sm font-medium">
            Max prebuffer seconds
            <input
              {...NUMBER_INPUT_PROPS}
              type="number"
              min="0"
              value={formState.max_prebuffer_seconds}
              onChange={(event) =>
                setFormState({ ...formState, max_prebuffer_seconds: Number(event.target.value) })
              }
            />
          </label>
          <label className="text-sm font-medium">
            VRAM soft limit
            <input
              {...NUMBER_INPUT_PROPS}
              type="number"
              min="0"
              value={formState.vram_soft_limit_mb}
              onChange={(event) => setFormState({ ...formState, vram_soft_limit_mb: Number(event.target.value) })}
            />
          </label>
        </div>
        <div className="mt-6 flex flex-wrap gap-3">
          <button className="rounded-full bg-[var(--accent)] px-5 py-3 font-semibold text-white" type="submit">
            Save config
          </button>
          <button
            className="rounded-full border border-stone-300 bg-white/80 px-5 py-3 font-semibold"
            onClick={() => void api.warmModel()}
            type="button"
          >
            Warm model
          </button>
          <button
            className="rounded-full border border-stone-300 bg-white/80 px-5 py-3 font-semibold"
            onClick={() => void api.evictModel()}
            type="button"
          >
            Evict model
          </button>
        </div>
      </form>

      <div className="space-y-6">
        <div className="panel rounded-[2rem] p-6">
          <h2 className="mb-4 text-xl font-semibold">Live scheduler</h2>
          <div className="grid gap-4 md:grid-cols-2">
            <div className="rounded-3xl bg-white/70 p-5">
              <div className="text-sm uppercase tracking-[0.2em] text-stone-600">Queue depth</div>
              <div className="mt-2 text-4xl font-semibold">{adminState.scheduler.queue_depth}</div>
            </div>
            <div className="rounded-3xl bg-white/70 p-5">
              <div className="text-sm uppercase tracking-[0.2em] text-stone-600">Model state</div>
              <div className="mt-2 text-4xl font-semibold">
                {adminState.telemetry?.model_state ?? "—"}
              </div>
            </div>
          </div>
        </div>
        <div className="panel rounded-[2rem] p-6">
          <h2 className="mb-4 text-xl font-semibold">System resources</h2>
          {adminState.memory ? (
            <>
              <div className="mb-4 grid gap-4 md:grid-cols-2">
                <div className="rounded-3xl bg-white/70 p-5">
                  <div className="text-sm uppercase tracking-[0.2em] text-stone-600">Device</div>
                  <div className="mt-2 text-4xl font-semibold capitalize">
                    {adminState.memory.device}
                  </div>
                </div>
                <div className="rounded-3xl bg-white/70 p-5">
                  <div className="text-sm uppercase tracking-[0.2em] text-stone-600">VRAM</div>
                  <div className="mt-2 text-4xl font-semibold">
                    {adminState.memory.vram_used_mb} MB
                  </div>
                  <div className="text-xs text-stone-500">
                    {adminState.memory.vram_free_mb} MB free of{" "}
                    {adminState.memory.vram_total_mb} MB total
                  </div>
                </div>
              </div>
              <div className="grid gap-4 md:grid-cols-2">
                <div className="rounded-3xl bg-white/70 p-5">
                  <div className="text-sm uppercase tracking-[0.2em] text-stone-600">System RAM</div>
                  <div className="mt-2 text-4xl font-semibold">
                    {adminState.memory.ram_used_mb} MB
                  </div>
                  <div className="text-xs text-stone-500">
                    {adminState.memory.ram_free_mb} MB free of{" "}
                    {adminState.memory.ram_total_mb} MB total
                  </div>
                  <div className="mt-3 h-3 w-full rounded-full bg-stone-200">
                    <div
                      className="h-3 rounded-full bg-[var(--accent)]"
                      style={{
                        width: `${
                          adminState.memory.ram_total_mb
                            ? Math.round(
                                (adminState.memory.ram_used_mb /
                                  adminState.memory.ram_total_mb) *
                                  100,
                              )
                            : 0
                        }%`,
                      }}
                    />
                  </div>
                </div>
                <div className="rounded-3xl bg-white/70 p-5">
                  <div className="text-sm uppercase tracking-[0.2em] text-stone-600">VRAM usage</div>
                  <div className="mt-2 text-4xl font-semibold">
                    {adminState.memory.vram_total_mb
                      ? Math.round(
                          (adminState.memory.vram_used_mb /
                            adminState.memory.vram_total_mb) *
                            100,
                        )
                      : 0}
                    %
                  </div>
                  <div className="mt-3 h-3 w-full rounded-full bg-stone-200">
                    <div
                      className="h-3 rounded-full bg-[var(--accent)]"
                      style={{
                        width: `${
                          adminState.memory.vram_total_mb
                            ? Math.round(
                                (adminState.memory.vram_used_mb /
                                  adminState.memory.vram_total_mb) *
                                  100,
                              )
                            : 0
                        }%`,
                      }}
                    />
                  </div>
                </div>
              </div>
            </>
          ) : (
            <div aria-label="Memory stats unavailable" className="rounded-2xl border border-dashed border-stone-300 px-4 py-8 text-stone-600">
              Memory stats unavailable.
            </div>
          )}
        </div>
        <div className="panel rounded-[2rem] p-6">
          <h2 className="mb-4 text-xl font-semibold">Recent batch</h2>
          {recentBatch ? (
            <div className="grid gap-3 md:grid-cols-2">
              <div {...batchProps}>Batch size: {recentBatch.batch_size}</div>
              <div {...batchProps}>
                Reserved VRAM: {recentBatch.reserved_vram_mb} MB
              </div>
              <div {...batchProps}>
                Allocated VRAM: {recentBatch.allocated_vram_mb} MB
              </div>
              <div {...batchProps}>
                Duration: {recentBatch.duration_seconds.toFixed(2)}s
              </div>
            </div>
          ) : (
            <div aria-label="No batches yet" className="rounded-2xl border border-dashed border-stone-300 px-4 py-8 text-stone-600">
              No batches yet.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
