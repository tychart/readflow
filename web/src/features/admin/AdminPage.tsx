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

type ModelAction = "idle" | "warm" | "evict";

const MODEL_STATE_LABELS: Record<string, string> = {
  unloaded: "Unloaded",
  loading: "Loading…",
  warm_idle: "Warm (idle)",
  busy: "Busy",
  evicting: "Evicting…",
  not_enough_vram: "Insufficient VRAM",
};

const MODEL_STATE_COLORS: Record<
  string,
  { bg: string; text: string; dot: string; pulse?: boolean }
> = {
  unloaded: { bg: "bg-stone-100", text: "text-stone-600", dot: "bg-stone-400" },
  loading: { bg: "bg-amber-50", text: "text-amber-700", dot: "bg-amber-400", pulse: true },
  warm_idle: { bg: "bg-emerald-50", text: "text-emerald-700", dot: "bg-emerald-500" },
  busy: { bg: "bg-blue-50", text: "text-blue-700", dot: "bg-blue-500" },
  evicting: { bg: "bg-amber-50", text: "text-amber-700", dot: "bg-amber-400", pulse: true },
  not_enough_vram: { bg: "bg-red-50", text: "text-red-700", dot: "bg-red-500" },
};

export function AdminPage() {
  useAppBootstrap(true);

  const adminState = useAppStore((state) => state.adminState);
  const setAdminState = useAppStore((state) => state.setAdminState);
  const [formState, setFormState] = useState<AdminConfig | null>(null);
  const hasInitialized = useRef(false);
  const [modelActionPending, setModelActionPending] = useState<ModelAction>("idle");
  const [feedbackMessage, setFeedbackMessage] = useState<{
    type: "success" | "error";
    text: string;
  } | null>(null);
  const feedbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  function showFeedback(type: "success" | "error", text: string) {
    if (feedbackTimerRef.current) {
      clearTimeout(feedbackTimerRef.current);
    }
    setFeedbackMessage({ type, text });
    feedbackTimerRef.current = setTimeout(() => {
      setFeedbackMessage(null);
      feedbackTimerRef.current = null;
    }, 5000);
  }

  async function handleWarmModel() {
    setModelActionPending("warm");
    setFeedbackMessage(null);
    try {
      await api.warmModel();
      showFeedback("success", "Model warmed up successfully");
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to warm model";
      showFeedback("error", message);
    } finally {
      setModelActionPending("idle");
    }
  }

  async function handleEvictModel() {
    setModelActionPending("evict");
    setFeedbackMessage(null);
    try {
      await api.evictModel();
      showFeedback("success", "Model evicted successfully");
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to evict model";
      showFeedback("error", message);
    } finally {
      setModelActionPending("idle");
    }
  }

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

  const hasUnsavedChanges =
    formState.device !== (adminState.config.device ?? "auto") ||
    formState.idle_unload_seconds !== adminState.config.idle_unload_seconds ||
    formState.max_prebuffer_seconds !== adminState.config.max_prebuffer_seconds ||
    formState.target_buffer_seconds !== adminState.config.target_buffer_seconds ||
    formState.vram_soft_limit_mb !== adminState.config.vram_soft_limit_mb ||
    formState.vram_hard_limit_mb !== adminState.config.vram_hard_limit_mb ||
    formState.batch_candidates_small_model.length !==
      adminState.config.batch_candidates_small_model.length ||
    formState.batch_candidates_small_model.some(
      (v, i) => v !== adminState.config.batch_candidates_small_model[i],
    ) ||
    formState.batch_candidates_large_model.length !==
      adminState.config.batch_candidates_large_model.length ||
    formState.batch_candidates_large_model.some(
      (v, i) => v !== adminState.config.batch_candidates_large_model[i],
    );

  const recentBatch = adminState.telemetry?.recent_batches[0];

  const batchProps = { className: "rounded-2xl bg-white/70 p-4" } as const;

  return (
    <div className="grid gap-6 xl:grid-cols-[0.95fr_1.05fr]">
      <form className="panel rounded-[2rem] p-6" onSubmit={(event) => void handleSubmit(event)}>
        <div className="mb-6">
          <p className="text-sm uppercase tracking-[0.3em] text-stone-600">Admin</p>
          <div className="flex items-center gap-3">
            <h1 className="display-font text-4xl">Warmth and flow control</h1>
            {hasUnsavedChanges && (
              <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-100 px-3 py-1 text-xs font-semibold text-amber-700">
                <span className="inline-block h-2 w-2 rounded-full bg-amber-500" />
                Unsaved changes
              </span>
            )}
          </div>
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
              <option value="auto">Auto (GPU priority, CPU fallback)</option>
              <option value="gpu">GPU (CUDA only)</option>
              <option value="cpu">CPU only</option>
            </select>
            <span className="mt-1 block text-xs text-stone-500">
              {formState.device === "auto" && "Uses GPU if CUDA is available, otherwise falls back to CPU."}
              {formState.device === "gpu" && "Forces CUDA. Throws error if no GPU or insufficient VRAM."}
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
          <button
            className={`rounded-full px-5 py-3 font-semibold text-white transition-all duration-200 ${
              hasUnsavedChanges
                ? "bg-[var(--accent-2)] ring-2 ring-[var(--accent-2)] ring-offset-2 ring-offset-transparent"
                : "bg-[var(--accent)]"
            }`}
            type="submit"
          >
            Save config
          </button>
          <button
            className="inline-flex items-center gap-2 rounded-full border border-stone-300 bg-white/80 px-5 py-3 font-semibold disabled:cursor-not-allowed disabled:opacity-60"
            disabled={modelActionPending !== "idle"}
            onClick={() => void handleWarmModel()}
            type="button"
            aria-label={modelActionPending === "warm" ? "Warming model…" : "Warm model"}
          >
            {modelActionPending === "warm" && (
              <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-stone-400 border-t-transparent" />
            )}
            {modelActionPending === "warm" ? "Warming…" : "Warm model"}
          </button>
          <button
            className="inline-flex items-center gap-2 rounded-full border border-stone-300 bg-white/80 px-5 py-3 font-semibold disabled:cursor-not-allowed disabled:opacity-60"
            disabled={modelActionPending !== "idle"}
            onClick={() => void handleEvictModel()}
            type="button"
            aria-label={modelActionPending === "evict" ? "Evicting model…" : "Evict model"}
          >
            {modelActionPending === "evict" && (
              <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-stone-400 border-t-transparent" />
            )}
            {modelActionPending === "evict" ? "Evicting…" : "Evict model"}
          </button>
        </div>
        {/* Inline feedback banner */}
        {feedbackMessage && (
          <div
            className={`mt-4 rounded-2xl border px-4 py-3 text-sm font-medium transition-opacity duration-300 ${
              feedbackMessage.type === "success"
                ? "border-emerald-200 bg-emerald-50 text-emerald-800"
                : "border-red-200 bg-red-50 text-red-800"
            }`}
            role="alert"
            aria-live="polite"
          >
            <div className="flex items-center gap-2">
              {feedbackMessage.type === "success" ? (
                <svg className="h-4 w-4 shrink-0" viewBox="0 0 20 20" fill="currentColor">
                  <path
                    fillRule="evenodd"
                    d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.857-9.809a.75.75 0 00-1.214-.882l-3.483 4.79-1.88-1.88a.75.75 0 10-1.06 1.061l2.5 2.5a.75.75 0 001.137-.089l4-5.5z"
                    clipRule="evenodd"
                  />
                </svg>
              ) : (
                <svg className="h-4 w-4 shrink-0" viewBox="0 0 20 20" fill="currentColor">
                  <path
                    fillRule="evenodd"
                    d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.28 7.22a.75.75 0 00-1.06 1.06L8.94 10l-1.72 1.72a.75.75 0 101.06 1.06L10 11.06l1.72 1.72a.75.75 0 101.06-1.06L11.06 10l1.72-1.72a.75.75 0 00-1.06-1.06L10 8.94 8.28 7.22z"
                    clipRule="evenodd"
                  />
                </svg>
              )}
              <span>{feedbackMessage.text}</span>
            </div>
          </div>
        )}
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
              <div className="mt-3">
                {(() => {
                  const raw = adminState.telemetry?.model_state ?? "";
                  const label = MODEL_STATE_LABELS[raw] ?? (raw || "Unknown");
                  const colors = MODEL_STATE_COLORS[raw] ?? {
                    bg: "bg-stone-100",
                    text: "text-stone-600",
                    dot: "bg-stone-400",
                  };
                  return (
                    <span
                      className={`inline-flex items-center gap-2 rounded-full px-4 py-2 text-sm font-semibold ${colors.bg} ${colors.text}`}
                    >
                      <span
                        className={`inline-block h-3 w-3 rounded-full ${colors.dot} ${
                          colors.pulse ? "animate-pulse" : ""
                        }`}
                      />
                      {label}
                    </span>
                  );
                })()}
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
                {adminState.memory.device !== "cpu" ? (
                  <div className="rounded-3xl bg-white/70 p-5">
                    <div className="text-sm uppercase tracking-[0.2em] text-stone-600">VRAM</div>
                    <div className="mt-2 text-4xl font-semibold">
                      {adminState.memory.vram_used_mb} MB
                    </div>
                    <div className="text-xs text-stone-500">
                      {adminState.memory.vram_free_mb} MB free of{" "}
                      {adminState.memory.vram_total_mb} MB total
                    </div>
                    <div className="mt-2 text-xs text-stone-400">
                      {adminState.memory.vram_reserved_mb} MB reserved
                    </div>
                  </div>
                ) : (
                  <div className="rounded-3xl bg-white/70 p-5">
                    <div className="text-sm uppercase tracking-[0.2em] text-stone-600">VRAM</div>
                    <div className="mt-2 text-4xl font-semibold">N/A</div>
                    <div className="text-xs text-stone-500">
                      Model is running on CPU — no GPU memory to report
                    </div>
                  </div>
                )}
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
                {adminState.memory.device !== "cpu" ? (
                  <div className="rounded-3xl bg-white/70 p-5">
                    <div className="text-sm uppercase tracking-[0.2em] text-stone-600">VRAM usage</div>
                    <div className="mt-2 text-4xl font-semibold">
                      {adminState.memory.vram_total_mb
                        ? Math.round(
                            (adminState.memory.vram_reserved_mb /
                              adminState.memory.vram_total_mb) *
                              100,
                          )
                        : 0}
                      %
                    </div>
                    <div className="mt-3 space-y-1">
                      {/* Stacked bar: allocated (used) + reserved headroom */}
                      <div className="h-3 w-full rounded-full bg-stone-200 overflow-hidden">
                        <div
                          className="h-3 rounded-full bg-[var(--accent)] transition-all duration-500"
                          style={{
                            width: `${
                              adminState.memory.vram_total_mb
                                ? Math.min(
                                    (adminState.memory.vram_used_mb /
                                      adminState.memory.vram_total_mb) * 100,
                                    100,
                                  )
                                : 0
                            }%`,
                          }}
                          title={`Allocated: ${adminState.memory.vram_used_mb} MB`}
                        />
                      </div>
                      <div className="h-3 w-full rounded-full bg-stone-200 overflow-hidden">
                        <div
                          className="h-3 rounded-full bg-amber-400 transition-all duration-500"
                          style={{
                            width: `${
                              adminState.memory.vram_total_mb
                                ? Math.min(
                                    ((adminState.memory.vram_reserved_mb - adminState.memory.vram_used_mb) /
                                      adminState.memory.vram_total_mb) * 100,
                                    100,
                                  )
                                : 0
                            }%`,
                          }}
                          title={`Reserved headroom: ${Math.max(0, adminState.memory.vram_reserved_mb - adminState.memory.vram_used_mb)} MB`}
                        />
                      </div>
                    </div>
                    <div className="mt-2 flex gap-4 text-xs text-stone-500">
                      <span className="flex items-center gap-1">
                        <span className="inline-block h-2 w-2 rounded-full bg-[var(--accent)]"></span>
                        Allocated {adminState.memory.vram_used_mb} MB
                      </span>
                      <span className="flex items-center gap-1">
                        <span className="inline-block h-2 w-2 rounded-full bg-amber-400"></span>
                        Reserved headroom {Math.max(0, adminState.memory.vram_reserved_mb - adminState.memory.vram_used_mb)} MB
                      </span>
                    </div>
                  </div>
                ) : (
                  <div className="rounded-3xl bg-white/70 p-5">
                    <div className="text-sm uppercase tracking-[0.2em] text-stone-600">VRAM usage</div>
                    <div className="mt-2 text-4xl font-semibold">N/A</div>
                    <div className="text-xs text-stone-500">
                      Model is running on CPU — no GPU memory to report
                    </div>
                  </div>
                )}
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
