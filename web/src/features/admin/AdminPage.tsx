import { FormEvent, useEffect, useState } from "react";

import { api } from "../../lib/api";
import { useAppBootstrap } from "../../hooks/useAppBootstrap";
import { useAppStore } from "../../state/store";
import type { AdminConfig } from "../../types/api";

export function AdminPage() {
  useAppBootstrap(true);

  const adminState = useAppStore((state) => state.adminState);
  const setAdminState = useAppStore((state) => state.setAdminState);
  const [formState, setFormState] = useState<AdminConfig | null>(null);

  useEffect(() => {
    if (adminState) {
      return;
    }
    void api.getAdminState().then((state) => {
      setAdminState(state);
    });
  }, [adminState, setAdminState]);

  useEffect(() => {
    if (adminState) {
      setFormState(adminState.config);
    }
  }, [adminState]);

  if (!adminState || !formState) {
    return <div className="panel rounded-[2rem] p-8">Loading admin state…</div>;
  }

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    const nextConfig = await api.updateAdminConfig(formState);
    setAdminState({ ...adminState, config: nextConfig });
  };

  const recentBatch = adminState.telemetry.recent_batches[0];

  return (
    <div className="grid gap-6 xl:grid-cols-[0.95fr_1.05fr]">
      <form className="panel rounded-[2rem] p-6" onSubmit={(event) => void handleSubmit(event)}>
        <div className="mb-6">
          <p className="text-sm uppercase tracking-[0.3em] text-stone-600">Admin</p>
          <h1 className="display-font text-4xl">Warmth and flow control</h1>
        </div>
        <div className="grid gap-4 md:grid-cols-2">
          <label className="text-sm font-medium">
            Idle unload seconds
            <input
              className="mt-2 w-full rounded-2xl border border-stone-300 bg-white/70 px-4 py-3"
              type="number"
              value={formState.idle_unload_seconds}
              onChange={(event) =>
                setFormState({ ...formState, idle_unload_seconds: Number(event.target.value) })
              }
            />
          </label>
          <label className="text-sm font-medium">
            Target buffer seconds
            <input
              className="mt-2 w-full rounded-2xl border border-stone-300 bg-white/70 px-4 py-3"
              type="number"
              value={formState.target_buffer_seconds}
              onChange={(event) =>
                setFormState({ ...formState, target_buffer_seconds: Number(event.target.value) })
              }
            />
          </label>
          <label className="text-sm font-medium">
            Max prebuffer seconds
            <input
              className="mt-2 w-full rounded-2xl border border-stone-300 bg-white/70 px-4 py-3"
              type="number"
              value={formState.max_prebuffer_seconds}
              onChange={(event) =>
                setFormState({ ...formState, max_prebuffer_seconds: Number(event.target.value) })
              }
            />
          </label>
          <label className="text-sm font-medium">
            VRAM soft limit
            <input
              className="mt-2 w-full rounded-2xl border border-stone-300 bg-white/70 px-4 py-3"
              type="number"
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
              <div className="mt-2 text-4xl font-semibold">{adminState.telemetry.model_state}</div>
            </div>
          </div>
        </div>
        <div className="panel rounded-[2rem] p-6">
          <h2 className="mb-4 text-xl font-semibold">Recent batch</h2>
          {recentBatch ? (
            <div className="grid gap-3 md:grid-cols-2">
              <div className="rounded-2xl bg-white/70 p-4">Batch size: {recentBatch.batch_size}</div>
              <div className="rounded-2xl bg-white/70 p-4">
                Reserved VRAM: {recentBatch.reserved_vram_mb} MB
              </div>
              <div className="rounded-2xl bg-white/70 p-4">
                Allocated VRAM: {recentBatch.allocated_vram_mb} MB
              </div>
              <div className="rounded-2xl bg-white/70 p-4">
                Duration: {recentBatch.duration_seconds.toFixed(2)}s
              </div>
            </div>
          ) : (
            <div className="rounded-2xl border border-dashed border-stone-300 px-4 py-8 text-stone-600">
              No batches yet.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
