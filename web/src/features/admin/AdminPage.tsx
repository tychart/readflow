import { FormEvent, useEffect, useRef, useState } from "react";

import { api } from "../../lib/api";
import { useAppBootstrap } from "../../hooks/useAppBootstrap";
import { useAppStore } from "../../state/store";
import type { AdminConfig } from "../../types/api";

/* ── Styles ───────────────────────────────────────────────── */

function inputClass() {
  return "w-full rounded-lg border border-[var(--line)] bg-[var(--surface)] px-3.5 py-2.5 text-sm text-[var(--ink-primary)] transition focus:outline-none focus:border-[var(--amber)] focus:ring-1 focus:ring-[var(--amber)]";
}

function labelClass() {
  return "block text-xs font-medium uppercase tracking-wider text-[var(--ink-secondary)]";
}

/* ── Types ────────────────────────────────────────────────── */

type ModelAction = "idle" | "warm" | "evict";

const MODEL_STATE_LABELS: Record<string, string> = {
  unloaded: "Unloaded",
  loading: "Loading…",
  warm_idle: "Warm (idle)",
  busy: "Busy",
  evicting: "Evicting…",
  not_enough_vram: "Insufficient VRAM",
};

const MODEL_STATE_COLORS: Record<string, { dot: string; pulse?: boolean }> = {
  unloaded: { dot: "bg-[var(--ink-secondary)]" },
  loading: { dot: "bg-amber-400", pulse: true },
  warm_idle: { dot: "bg-emerald-400" },
  busy: { dot: "bg-blue-400" },
  evicting: { dot: "bg-amber-400", pulse: true },
  not_enough_vram: { dot: "bg-rose-400" },
};

/* ── Stat Card ────────────────────────────────────────────── */

function StatCard({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-[var(--line)] bg-[var(--surface)] p-4">
      <div className="text-[10px] font-semibold uppercase tracking-wider text-[var(--ink-secondary)]">
        {label}
      </div>
      {children}
    </div>
  );
}

/* ── Component ────────────────────────────────────────────── */

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
    if (feedbackTimerRef.current) clearTimeout(feedbackTimerRef.current);
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
      showFeedback("error", error instanceof Error ? error.message : "Failed to warm model");
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
      showFeedback("error", error instanceof Error ? error.message : "Failed to evict model");
    } finally {
      setModelActionPending("idle");
    }
  }

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
    return (
      <div className="flex items-center justify-center py-20">
        <div className="flex items-center gap-3 text-sm text-[var(--ink-secondary)]">
          <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-[var(--amber)] border-t-transparent" />
          Loading admin state…
        </div>
      </div>
    );
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
    formState.batch_candidates_small_model.length !== adminState.config.batch_candidates_small_model.length ||
    formState.batch_candidates_small_model.some((v, i) => v !== adminState.config.batch_candidates_small_model[i]) ||
    formState.batch_candidates_large_model.length !== adminState.config.batch_candidates_large_model.length ||
    formState.batch_candidates_large_model.some((v, i) => v !== adminState.config.batch_candidates_large_model[i]);

  const recentBatch = adminState.telemetry?.recent_batches[0];
  const isGpuActive =
    adminState.memory &&
    adminState.memory.device !== "cpu" &&
    adminState.memory.device !== "unloaded" &&
    adminState.memory.device !== "loading" &&
    adminState.memory.device !== "evicting";

  return (
    <div className="mx-auto w-full max-w-7xl px-4 py-6 md:px-6 md:py-8">
      <div className="grid gap-4 xl:grid-cols-[0.95fr_1.05fr]">
      {/* ── Config Form ──────────────────────────────────── */}
      <form
        className="rounded-xl border border-[var(--line)] bg-[var(--surface)] p-5"
        onSubmit={(event) => void handleSubmit(event)}
      >
        <div className="mb-5">
          <p className="text-xs uppercase tracking-[0.2em] text-[var(--ink-secondary)]">
            Admin
          </p>
          <div className="flex items-center gap-3">
            <h1 className="text-xl font-bold text-[var(--ink-primary)]">
              Warmth and flow control
            </h1>
            {hasUnsavedChanges && (
              <span className="inline-flex items-center gap-1.5 rounded-md border border-[var(--amber)]/20 bg-[var(--amber)]/10 px-2.5 py-1 text-[10px] font-semibold text-[var(--amber)]">
                <span className="inline-block h-1.5 w-1.5 rounded-full bg-amber-400" />
                Unsaved
              </span>
            )}
          </div>
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          {/* Device */}
          <label className={labelClass()}>
            Device
            <select
              className={`${inputClass()} mt-1.5`}
              value={formState.device}
              onChange={(e) => setFormState({ ...formState, device: e.target.value })}
            >
              <option value="auto">Auto (GPU priority, CPU fallback)</option>
              <option value="gpu">GPU (CUDA only)</option>
              <option value="cpu">CPU only</option>
            </select>
            <span className="mt-1 block text-[10px] text-[var(--ink-secondary)]">
              {formState.device === "auto" && "Uses GPU if CUDA is available, otherwise falls back to CPU."}
              {formState.device === "gpu" && "Forces CUDA. Throws error if no GPU or insufficient VRAM."}
              {formState.device === "cpu" && "Forces CPU. Slower but uses no VRAM."}
            </span>
          </label>

          <label className={labelClass()}>
            Idle unload (seconds)
            <input
              className={`${inputClass()} mt-1.5`}
              type="number"
              min="0"
              value={formState.idle_unload_seconds}
              onChange={(e) => setFormState({ ...formState, idle_unload_seconds: Number(e.target.value) })}
            />
          </label>

          <label className={labelClass()}>
            Target buffer (seconds)
            <input
              className={`${inputClass()} mt-1.5`}
              type="number"
              min="0"
              value={formState.target_buffer_seconds}
              onChange={(e) => setFormState({ ...formState, target_buffer_seconds: Number(e.target.value) })}
            />
          </label>

          <label className={labelClass()}>
            Max prebuffer (seconds)
            <input
              className={`${inputClass()} mt-1.5`}
              type="number"
              min="0"
              value={formState.max_prebuffer_seconds}
              onChange={(e) => setFormState({ ...formState, max_prebuffer_seconds: Number(e.target.value) })}
            />
          </label>

          <label className={labelClass()}>
            VRAM soft limit (MB)
            <input
              className={`${inputClass()} mt-1.5`}
              type="number"
              min="0"
              value={formState.vram_soft_limit_mb}
              onChange={(e) => setFormState({ ...formState, vram_soft_limit_mb: Number(e.target.value) })}
            />
          </label>

          <label className={labelClass()}>
            VRAM hard limit (MB)
            <input
              className={`${inputClass()} mt-1.5`}
              type="number"
              min="0"
              value={formState.vram_hard_limit_mb}
              onChange={(e) => setFormState({ ...formState, vram_hard_limit_mb: Number(e.target.value) })}
            />
          </label>
        </div>

        {/* Action buttons */}
        <div className="mt-5 flex flex-wrap gap-3">
          <button
            className={`rounded-lg px-5 py-2.5 text-sm font-semibold transition ${
              hasUnsavedChanges
                ? "bg-[var(--amber)] text-white ring-2 ring-[var(--amber)] ring-offset-2 ring-offset-[var(--surface)]"
                : "bg-[var(--amber)] text-white hover:brightness-110"
            }`}
            type="submit"
          >
            Save config
          </button>

          <button
            className="inline-flex items-center gap-2 rounded-lg border border-[var(--line)] bg-[var(--surface)] px-4 py-2.5 text-sm font-semibold text-[var(--ink-secondary)] transition hover:text-[var(--ink-primary)] disabled:cursor-not-allowed disabled:opacity-50"
            disabled={modelActionPending !== "idle"}
            onClick={() => void handleWarmModel()}
            type="button"
          >
            {modelActionPending === "warm" && (
              <span className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-[var(--ink-secondary)] border-t-transparent" />
            )}
            {modelActionPending === "warm" ? "Warming…" : "Warm model"}
          </button>

          <button
            className="inline-flex items-center gap-2 rounded-lg border border-[var(--line)] bg-[var(--surface)] px-4 py-2.5 text-sm font-semibold text-[var(--ink-secondary)] transition hover:text-[var(--ink-primary)] disabled:cursor-not-allowed disabled:opacity-50"
            disabled={modelActionPending !== "idle"}
            onClick={() => void handleEvictModel()}
            type="button"
          >
            {modelActionPending === "evict" && (
              <span className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-[var(--ink-secondary)] border-t-transparent" />
            )}
            {modelActionPending === "evict" ? "Evicting…" : "Evict model"}
          </button>
        </div>

        {/* Feedback */}
        {feedbackMessage && (
          <div
            className={`mt-4 rounded-lg border px-4 py-3 text-xs font-medium ${
              feedbackMessage.type === "success"
                ? "border-[var(--emerald)]/20 bg-[var(--emerald)]/10 text-[var(--emerald)]"
                : "border-[var(--rose)]/20 bg-[var(--rose)]/10 text-[var(--rose)]"
            }`}
            role="alert"
            aria-live="polite"
          >
            <div className="flex items-center gap-2">
              {feedbackMessage.type === "success" ? (
                <svg className="h-3.5 w-3.5 shrink-0" fill="currentColor" viewBox="0 0 20 20">
                  <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.857-9.809a.75.75 0 00-1.214-.882l-3.483 4.79-1.88-1.88a.75.75 0 10-1.06 1.061l2.5 2.5a.75.75 0 001.137-.089l4-5.5z" clipRule="evenodd" />
                </svg>
              ) : (
                <svg className="h-3.5 w-3.5 shrink-0" fill="currentColor" viewBox="0 0 20 20">
                  <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.28 7.22a.75.75 0 00-1.06 1.06L8.94 10l-1.72 1.72a.75.75 0 101.06 1.06L10 11.06l1.72 1.72a.75.75 0 101.06-1.06L11.06 10l1.72-1.72a.75.75 0 00-1.06-1.06L10 8.94 8.28 7.22z" clipRule="evenodd" />
                </svg>
              )}
              <span>{feedbackMessage.text}</span>
            </div>
          </div>
        )}
      </form>

      {/* ── Dashboard ────────────────────────────────────── */}
      <div className="space-y-4">
        {/* Scheduler */}
        <div className="rounded-xl border border-[var(--line)] bg-[var(--surface)] p-5">
          <h2 className="mb-3 text-sm font-semibold text-[var(--ink-primary)]">
            Live scheduler
          </h2>
          <div className="grid gap-3 md:grid-cols-2">
            <StatCard label="Queue depth">
              <div className="mt-1 text-2xl font-bold text-[var(--ink-primary)]">
                {adminState.scheduler.queue_depth}
              </div>
            </StatCard>
            <StatCard label="Model state">
              <div className="mt-2">
                {(() => {
                  const raw = adminState.telemetry?.model_state ?? "";
                  const label = MODEL_STATE_LABELS[raw] ?? (raw || "Unknown");
                  const colors = MODEL_STATE_COLORS[raw] ?? { dot: "bg-[var(--ink-secondary)]" };
                  return (
                    <span className="inline-flex items-center gap-2 rounded-md border border-[var(--line)] bg-[var(--surface-raised)] px-3 py-1.5 text-xs font-medium text-[var(--ink-primary)]">
                      <span className={`inline-block h-2 w-2 rounded-full ${colors.dot} ${colors.pulse ? "animate-pulse" : ""}`} />
                      {label}
                    </span>
                  );
                })()}
              </div>
            </StatCard>
          </div>
        </div>

        {/* System resources */}
        <div className="rounded-xl border border-[var(--line)] bg-[var(--surface)] p-5">
          <h2 className="mb-3 text-sm font-semibold text-[var(--ink-primary)]">
            System resources
          </h2>
          {adminState.memory ? (
            <>
              <div className="grid gap-3 md:grid-cols-2">
                <StatCard label="Device">
                  <div className="mt-1 text-2xl font-bold capitalize text-[var(--ink-primary)]">
                    {adminState.memory.device === "loading" || adminState.memory.device === "evicting" ? "—" : adminState.memory.device}
                  </div>
                  <div className="mt-0.5 text-[10px] text-[var(--ink-secondary)]">
                    {adminState.memory.device === "loading" ? "Model is loading…" :
                     adminState.memory.device === "evicting" ? "Model is evicting…" :
                     adminState.memory.device === "unloaded" ? "No model loaded" :
                     `Setting: ${adminState.config.device}`}
                  </div>
                </StatCard>

                {isGpuActive ? (
                  <StatCard label="VRAM">
                    <div className="mt-1 text-2xl font-bold text-[var(--ink-primary)]">
                      {adminState.memory.vram_reserved_mb.toLocaleString()} MB
                    </div>
                    <div className="text-[10px] text-[var(--ink-secondary)]">
                      reserved of {adminState.memory.vram_total_mb.toLocaleString()} MB total
                    </div>
                    {/* Stacked bars */}
                    <div className="mt-2 space-y-1">
                      <div className="h-2 overflow-hidden rounded-full bg-[var(--line)]">
                        <div
                          className="h-2 rounded-full bg-[var(--amber)] transition-all"
                          style={{
                            width: `${adminState.memory.vram_total_mb > 0 ? Math.min((adminState.memory.vram_used_mb / adminState.memory.vram_total_mb) * 100, 100) : 0}%`,
                          }}
                        />
                      </div>
                      <div className="flex gap-3 text-[10px] text-[var(--ink-secondary)]">
                        <span className="flex items-center gap-1">
                          <span className="inline-block h-1.5 w-1.5 rounded-full bg-[var(--amber)]" />
                          Allocated {adminState.memory.vram_used_mb.toLocaleString()} MB
                        </span>
                        <span className="flex items-center gap-1">
                          <span className="inline-block h-1.5 w-1.5 rounded-full bg-[var(--ink-secondary)]" />
                          Headroom {Math.max(0, adminState.memory.vram_reserved_mb - adminState.memory.vram_used_mb).toLocaleString()} MB
                        </span>
                      </div>
                    </div>
                    <div className="mt-2 flex gap-3 text-[10px] text-[var(--ink-secondary)]">
                      <span>Soft: {adminState.config.vram_soft_limit_mb.toLocaleString()} MB</span>
                      <span>Hard: {adminState.config.vram_hard_limit_mb.toLocaleString()} MB</span>
                    </div>
                    {(adminState.telemetry?.oom_count ?? 0) > 0 && (
                      <div className="mt-2 inline-flex items-center gap-1 rounded-md border border-[var(--rose)]/20 bg-[var(--rose)]/10 px-2 py-0.5 text-[10px] font-medium text-[var(--rose)]">
                        {adminState.telemetry!.oom_count} OOM
                      </div>
                    )}
                  </StatCard>
                ) : (
                  <StatCard label="VRAM">
                    <div className="mt-1 text-2xl font-bold text-[var(--ink-secondary)]/50">—</div>
                    <div className="mt-0.5 text-[10px] text-[var(--ink-secondary)]">
                      {adminState.memory.device === "cpu" ? "Running on CPU — no GPU memory" :
                       "Model not loaded — GPU memory not in use"}
                    </div>
                  </StatCard>
                )}
              </div>

              <div className="mt-3 grid gap-3 md:grid-cols-2">
                <StatCard label="System RAM">
                  <div className="mt-1 text-2xl font-bold text-[var(--ink-primary)]">
                    {adminState.memory.ram_used_mb.toLocaleString()} MB
                  </div>
                  <div className="text-[10px] text-[var(--ink-secondary)]">
                    {adminState.memory.ram_free_mb.toLocaleString()} MB free of {adminState.memory.ram_total_mb.toLocaleString()} MB total
                  </div>
                  <div className="mt-2 h-2 overflow-hidden rounded-full bg-[var(--line)]">
                    <div
                      className="h-2 rounded-full bg-[var(--emerald)] transition-all"
                      style={{
                        width: `${adminState.memory.ram_total_mb ? Math.round((adminState.memory.ram_used_mb / adminState.memory.ram_total_mb) * 100) : 0}%`,
                      }}
                    />
                  </div>
                </StatCard>

                <StatCard label="Synthesis">
                  {recentBatch ? (
                    <div className="mt-1 space-y-1">
                      <div className="text-xs text-[var(--ink-primary)]">
                        {recentBatch.batch_size} chunk{recentBatch.batch_size !== 1 ? "s" : ""} · {recentBatch.duration_seconds.toFixed(1)}s
                      </div>
                      <div className="text-[10px] text-[var(--ink-secondary)]">
                        VRAM: {recentBatch.reserved_vram_mb.toLocaleString()} MB reserved · {recentBatch.allocated_vram_mb.toLocaleString()} MB allocated
                      </div>
                    </div>
                  ) : (
                    <div className="mt-1 text-xs text-[var(--ink-secondary)]">No batches yet</div>
                  )}
                </StatCard>
              </div>
            </>
          ) : (
            <div className="rounded-lg border border-dashed border-[var(--line)] px-4 py-8 text-center text-sm text-[var(--ink-secondary)]">
              Memory stats unavailable.
            </div>
          )}
        </div>
      </div>
    </div>
    </div>
  );
}
