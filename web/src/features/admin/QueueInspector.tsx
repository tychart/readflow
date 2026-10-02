import { useCallback, useEffect, useMemo, useState } from "react";

import { api } from "../../lib/api";
import { useAppStore } from "../../state/store";
import type { AdminQueue, QueueBatch, QueueChunk, QueueJobGroup } from "../../types/api";

/* ── Formatting helpers ───────────────────────────────────── */

function chunkKey(item: QueueChunk): string {
  return `${item.job_id}:${item.index}:${item.version}`;
}

function formatSeconds(totalSeconds: number): string {
  const seconds = Math.max(0, totalSeconds);
  if (seconds < 60) {
    return `${seconds.toFixed(1)}s`;
  }
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${Math.round(seconds % 60)}s`;
}

function formatAge(timestamp: number): string {
  const seconds = Math.max(0, Date.now() / 1000 - timestamp);
  if (seconds < 60) {
    return `${seconds.toFixed(0)}s ago`;
  }
  return `${Math.floor(seconds / 60)}m ago`;
}

/* ── Small presentational pieces ──────────────────────────── */

const PRIORITY_STYLES: Record<number, string> = {
  0: "border-[var(--rose)]/30 bg-[var(--rose)]/10 text-[var(--rose)]",
  1: "border-[var(--amber)]/30 bg-[var(--amber)]/10 text-[var(--amber)]",
  2: "border-[var(--line)] bg-[var(--hover-bg)] text-[var(--ink-secondary)]",
  99: "border-[var(--line)] bg-transparent text-[var(--ink-secondary)]",
};

const STATUS_STYLES: Record<string, string> = {
  planned: "border-[var(--line)] bg-[var(--hover-bg)] text-[var(--ink-secondary)]",
  queued: "border-[var(--amber)]/20 bg-[var(--amber)]/10 text-[var(--amber)]",
  rendering: "border-[var(--amber)]/30 bg-[var(--amber)]/15 text-[var(--amber)]",
  written: "border-[var(--emerald)]/20 bg-[var(--emerald)]/10 text-[var(--emerald)]",
  failed: "border-[var(--rose)]/20 bg-[var(--rose)]/10 text-[var(--rose)]",
  stale: "border-[var(--line)] bg-[var(--hover-bg)] text-[var(--ink-secondary)]",
  reprocessing: "border-[var(--amber)]/20 bg-[var(--amber)]/10 text-[var(--amber)]",
  max_retries_exceeded: "border-[var(--rose)]/20 bg-[var(--rose)]/10 text-[var(--rose)]",
  paused: "border-[var(--line)] bg-[var(--hover-bg)] text-[var(--ink-secondary)]",
};

const STATUS_GLYPHS: Record<string, { glyph: string; className: string }> = {
  written: { glyph: "✓", className: "text-[var(--emerald)]" },
  rendering: { glyph: "●", className: "text-[var(--amber)] animate-pulse" },
  queued: { glyph: "◐", className: "text-[var(--amber)]" },
  planned: { glyph: "○", className: "text-[var(--ink-secondary)]" },
  reprocessing: { glyph: "↻", className: "text-[var(--amber)]" },
  failed: { glyph: "✕", className: "text-[var(--rose)]" },
  max_retries_exceeded: { glyph: "✕", className: "text-[var(--rose)]" },
  stale: { glyph: "–", className: "text-[var(--ink-secondary)]" },
};

function StatusGlyph({ status }: { status: string }) {
  const entry = STATUS_GLYPHS[status] ?? STATUS_GLYPHS.planned;
  return (
    <span aria-hidden="true" className={`w-4 shrink-0 text-center text-xs ${entry.className}`}>
      {entry.glyph}
    </span>
  );
}

function PriorityBadge({ band, label }: { band: number; label: string }) {
  return (
    <span
      className={`shrink-0 rounded-md border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${
        PRIORITY_STYLES[band] ?? PRIORITY_STYLES[2]
      }`}
    >
      {label}
    </span>
  );
}

function StatusChip({ status }: { status: string }) {
  return (
    <span
      className={`shrink-0 rounded-md border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider ${
        STATUS_STYLES[status] ?? STATUS_STYLES.planned
      }`}
    >
      {status}
    </span>
  );
}

function BatchStrip({
  batch,
  label,
  live = false,
  elapsedSeconds = null,
}: {
  batch: QueueBatch;
  label: string;
  live?: boolean;
  elapsedSeconds?: number | null;
}) {
  return (
    <div
      className={`mb-4 flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg border px-4 py-3 ${
        live
          ? "border-[var(--amber)]/30 bg-[var(--amber)]/5"
          : "border-[var(--line)] bg-[var(--surface)]"
      }`}
    >
      <span className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-[var(--ink-primary)]">
        {live && (
          <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-[var(--amber)]" />
        )}
        {label}
      </span>
      <span className="text-xs text-[var(--ink-secondary)]">
        {batch.chunk_count} chunk{batch.chunk_count === 1 ? "" : "s"} · voice{" "}
        {batch.voice_id ?? "—"} · {batch.language ?? "—"}
      </span>
      {elapsedSeconds != null && (
        <span className="text-xs text-[var(--ink-secondary)]">
          {formatSeconds(elapsedSeconds)} elapsed
        </span>
      )}
    </div>
  );
}

function MetadataRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1">
      <dt className="text-[11px] uppercase tracking-wider text-[var(--ink-secondary)]">{label}</dt>
      <dd className="text-right text-xs break-words text-[var(--ink-primary)]">{value}</dd>
    </div>
  );
}

/* ── Job group ────────────────────────────────────────────── */

function JobGroupCard({
  group,
  selectedKey,
  expanded,
  onSelect,
  onToggle,
}: {
  group: QueueJobGroup;
  selectedKey: string | null;
  expanded: boolean;
  onSelect: (item: QueueChunk) => void;
  onToggle: () => void;
}) {
  return (
    <div className="overflow-hidden rounded-xl border border-[var(--line)] bg-[var(--surface)]">
      <button
        aria-expanded={expanded}
        className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 text-left transition hover:bg-[var(--surface-raised)]"
        onClick={onToggle}
        type="button"
      >
        <span
          aria-hidden="true"
          className={`text-[10px] text-[var(--ink-secondary)] transition-transform ${
            expanded ? "rotate-90" : ""
          }`}
        >
          ▶
        </span>
        <span className="min-w-0 truncate text-sm font-semibold text-[var(--ink-primary)]">
          {group.job_title ?? "Untitled job"}
        </span>
        <StatusChip status={group.job_status} />
        <span className="shrink-0 text-xs text-[var(--ink-secondary)]">
          {group.written_chunks}/{group.total_chunks} written
          {group.pending_chunks > 0 ? ` · ${group.pending_chunks} pending` : ""}
          {group.failed_chunks > 0 ? ` · ${group.failed_chunks} failed` : ""}
        </span>
        <span className="ml-auto flex flex-wrap items-center gap-x-3 text-[11px] text-[var(--ink-secondary)]">
          <span>voice {group.voice_id}</span>
          <span>
            buffer {group.job_buffered_seconds.toFixed(0)}s / {group.job_target_buffer_seconds}s
          </span>
          {group.unplanned_chars > 0 && (
            <span>{group.unplanned_chars.toLocaleString()} chars unplanned</span>
          )}
        </span>
      </button>

      {expanded && (
        <div className="divide-y divide-[var(--line)] border-t border-[var(--line)]">
          {group.chunks_truncated && (
            <div className="px-4 py-2 text-[11px] text-[var(--ink-secondary)]">
              Showing the most recent chunks — older history is hidden.
            </div>
          )}
          {group.chunks.length === 0 ? (
            <div className="px-4 py-3 text-xs text-[var(--ink-secondary)]">
              No chunks planned yet.
            </div>
          ) : (
            group.chunks.map((item) => {
              const key = chunkKey(item);
              const isSelected = key === selectedKey;
              return (
                <button
                  aria-current={isSelected ? "true" : undefined}
                  className={`flex w-full items-center gap-3 px-4 py-2.5 text-left transition ${
                    isSelected ? "bg-[var(--amber-soft)]" : "hover:bg-[var(--surface-raised)]"
                  }`}
                  key={key}
                  onClick={() => onSelect(item)}
                  type="button"
                >
                  <StatusGlyph status={item.status} />
                  <span className="w-11 shrink-0 font-mono text-[11px] text-[var(--ink-secondary)]">
                    #{item.index}
                    {item.version > 0 ? ` v${item.version}` : ""}
                  </span>
                  <span
                    className={`min-w-0 flex-1 truncate text-sm ${
                      item.is_pending
                        ? "text-[var(--ink-primary)]"
                        : "text-[var(--ink-secondary)]"
                    }`}
                  >
                    {item.text.trim().slice(0, 120) || "(empty chunk)"}
                  </span>
                  {item.is_pending && item.in_next_batch && !item.is_rendering && (
                    <span className="shrink-0 rounded-md border border-[var(--emerald)]/20 bg-[var(--emerald)]/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-[var(--emerald)]">
                      Next
                    </span>
                  )}
                  {item.is_pending ? (
                    <PriorityBadge band={item.priority_band} label={item.priority_label} />
                  ) : (
                    item.status === "written" && (
                      <span className="shrink-0 text-[11px] text-[var(--ink-secondary)]">
                        {formatSeconds(item.duration_seconds)}
                      </span>
                    )
                  )}
                  <StatusChip status={item.status} />
                </button>
              );
            })
          )}
          {group.unplanned_chars > 0 && (
            <div className="px-4 py-2 text-[11px] italic text-[var(--ink-secondary)]">
              · {group.unplanned_chars.toLocaleString()} more characters not yet planned
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* ── Component ────────────────────────────────────────────── */

export function QueueInspector() {
  const scheduler = useAppStore((state) => state.adminState?.scheduler ?? null);
  const voices = useAppStore((state) => state.voices);

  const [snapshot, setSnapshot] = useState<AdminQueue | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [collapsedJobs, setCollapsedJobs] = useState<Set<string>>(() => new Set());
  const [actionPending, setActionPending] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<{
    type: "success" | "error";
    text: string;
  } | null>(null);
  const [isEditing, setIsEditing] = useState(false);
  const [draftText, setDraftText] = useState("");
  const [draftVoice, setDraftVoice] = useState("");
  const [now, setNow] = useState(() => Date.now() / 1000);

  const load = useCallback(async () => {
    try {
      const next = await api.getAdminQueue();
      setSnapshot(next);
      setLoadError(null);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "Unable to load the queue");
    } finally {
      setIsLoading(false);
    }
  }, []);

  // The scheduler pushes a lightweight tick every planning cycle. Refetch the
  // full queue only when that tick actually changes (depth or active batch),
  // so the view stays live without polling.
  const schedulerSignature = scheduler
    ? [
        scheduler.queue_depth,
        scheduler.active_batch?.started_at ?? "",
        scheduler.active_batch?.chunk_count ?? "",
        scheduler.active_batch?.voice_id ?? "",
      ].join(":")
    : "";

  useEffect(() => {
    void load();
  }, [load, schedulerSignature]);

  // Tick the "elapsed" counter while a batch is rendering.
  useEffect(() => {
    if (snapshot?.active_batch?.started_at == null) {
      return;
    }
    const timer = window.setInterval(() => setNow(Date.now() / 1000), 1000);
    return () => window.clearInterval(timer);
  }, [snapshot?.active_batch?.started_at]);

  const selected = useMemo(() => {
    if (!snapshot || !selectedKey) {
      return null;
    }
    for (const group of snapshot.jobs) {
      const match = group.chunks.find((item) => chunkKey(item) === selectedKey);
      if (match) {
        return match;
      }
    }
    return null;
  }, [snapshot, selectedKey]);

  const voiceOptions = useMemo(() => {
    const list = [...voices];
    if (draftVoice && !list.some((voice) => voice.id === draftVoice)) {
      list.unshift({ id: draftVoice, display_name: draftVoice, description: null });
    }
    return list;
  }, [voices, draftVoice]);

  const runAction = useCallback(
    async (key: string, action: () => Promise<unknown>, successText: string) => {
      setActionPending(key);
      setActionMessage(null);
      try {
        await action();
        setActionMessage({ type: "success", text: successText });
        await load();
      } catch (error) {
        setActionMessage({
          type: "error",
          text: error instanceof Error ? error.message : "Action failed",
        });
      } finally {
        setActionPending(null);
      }
    },
    [load],
  );

  function selectChunk(item: QueueChunk) {
    setSelectedKey(chunkKey(item));
    setIsEditing(false);
    setActionMessage(null);
  }

  function toggleJob(jobId: string) {
    setCollapsedJobs((current) => {
      const next = new Set(current);
      if (next.has(jobId)) {
        next.delete(jobId);
      } else {
        next.add(jobId);
      }
      return next;
    });
  }

  function handlePauseResume(item: QueueChunk) {
    const pausing = item.job_status !== "paused";
    void runAction(
      "pause-resume",
      () => (pausing ? api.pauseJob(item.job_id) : api.resumeJob(item.job_id)),
      pausing ? "Job paused" : "Job resumed",
    );
  }

  function startEditing(item: QueueChunk) {
    setDraftText(item.text);
    setDraftVoice(item.voice_id);
    setIsEditing(true);
    setActionMessage(null);
  }

  async function submitReprocess(item: QueueChunk) {
    await runAction(
      "reprocess",
      () =>
        api.reprocessChunk(item.job_id, item.index, {
          new_text: draftText,
          new_voice_id: draftVoice,
        }),
      "Chunk reprocessing queued",
    );
    setIsEditing(false);
  }

  function handleSetActive(item: QueueChunk, version: number) {
    void runAction(
      `version-${version}`,
      () => api.setActiveVersion(item.job_id, item.index, version),
      `Version ${version} activated`,
    );
  }

  const jobs = snapshot?.jobs ?? [];
  const activeBatch = snapshot?.active_batch ?? null;
  const nextBatch = snapshot?.next_batch ?? null;
  const elapsedSeconds =
    activeBatch?.started_at != null ? Math.max(0, now - activeBatch.started_at) : null;

  if (isLoading && !snapshot) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="flex items-center gap-3 text-sm text-[var(--ink-secondary)]">
          <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-[var(--amber)] border-t-transparent" />
          Loading scheduler queue…
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-xs uppercase tracking-[0.2em] text-[var(--ink-secondary)]">
            Scheduler
          </p>
          <h2 className="mt-1 text-xl font-bold text-[var(--ink-primary)]">Synthesis queue</h2>
          <p className="mt-1 max-w-3xl text-sm leading-relaxed text-[var(--ink-secondary)]">
            Every job's full chunk lifecycle — written, rendering, planned, and how much text the
            planner has not reached yet. Priority bands, batch grouping, and the predicted next
            batch come straight from the scheduler.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-xs text-[var(--ink-secondary)]">
            {snapshot?.queue_depth ?? 0} pending
          </span>
          <button
            className="rounded-lg border border-[var(--line)] bg-[var(--surface)] px-3 py-1.5 text-xs font-semibold text-[var(--ink-secondary)] transition hover:text-[var(--ink-primary)] disabled:opacity-50"
            disabled={actionPending !== null}
            onClick={() => void load()}
            type="button"
          >
            Refresh
          </button>
        </div>
      </div>

      {activeBatch && (
        <BatchStrip
          batch={activeBatch}
          elapsedSeconds={elapsedSeconds}
          label="Rendering now"
          live
        />
      )}
      {!activeBatch && nextBatch && <BatchStrip batch={nextBatch} label="Up next" />}

      {loadError && (
        <div className="mb-4 rounded-lg border border-[var(--rose)]/20 bg-[var(--rose)]/10 px-4 py-3 text-xs font-medium text-[var(--rose)]">
          {loadError}
        </div>
      )}

      <div
        className={`grid gap-4 ${
          selected ? "xl:grid-cols-[minmax(0,1fr)_400px]" : "grid-cols-1"
        }`}
      >
        {/* Job lifecycles */}
        <div className="min-w-0 space-y-3">
          {jobs.length === 0 ? (
            <div className="rounded-xl border border-[var(--line)] bg-[var(--surface)] px-4 py-12 text-center text-sm text-[var(--ink-secondary)]">
              {loadError
                ? "Queue unavailable — the last request failed. Use Refresh to retry."
                : "Nothing queued. The scheduler is idle."}
            </div>
          ) : (
            jobs.map((group) => (
              <JobGroupCard
                expanded={!collapsedJobs.has(group.job_id)}
                group={group}
                key={group.job_id}
                onSelect={selectChunk}
                onToggle={() => toggleJob(group.job_id)}
                selectedKey={selectedKey}
              />
            ))
          )}
        </div>

        {/* Detail sidebar */}
        {selected && (
          <aside
            aria-label="Chunk details"
            className="min-w-0 rounded-xl border border-[var(--line)] bg-[var(--surface)] p-5 xl:sticky xl:top-24 xl:max-h-[calc(100vh-7rem)] xl:self-start xl:overflow-y-auto"
          >
            <div className="space-y-4">
              <div>
                <div className="flex items-start justify-between gap-2">
                  <h3
                    className="min-w-0 flex-1 truncate text-sm font-semibold text-[var(--ink-primary)]"
                    title={selected.job_title ?? "Untitled job"}
                  >
                    {selected.job_title ?? "Untitled job"}
                  </h3>
                  <button
                    aria-label="Close chunk details"
                    className="-mr-1 -mt-1 shrink-0 rounded-md p-1 text-[var(--ink-secondary)] transition hover:bg-[var(--hover-bg)] hover:text-[var(--ink-primary)]"
                    onClick={() => setSelectedKey(null)}
                    type="button"
                  >
                    <svg
                      aria-hidden="true"
                      className="h-4 w-4"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      viewBox="0 0 24 24"
                    >
                      <path d="M6 6l12 12M18 6L6 18" strokeLinecap="round" />
                    </svg>
                  </button>
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-2">
                  <StatusChip status={selected.job_status} />
                  <span className="text-xs text-[var(--ink-secondary)]">
                    chunk #{selected.index} · v{selected.version}
                    {selected.is_pending ? ` · rank ${selected.rank}` : " · not pending"}
                  </span>
                </div>
              </div>

              {selected.is_pending ? (
                <div className="rounded-lg border border-[var(--line)] bg-[var(--surface-raised)] p-3">
                  <PriorityBadge band={selected.priority_band} label={selected.priority_label} />
                  <p className="mt-1.5 text-xs leading-relaxed text-[var(--ink-primary)]">
                    {selected.priority_reason}
                  </p>
                  <p className="mt-2 text-[11px] leading-relaxed text-[var(--ink-secondary)]">
                    band {selected.priority_band} · buffer{" "}
                    {selected.job_buffered_seconds.toFixed(1)}s / target{" "}
                    {selected.job_target_buffer_seconds}s ·{" "}
                    {selected.job_is_active_listening ? "active listener" : "not listening"}
                    {selected.in_next_batch ? " · in next batch" : ""}
                  </p>
                </div>
              ) : (
                <div className="rounded-lg border border-[var(--line)] bg-[var(--surface-raised)] p-3">
                  <div className="flex items-center gap-2">
                    <StatusChip status={selected.status} />
                    <span className="text-xs text-[var(--ink-primary)]">
                      {selected.status === "written"
                        ? `Rendered audio · ${formatSeconds(selected.duration_seconds)}`
                        : "This chunk is not scheduled for rendering."}
                    </span>
                  </div>
                </div>
              )}

              <div>
                <h4 className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-[var(--ink-secondary)]">
                  Chunk text
                </h4>
                <p className="max-h-56 overflow-y-auto whitespace-pre-wrap rounded-lg border border-[var(--line)] bg-[var(--canvas)] p-3 text-sm leading-relaxed text-[var(--ink-primary)]">
                  {selected.text}
                </p>
              </div>

              <dl className="divide-y divide-[var(--line)]">
                <MetadataRow label="Status" value={selected.status} />
                <MetadataRow label="Voice" value={selected.voice_id} />
                <MetadataRow
                  label="Model"
                  value={selected.model_id.split("/").pop() ?? selected.model_id}
                />
                <MetadataRow label="Language" value={selected.language} />
                <MetadataRow
                  label="Plan version"
                  value={`${selected.plan_version} · chunk v${selected.version}`}
                />
                <MetadataRow
                  label="Characters"
                  value={`${selected.char_count} (${selected.char_start}–${selected.char_end})`}
                />
                {selected.status === "written" ? (
                  <MetadataRow
                    label="Audio duration"
                    value={formatSeconds(selected.duration_seconds)}
                  />
                ) : (
                  <MetadataRow
                    label="Est. duration"
                    value={formatSeconds(selected.estimated_duration_seconds)}
                  />
                )}
                <MetadataRow label="Created" value={formatAge(selected.created_at)} />
                <MetadataRow label="Updated" value={formatAge(selected.updated_at)} />
              </dl>

              {selected.error && (
                <div className="rounded-lg border border-[var(--rose)]/20 bg-[var(--rose)]/10 px-3 py-2 text-xs text-[var(--rose)]">
                  {selected.error}
                </div>
              )}

              {selected.versions.length > 1 && (
                <div>
                  <h4 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-[var(--ink-secondary)]">
                    Versions
                  </h4>
                  <div className="flex flex-wrap gap-2">
                    {selected.versions.map((version) => (
                      <button
                        className={`rounded-md border px-2.5 py-1 text-[11px] font-medium transition disabled:cursor-not-allowed disabled:opacity-60 ${
                          version.version === selected.version
                            ? "border-[var(--amber)]/40 bg-[var(--amber-soft)] text-[var(--amber)]"
                            : "border-[var(--line)] bg-[var(--surface)] text-[var(--ink-secondary)] hover:text-[var(--ink-primary)]"
                        }`}
                        disabled={
                          version.version === selected.version || actionPending !== null
                        }
                        key={version.version}
                        onClick={() => handleSetActive(selected, version.version)}
                        type="button"
                      >
                        v{version.version} · {version.status}
                        {version.deprecated ? " · deprecated" : ""}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              <div className="flex flex-wrap gap-2 border-t border-[var(--line)] pt-4">
                <button
                  className="rounded-lg border border-[var(--line)] bg-[var(--surface)] px-3.5 py-2 text-xs font-semibold text-[var(--ink-secondary)] transition hover:text-[var(--ink-primary)] disabled:opacity-50"
                  disabled={actionPending !== null}
                  onClick={() => handlePauseResume(selected)}
                  type="button"
                >
                  {selected.job_status === "paused" ? "Resume job" : "Pause job"}
                </button>
                <button
                  className="rounded-lg bg-[var(--amber)] px-3.5 py-2 text-xs font-semibold text-white transition hover:brightness-110 disabled:opacity-50"
                  disabled={actionPending !== null}
                  onClick={() => startEditing(selected)}
                  type="button"
                >
                  Reprocess chunk
                </button>
              </div>

              {isEditing && (
                <div className="space-y-3 rounded-lg border border-[var(--line)] bg-[var(--surface-raised)] p-3">
                  <label className="block text-[11px] font-semibold uppercase tracking-wider text-[var(--ink-secondary)]">
                    Chunk text
                    <textarea
                      className="mt-1 h-28 w-full resize-y rounded-lg border border-[var(--line)] bg-[var(--canvas)] px-3 py-2 text-sm text-[var(--ink-primary)] focus:border-[var(--amber)] focus:outline-none"
                      onChange={(event) => setDraftText(event.target.value)}
                      value={draftText}
                    />
                  </label>
                  <label className="block text-[11px] font-semibold uppercase tracking-wider text-[var(--ink-secondary)]">
                    Voice
                    <select
                      className="mt-1 w-full rounded-lg border border-[var(--line)] bg-[var(--canvas)] px-3 py-2 text-sm text-[var(--ink-primary)] focus:border-[var(--amber)] focus:outline-none"
                      onChange={(event) => setDraftVoice(event.target.value)}
                      value={draftVoice}
                    >
                      {voiceOptions.map((voice) => (
                        <option key={voice.id} value={voice.id}>
                          {voice.display_name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <div className="flex gap-2">
                    <button
                      className="rounded-lg bg-[var(--amber)] px-3.5 py-2 text-xs font-semibold text-white transition hover:brightness-110 disabled:opacity-50"
                      disabled={actionPending !== null}
                      onClick={() => void submitReprocess(selected)}
                      type="button"
                    >
                      Queue reprocess
                    </button>
                    <button
                      className="rounded-lg border border-[var(--line)] bg-[var(--surface)] px-3.5 py-2 text-xs font-semibold text-[var(--ink-secondary)] transition hover:text-[var(--ink-primary)]"
                      onClick={() => setIsEditing(false)}
                      type="button"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}

              {actionMessage && (
                <div
                  aria-live="polite"
                  className={`rounded-lg border px-3 py-2 text-xs font-medium ${
                    actionMessage.type === "success"
                      ? "border-[var(--emerald)]/20 bg-[var(--emerald)]/10 text-[var(--emerald)]"
                      : "border-[var(--rose)]/20 bg-[var(--rose)]/10 text-[var(--rose)]"
                  }`}
                  role="alert"
                >
                  {actionMessage.text}
                </div>
              )}
            </div>
          </aside>
        )}
      </div>
    </div>
  );
}
