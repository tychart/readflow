import { useShallow } from "zustand/shallow";

import { useAppStore } from "../../state/store";
import type { Chunk, ChunkStatus, JobDetail } from "../../types/api";

/* ── Helpers (duplicated from ReaderPage for independence) ── */

function formatRelativeTime(timestamp: number | null): string {
  if (!timestamp) return "never";
  const deltaSeconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  return deltaSeconds === 0 ? "just now" : `${deltaSeconds}s ago`;
}

function getLatestVersion(chunks: Chunk[], index: number): number {
  let max = -1;
  for (const chunk of chunks) {
    if (chunk.index === index && chunk.version > max) max = chunk.version;
  }
  return max;
}

function getRetryCount(status: ChunkStatus, version: number): number {
  if (status === "max_retries_exceeded") return 3;
  return version;
}

function normalizeText(text: string): string {
  return text
    .replace(/\r\n/g, "\n").replace(/\r/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function getChunkText(chunk: Chunk, sourceText: string): string {
  const normalized = normalizeText(sourceText);
  return normalized.slice(chunk.char_start, chunk.char_end).trim();
}

/* ── Props ────────────────────────────────────────────────── */

export interface ReaderSidebarProps {
  /** The chunk currently being played / selected for detail view */
  detailChunk: Chunk | null;
  /** All active chunks (one per index, latest version) */
  activeChunks: Chunk[];
  /** All known chunks across all versions */
  knownChunks: Chunk[];
  /** Active version per chunk index */
  activeVersions: Map<number, number>;
  /** Index of the currently-playing chunk, or null */
  activeChunkIndex: number | null;
  /** Current job detail */
  job: JobDetail | null;

  /* ── Editing state ── */
  editingChunkIndex: number | null;
  editText: string;
  setEditText: (text: string) => void;
  reprocessingChunkIndex: number | null;
  reprocessError: string | null;

  /* ── Handlers ── */
  onVoiceChange: (voiceId: string) => void;
  onVersionChange: (chunkIndex: number, version: number) => void;
  onReprocess: (chunkIndex: number, newText?: string) => void;
  onStartEdit: (chunk: Chunk) => void;
  onSaveEdit: () => void;
  onCancelEdit: () => void;

  /* ── Player diagnostics ── */
  appendedChunksCount: number;
  playbackAnchorIndex: number;
  expectedNextChunkIndex: number | null;
  playIntent: boolean;
  playerState: string;
  isActuallyPlaying: boolean;
  audioDiagnostics: { paused: boolean; readyState: number; networkState: number };
  isWaitingForData: boolean;
  bufferedUntilSeconds: number;
  currentTimeSeconds: number;
  lastPlayerError: string | null;
  lastPlaybackSyncError: string | null;
  isJobTerminal: boolean;

  /* ── Reader state diagnostics ── */
  lastRefreshAt: number | null;
  lastRefreshReason: string;

  /* ── Sidebar control ── */
  /** Whether the sidebar is currently open */
  isOpen: boolean;
  /** Toggle open/closed */
  onToggle: () => void;
  /** True when rendered as an overlay drawer (<lg breakpoint) */
  isOverlay: boolean;
}

/* ── Component ────────────────────────────────────────────── */

export function ReaderSidebar({
  detailChunk,
  activeChunks,
  knownChunks,
  activeVersions,
  activeChunkIndex,
  job,
  editingChunkIndex,
  editText,
  setEditText,
  reprocessingChunkIndex,
  reprocessError,
  onVoiceChange,
  onVersionChange,
  onReprocess,
  onStartEdit,
  onSaveEdit,
  onCancelEdit,
  appendedChunksCount,
  playbackAnchorIndex,
  expectedNextChunkIndex,
  playIntent,
  playerState,
  isActuallyPlaying,
  audioDiagnostics,
  isWaitingForData,
  bufferedUntilSeconds,
  currentTimeSeconds,
  lastPlayerError,
  lastPlaybackSyncError,
  isJobTerminal,
  lastRefreshAt,
  lastRefreshReason,
  isOpen,
  onToggle,
  isOverlay,
}: ReaderSidebarProps) {
  // Store-sourced state
  const { voices, websocketStatus, lastSocketMessageAt, lastSocketError, isSocketStale } =
    useAppStore(
      useShallow((state) => ({
        voices: state.voices,
        websocketStatus: state.websocketStatus,
        lastSocketMessageAt: state.lastSocketMessageAt,
        lastSocketError: state.lastSocketError,
        isSocketStale: state.isSocketStale,
      })),
    );

  /* ── Render chunk detail panel ────────────────────────── */
  const renderDetailPanel = () => {
    if (!detailChunk) {
      return (
        <div className="rounded-lg border border-[var(--line)] bg-[var(--surface)] p-4">
          <p className="text-sm text-[var(--ink-secondary)]">
            Hover a chunk or start playback to see details.
          </p>
        </div>
      );
    }

    const chunk = detailChunk;
    const sourceText = job?.source_text ?? "";
    const chunkText = job ? getChunkText(chunk, sourceText) : "";
    const isEditing = editingChunkIndex === chunk.index;
    const allVersions = knownChunks.filter((c) => c.index === chunk.index);
    const maxVersion = getLatestVersion(knownChunks, chunk.index);
    const maxRetriesReached = chunk.status === "max_retries_exceeded" || maxVersion >= 3;

    return (
      <div className="rounded-lg border border-[var(--line)] bg-[var(--surface)] p-4">
        <div className="mb-3 flex items-center justify-between">
          <span className="text-sm font-semibold text-[var(--ink-primary)]">
            Chunk {chunk.index + 1}
          </span>
          {allVersions.length > 1 ? (
            <select
              className="rounded-md border border-[var(--line)] bg-[var(--surface)] px-2 py-1 text-xs text-[var(--ink-primary)]"
              value={activeVersions.get(chunk.index) ?? chunk.version}
              onChange={(e) => onVersionChange(chunk.index, Number(e.target.value))}
            >
              {allVersions.map((v) => (
                <option key={v.version} value={v.version}>
                  V{v.version} {v.status === "written" ? "✓" : v.status}
                </option>
              ))}
            </select>
          ) : null}
        </div>

        {/* Text */}
        <div className="mb-3 rounded-md bg-[var(--canvas)]/50 p-3">
          {isEditing ? (
            <div className="space-y-2">
              <textarea
                className="w-full resize-none rounded-md border border-[var(--line)] bg-[var(--surface)] p-2 text-sm leading-relaxed text-[var(--ink-primary)]"
                rows={3}
                value={editText}
                onChange={(e) => setEditText(e.target.value)}
              />
              <div className="flex gap-2">
                <button
                  className="rounded-md bg-[var(--amber)] px-3 py-1.5 text-xs font-semibold text-white"
                  onClick={onSaveEdit}
                >
                  Save &amp; Reprocess
                </button>
                <button
                  className="rounded-md border border-[var(--line)] px-3 py-1.5 text-xs font-semibold text-[var(--ink-secondary)] hover:text-[var(--ink-primary)]"
                  onClick={onCancelEdit}
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <div>
              <p className="max-h-20 overflow-y-auto text-sm leading-relaxed text-[var(--ink-primary)]">
                {chunkText || "(empty text)"}
              </p>
              <button
                className="mt-1 text-xs text-[var(--ink-secondary)] hover:text-[var(--amber)]"
                onClick={() => onStartEdit(chunk)}
              >
                Edit text
              </button>
            </div>
          )}
        </div>

        {/* Status badges */}
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <span
            className={`rounded-md px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider ${
              chunk.status === "written"
                ? "border border-[var(--emerald)]/20 bg-[var(--emerald)]/10 text-[var(--emerald)]"
                : chunk.status === "failed" || chunk.status === "max_retries_exceeded"
                  ? "border border-[var(--rose)]/20 bg-[var(--rose)]/10 text-[var(--rose)]"
                  : "border border-[var(--line)] bg-white/5 text-[var(--ink-secondary)]"
            }`}
          >
            {chunk.status}
          </span>
          {chunk.duration_seconds > 0 ? (
            <span className="text-xs text-[var(--ink-secondary)]">
              {chunk.duration_seconds.toFixed(1)}s
            </span>
          ) : null}
          <span className="text-xs text-[var(--ink-secondary)]">V{chunk.version}</span>
        </div>

        {/* Reprocess button */}
        {!maxRetriesReached && (chunk.status === "written" || chunk.status === "failed") ? (
          <button
            className={`w-full rounded-md px-3 py-2 text-xs font-semibold transition ${
              reprocessingChunkIndex === chunk.index
                ? "bg-[var(--surface-raised)] text-[var(--ink-secondary)]"
                : "bg-[var(--amber-soft)] text-[var(--amber)] hover:brightness-110"
            }`}
            onClick={() => (isEditing ? onSaveEdit() : void onReprocess(chunk.index))}
            disabled={reprocessingChunkIndex === chunk.index}
          >
            {reprocessingChunkIndex === chunk.index
              ? "Reprocessing…"
              : chunk.status === "failed"
                ? `Retry (${getRetryCount(chunk.status, chunk.version)}/3)`
                : `Reprocess (${getRetryCount(chunk.status, chunk.version)}/3)`}
          </button>
        ) : null}

        {maxRetriesReached ? (
          <div className="rounded-md bg-[var(--rose)]/10 px-3 py-2 text-xs text-[var(--rose)]">
            Max retries exceeded (3/3)
          </div>
        ) : null}

        {reprocessError ? (
          <div className="mt-2 rounded-md bg-[var(--rose)]/10 px-3 py-2 text-xs text-[var(--rose)]">
            {reprocessError}
          </div>
        ) : null}
      </div>
    );
  };

  /* ── Content (shared between inline and overlay modes) ─── */
  const content = (
    <div className="space-y-4">
      {/* Chunk detail */}
      {renderDetailPanel()}

      {/* Voice selector */}
      <div className="rounded-lg border border-[var(--line)] bg-[var(--surface)] p-4">
        <label
          className="mb-2 block text-xs font-medium uppercase tracking-wider text-[var(--ink-secondary)]"
          htmlFor="voice-change-select"
        >
          Voice for future chunks
        </label>
        <select
          className="w-full rounded-md border border-[var(--line)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--ink-primary)]"
          id="voice-change-select"
          onChange={(event) => void onVoiceChange(event.target.value)}
          value={job?.voice_id ?? ""}
        >
          {voices.map((voice) => (
            <option key={voice.id} value={voice.id}>
              {voice.display_name}
            </option>
          ))}
        </select>
      </div>

      {/* Live diagnostics (collapsible) */}
      <details className="rounded-lg border border-[var(--line)] bg-[var(--surface)] p-4">
        <summary className="cursor-pointer text-xs font-semibold uppercase tracking-wider text-[var(--ink-secondary)]">
          Live diagnostics
        </summary>
        <div className="mt-3 grid gap-2 text-xs text-[var(--ink-secondary)]">
          <div className="flex justify-between">
            <span>Socket</span>
            <span>
              {isJobTerminal ? "idle" : websocketStatus}
              {isSocketStale ? " (stale)" : ""}
            </span>
          </div>
          <div className="flex justify-between">
            <span>Last live event</span>
            <span>{formatRelativeTime(lastSocketMessageAt)}</span>
          </div>
          <div className="flex justify-between">
            <span>Reader refresh</span>
            <span>
              {formatRelativeTime(lastRefreshAt)} via {lastRefreshReason}
            </span>
          </div>
          <div className="flex justify-between">
            <span>Appended chunks</span>
            <span>{appendedChunksCount}</span>
          </div>
          <div className="flex justify-between">
            <span>Playback anchor</span>
            <span>Chunk {playbackAnchorIndex + 1}</span>
          </div>
          <div className="flex justify-between">
            <span>Expected next</span>
            <span>
              {expectedNextChunkIndex === null
                ? "none"
                : `Chunk ${expectedNextChunkIndex + 1}`}
            </span>
          </div>
          <div className="flex justify-between">
            <span>Playback intent</span>
            <span>{playIntent ? "armed" : "paused"}</span>
          </div>
          <div className="flex justify-between">
            <span>Player state</span>
            <span>{playerState}</span>
          </div>
          <div className="flex justify-between">
            <span>Audio</span>
            <span>
              {isActuallyPlaying
                ? "playing"
                : audioDiagnostics.paused
                  ? "paused"
                  : "ready"}
            </span>
          </div>
          <div className="flex justify-between">
            <span>Waiting for data</span>
            <span>{isWaitingForData ? "yes" : "no"}</span>
          </div>
          <div className="flex justify-between">
            <span>Buffered until</span>
            <span>{bufferedUntilSeconds.toFixed(1)}s</span>
          </div>
          <div className="flex justify-between">
            <span>Current time</span>
            <span>{currentTimeSeconds.toFixed(1)}s</span>
          </div>
          <div className="flex justify-between">
            <span>Audio ready/network</span>
            <span>
              {audioDiagnostics.readyState}/{audioDiagnostics.networkState}
            </span>
          </div>
          {lastPlayerError || lastPlaybackSyncError || lastSocketError ? (
            <div className="mt-2 rounded-md bg-[var(--rose)]/10 px-2 py-1 text-[var(--rose)]">
              {lastPlayerError ?? lastPlaybackSyncError ?? lastSocketError}
            </div>
          ) : null}
        </div>
      </details>

      {/* Chunk status list */}
      <details className="rounded-lg border border-[var(--line)] bg-[var(--surface)] p-4">
        <summary className="cursor-pointer text-xs font-semibold uppercase tracking-wider text-[var(--ink-secondary)]">
          All chunks ({activeChunks.length})
        </summary>
        <div className="mt-3 space-y-1">
          {activeChunks.map((chunk) => {
            const allVersions = knownChunks.filter((c) => c.index === chunk.index);
            return (
              <div
                className={`flex items-center justify-between rounded-md px-3 py-2 text-xs ${
                  chunk.index === activeChunkIndex
                    ? "bg-[var(--amber-soft)]"
                    : "bg-[var(--canvas)]/30"
                }`}
                key={chunk.index}
              >
                <div className="flex items-center gap-2">
                  <span className="font-medium text-[var(--ink-primary)]">
                    Chunk {chunk.index + 1}
                  </span>
                  <span
                    className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${
                      chunk.status === "written"
                        ? "bg-[var(--emerald)]/10 text-[var(--emerald)]"
                        : chunk.status === "failed" ||
                            chunk.status === "max_retries_exceeded"
                          ? "bg-[var(--rose)]/10 text-[var(--rose)]"
                          : "bg-white/5 text-[var(--ink-secondary)]"
                    }`}
                  >
                    {chunk.status}
                  </span>
                  {chunk.duration_seconds > 0 ? (
                    <span className="text-[var(--ink-secondary)]">
                      {chunk.duration_seconds.toFixed(1)}s
                    </span>
                  ) : null}
                </div>
                <div className="flex items-center gap-1">
                  {allVersions.map((v) => (
                    <button
                      key={v.version}
                      className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${
                        v.version === chunk.version
                          ? "bg-[var(--amber)] text-white"
                          : v.deprecated
                            ? "text-[var(--ink-secondary)]/50 line-through"
                            : "text-[var(--ink-secondary)] hover:text-[var(--ink-primary)]"
                      }`}
                      onClick={() => onVersionChange(chunk.index, v.version)}
                    >
                      V{v.version}
                    </button>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </details>
    </div>
  );

  /* ── Overlay drawer mode (< lg) ───────────────────────── */
  if (isOverlay) {
    return (
      <>
        {/* Toggle button — floating */}
        <button
          aria-label={isOpen ? "Close sidebar" : "Open sidebar"}
          className={`fixed bottom-6 right-6 z-50 flex h-12 w-12 items-center justify-center rounded-full bg-[var(--amber)] text-white shadow-lg shadow-[var(--amber-soft)] transition-all hover:brightness-110 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--amber)] ${
            isOpen ? "scale-90 opacity-0 pointer-events-none" : "scale-100 opacity-100"
          }`}
          onClick={onToggle}
          type="button"
        >
          {/* Layers icon */}
          <svg
            aria-hidden="true"
            className="h-5 w-5"
            fill="none"
            stroke="currentColor"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="2"
            viewBox="0 0 24 24"
          >
            <path d="M12 2L2 7l10 5 10-5-10-5z" />
            <path d="M2 17l10 5 10-5" />
            <path d="M2 12l10 5 10-5" />
          </svg>
        </button>

        {/* Backdrop */}
        {isOpen && (
          <div
            aria-hidden="true"
            className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm transition-opacity"
            onClick={onToggle}
          />
        )}

        {/* Drawer */}
        <div
          className={`fixed right-0 top-0 z-50 h-full w-80 border-l border-[var(--line)] bg-[var(--canvas)] shadow-2xl transition-transform duration-300 ease-in-out ${
            isOpen ? "translate-x-0" : "translate-x-full"
          }`}
        >
          {/* Drawer header */}
          <div className="flex items-center justify-between border-b border-[var(--line)] px-4 py-3">
            <span className="text-xs font-semibold uppercase tracking-wider text-[var(--ink-secondary)]">
              Details
            </span>
            <button
              aria-label="Close sidebar"
              className="rounded-md p-1 text-[var(--ink-secondary)] hover:bg-[var(--hover-bg)] hover:text-[var(--ink-primary)]"
              onClick={onToggle}
              type="button"
            >
              <svg
                aria-hidden="true"
                className="h-4 w-4"
                fill="none"
                stroke="currentColor"
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth="2"
                viewBox="0 0 24 24"
              >
                <line x1="18" x2="6" y1="6" y2="18" />
                <line x1="6" x2="18" y1="6" y2="18" />
              </svg>
            </button>
          </div>
          {/* Scrollable content */}
          <div className="h-[calc(100%-49px)] overflow-y-auto px-4 py-4">
            {content}
          </div>
        </div>
      </>
    );
  }

  /* ── Inline mode (≥ lg) ───────────────────────────────── */
  return (
    <div
      className={`w-80 shrink-0 transition-all duration-300 ${
        isOpen ? "opacity-100" : "w-0 overflow-hidden opacity-0"
      }`}
    >
      {/* Sidebar content — sticky below the header + playbar */}
      <div
        className="overflow-y-auto"
        style={{
          position: "sticky",
          top: "176px", /* 56px header + ~120px playbar (expanded) */
          maxHeight: "calc(100vh - 176px)",
        }}
      >
        {/* Header with toggle */}
        <div className="mb-3 flex items-center justify-between">
          <span className="text-xs font-semibold uppercase tracking-wider text-[var(--ink-secondary)]">
            Details
          </span>
          <button
            aria-label="Close sidebar"
            className="rounded-md p-1 text-[var(--ink-secondary)] hover:bg-[var(--hover-bg)] hover:text-[var(--ink-primary)]"
            onClick={onToggle}
            type="button"
          >
            <svg
              aria-hidden="true"
              className="h-4 w-4"
              fill="none"
              stroke="currentColor"
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth="2"
              viewBox="0 0 24 24"
            >
              <line x1="18" x2="6" y1="6" y2="18" />
              <line x1="6" x2="18" y1="6" y2="18" />
            </svg>
          </button>
        </div>
        {content}
      </div>
    </div>
  );
}
