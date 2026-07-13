import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useParams } from "react-router-dom";
import { useShallow } from "zustand/shallow";

import { api } from "../../lib/api";
import { liveClient } from "../../lib/live-client";
import { Playbar } from "../../components/Playbar";
import type { TimelineSlotData } from "../../components/WaveformTimeline";
import { useAppBootstrap } from "../../hooks/useAppBootstrap";
import { useMediaSourcePlayer } from "../../lib/media-source";
import { useAppStore } from "../../state/store";
import type { Chunk, ChunkStatus, JobDetail, JobManifest, JobStatus } from "../../types/api";

/* ── Constants ────────────────────────────────────────────── */

const TERMINAL_JOB_STATUSES: JobStatus[] = ["completed", "failed"];
const READER_POLL_INTERVAL_MS = 2_000;
const PLAYBACK_SYNC_INTERVAL_MS = 3_000;
const GAP_BUFFERING_EPSILON_SECONDS = 0.5;

/* ── Types ────────────────────────────────────────────────── */

type TimelineSlotState =
  | "played"
  | "playing"
  | "ready"
  | "ready_after_gap"
  | "missing_expected"
  | "failed";


interface StreamEventPayload {
  job?: JobDetail;
  mime_type?: string;
  init_segment_url?: string | null;
}

interface ActiveChunkProgress {
  activeChunkIndex: number | null;
  fillByIndex: Map<number, number>;
  playedIndexes: Set<number>;
}

/* ── Helpers ──────────────────────────────────────────────── */

function formatRelativeTime(timestamp: number | null): string {
  if (!timestamp) return "never";
  const deltaSeconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  return deltaSeconds === 0 ? "just now" : `${deltaSeconds}s ago`;
}

function isTerminalStatus(status: JobStatus | undefined): boolean {
  return status ? TERMINAL_JOB_STATUSES.includes(status) : false;
}

function sortChunks(chunks: Chunk[]): Chunk[] {
  return [...chunks].sort((left, right) => left.index - right.index);
}

function buildManifestFromEvent(
  job: JobDetail,
  previousManifest: JobManifest | null,
  payload?: StreamEventPayload,
): JobManifest | null {
  const nextMimeType = payload?.mime_type ?? previousManifest?.mime_type ?? null;
  const nextInitSegmentUrl =
    payload && "init_segment_url" in payload
      ? payload.init_segment_url ?? null
      : previousManifest?.init_segment_url ?? null;
  if (!nextMimeType) return null;
  return {
    mime_type: nextMimeType,
    init_segment_url: nextInitSegmentUrl,
    chunks: sortChunks(job.chunks),
  } satisfies JobManifest;
}

function mergeKnownChunks(job: JobDetail | null, manifest: JobManifest | null): Chunk[] {
  if (manifest) return sortChunks(manifest.chunks);
  if (job) return sortChunks(job.chunks);
  return [];
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

function deriveActiveVersions(chunks: Chunk[]): Map<number, number> {
  const versions = new Map<number, number>();
  for (const chunk of chunks) {
    const existing = versions.get(chunk.index);
    if (existing === undefined || chunk.version > existing) {
      versions.set(chunk.index, chunk.version);
    }
  }
  return versions;
}

function getLatestVersion(chunks: Chunk[], index: number): number {
  let max = -1;
  for (const chunk of chunks) {
    if (chunk.index === index && chunk.version > max) max = chunk.version;
  }
  return max;
}

function isReprocessing(status: ChunkStatus): boolean {
  return status === "planned" || status === "queued" || status === "rendering" || status === "reprocessing";
}

function getRetryCount(status: ChunkStatus, version: number): number {
  if (status === "max_retries_exceeded") return 3;
  return version;
}

function buildStreamManifest(
  fullManifest: JobManifest | null,
  contiguousReadyChunks: Chunk[],
): JobManifest | null {
  if (!fullManifest) return null;
  let runningStart = 0;
  const normalizedChunks = contiguousReadyChunks.map((chunk) => {
    const normalized = { ...chunk, start_seconds: runningStart };
    runningStart += chunk.duration_seconds;
    return normalized;
  });
  return { mime_type: fullManifest.mime_type, init_segment_url: fullManifest.init_segment_url, chunks: normalizedChunks };
}

function deriveActiveChunkProgress(
  contiguousReadyChunks: Chunk[],
  currentTimeSeconds: number,
): ActiveChunkProgress {
  const fillByIndex = new Map<number, number>();
  const playedIndexes = new Set<number>();
  let remaining = Math.max(0, currentTimeSeconds);
  let activeChunkIndex: number | null = null;
  for (const chunk of contiguousReadyChunks) {
    if (remaining >= chunk.duration_seconds) {
      fillByIndex.set(chunk.index, 100);
      playedIndexes.add(chunk.index);
      remaining -= chunk.duration_seconds;
      continue;
    }
    fillByIndex.set(chunk.index, chunk.duration_seconds > 0 ? (remaining / chunk.duration_seconds) * 100 : 0);
    activeChunkIndex = chunk.index;
    break;
  }
  return { activeChunkIndex, fillByIndex, playedIndexes };
}

/* ── Store state type ─────────────────────────────────────── */

interface ReaderPageStoreState {
  voices: ReturnType<typeof useAppStore.getState>["voices"];
  lastEvent: ReturnType<typeof useAppStore.getState>["lastEvent"];
  websocketStatus: ReturnType<typeof useAppStore.getState>["websocketStatus"];
  lastSocketMessageAt: ReturnType<typeof useAppStore.getState>["lastSocketMessageAt"];
  lastSocketError: ReturnType<typeof useAppStore.getState>["lastSocketError"];
  isSocketStale: ReturnType<typeof useAppStore.getState>["isSocketStale"];
}

/* ── Component ────────────────────────────────────────────── */

export function ReaderPage() {
  const { jobId = "" } = useParams();
  const {
    voices,
    lastEvent,
    websocketStatus,
    lastSocketMessageAt,
    lastSocketError,
    isSocketStale,
  } = useAppStore(
    useShallow(
      (state): ReaderPageStoreState => ({
        voices: state.voices,
        lastEvent: state.lastEvent,
        websocketStatus: state.websocketStatus,
        lastSocketMessageAt: state.lastSocketMessageAt,
        lastSocketError: state.lastSocketError,
        isSocketStale: state.isSocketStale,
      }),
    ),
  );

  const [job, setJob] = useState<JobDetail | null>(null);
  const [manifest, setManifest] = useState<JobManifest | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [playIntent, setPlayIntent] = useState(false);
  const [playbackAnchorIndex, setPlaybackAnchorIndex] = useState(0);
  const [lastRefreshAt, setLastRefreshAt] = useState<number | null>(null);
  const [lastRefreshReason, setLastRefreshReason] = useState("initial");
  const [lastPlaybackSyncError, setLastPlaybackSyncError] = useState<string | null>(null);


  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [isDownloading, setIsDownloading] = useState(false);
  const [editingChunkIndex, setEditingChunkIndex] = useState<number | null>(null);
  const [editText, setEditText] = useState("");
  const [reprocessingChunkIndex, setReprocessingChunkIndex] = useState<number | null>(null);
  const [reprocessError, setReprocessError] = useState<string | null>(null);
  const [seekOverride, setSeekOverride] = useState<number | null>(null);

  const refreshRequestIdRef = useRef(0);
  const lastAppliedRequestIdRef = useRef(0);
  const refreshInFlightRef = useRef<Promise<void> | null>(null);
  const queuedRefreshReasonRef = useRef<string | null>(null);
  const lastPlaybackSyncAtRef = useRef(0);
  const manifestRef = useRef<JobManifest | null>(null);

  const [hoveredChunkIndex, setHoveredChunkIndex] = useState<number | null>(null);

  const isJobTerminal = isTerminalStatus(job?.status);
  useAppBootstrap(!loading && !!job && !isJobTerminal);

  // ── Derived data ────────────────────────────────────────
  const knownChunks = useMemo(() => mergeKnownChunks(job, manifest), [job, manifest]);
  const activeVersions = useMemo(() => {
    const versions = new Map<number, number>();
    const av = job?.active_chunk_version;
    if (av && Object.keys(av).length > 0) {
      for (const [idxStr, ver] of Object.entries(av)) {
        versions.set(Number(idxStr), ver);
      }
    }
    for (const chunk of knownChunks) {
      if (!versions.has(chunk.index)) {
        const derived = deriveActiveVersions([chunk]);
        for (const [idx, ver] of derived) versions.set(idx, ver);
      }
    }
    return versions;
  }, [job?.active_chunk_version, knownChunks]);

  useEffect(() => {
    if (knownChunks.length === 0) {
      if (playbackAnchorIndex !== 0) setPlaybackAnchorIndex(0);
      return;
    }
    if (!knownChunks.some((c) => c.index === playbackAnchorIndex)) {
      setPlaybackAnchorIndex(knownChunks[0]?.index ?? 0);
    }
  }, [knownChunks, playbackAnchorIndex]);

  const anchoredChunks = useMemo(
    () => knownChunks.filter((c) => c.index >= playbackAnchorIndex),
    [knownChunks, playbackAnchorIndex],
  );

  const contiguousReadyChunks = useMemo(() => {
    const contiguous: Chunk[] = [];
    for (const chunk of anchoredChunks) {
      if (chunk.status !== "written") break;
      contiguous.push(chunk);
    }
    return contiguous;
  }, [anchoredChunks]);

  const activeChunks = useMemo(() => {
    const result: Chunk[] = [];
    for (const chunk of knownChunks) {
      const activeVer = activeVersions.get(chunk.index);
      if (activeVer !== undefined && chunk.version === activeVer && !result.some((c) => c.index === chunk.index)) {
        result.push(chunk);
      }
    }
    return result;
  }, [knownChunks, activeVersions]);

  const activeContiguousReadyIndexes = useMemo(() => {
    const set = new Set<number>();
    for (const chunk of contiguousReadyChunks) {
      const activeVer = activeVersions.get(chunk.index);
      if (activeVer !== undefined && chunk.version === activeVer) set.add(chunk.index);
    }
    return set;
  }, [contiguousReadyChunks, activeVersions]);

  const activeFirstGapChunk = useMemo(
    () => activeChunks.find((c) => c.status !== "written") ?? null,
    [activeChunks],
  );
  const expectedNextChunkIndex = activeFirstGapChunk?.index ?? null;
  const writtenAfterGapIndexes = useMemo(
    () => new Set(
      activeChunks.filter(
        (c) => c.index >= (expectedNextChunkIndex ?? Number.POSITIVE_INFINITY) && c.status === "written",
      ).map((c) => c.index),
    ),
    [activeChunks, expectedNextChunkIndex],
  );
  const missingExpectedIndexes = useMemo(
    () => new Set(
      activeChunks.filter((c) => c.status !== "written" && c.status !== "failed").map((c) => c.index),
    ),
    [activeChunks],
  );

  const streamManifest = useMemo(
    () => buildStreamManifest(manifest, contiguousReadyChunks),
    [contiguousReadyChunks, manifest],
  );

  const downloadableChunks = useMemo(() => {
    const contiguous: Chunk[] = [];
    for (const chunk of knownChunks) {
      if (chunk.index !== contiguous.length || chunk.status !== "written" || !chunk.segment_url) break;
      contiguous.push(chunk);
    }
    return contiguous;
  }, [knownChunks]);

  const canDownloadRenderedAudio = downloadableChunks.length > 0;
  const isDownloadComplete = !!job && isJobTerminal && downloadableChunks.length > 0 && downloadableChunks.length === knownChunks.length;

  const {
    audioRef,
    appendedChunksCount,
    bufferedUntilSeconds,
    currentTimeSeconds,
    diagnostics,
    isActuallyPlaying,
    isAutoplayBlocked,
    isWaitingForData,
    isStreamPrimed,
    lastPlayerError,
    pausePlayback,
    playerState,
    renderedDurationSeconds,
    requestUserGesturePlay,
    seekToSeconds,
  } = useMediaSourcePlayer({
    jobId,
    manifest: streamManifest,
    playbackAnchorIndex,
    playIntent,
    isTerminal: isJobTerminal,
  });

  const activeProgress = useMemo(
    () => deriveActiveChunkProgress(contiguousReadyChunks, currentTimeSeconds),
    [contiguousReadyChunks, currentTimeSeconds],
  );


  // ── Timeline slots (for WaveformTimeline) ───────────────
  const timelineSlots = useMemo<TimelineSlotData[]>(() => {
    return activeChunks.map((chunk) => {
      let state: TimelineSlotState;
      if (chunk.status === "failed" || chunk.status === "max_retries_exceeded") {
        state = "failed";
      } else if (activeProgress.activeChunkIndex === chunk.index) {
        state = "playing";
      } else if (activeProgress.playedIndexes.has(chunk.index)) {
        state = "played";
      } else if (chunk.index < playbackAnchorIndex && chunk.status === "written") {
        state = "ready";
      } else if (activeContiguousReadyIndexes.has(chunk.index)) {
        state = "ready";
      } else if (writtenAfterGapIndexes.has(chunk.index)) {
        state = "ready_after_gap";
      } else if (missingExpectedIndexes.has(chunk.index)) {
        state = "missing_expected";
      } else if (chunk.status === "written") {
        state = "ready";
      } else if (isReprocessing(chunk.status)) {
        state = "missing_expected";
      } else {
        state = "missing_expected";
      }

      return {
        chunkIndex: chunk.index,
        state,
        durationSeconds: chunk.duration_seconds > 0 ? chunk.duration_seconds : 4,
        isLive: state === "playing",
      };
    });
  }, [activeChunks, activeProgress, activeContiguousReadyIndexes, playbackAnchorIndex, writtenAfterGapIndexes, missingExpectedIndexes]);

  const detailSlot = useMemo(() => {
    const targetIndex = hoveredChunkIndex ?? activeProgress.activeChunkIndex;
    if (targetIndex === null) return null;
    return activeChunks.find((c) => c.index === targetIndex) ?? null;
  }, [activeProgress.activeChunkIndex, hoveredChunkIndex, activeChunks]);

  const shouldUsePollingFallback = !!job && !isTerminalStatus(job.status) && (websocketStatus !== "open" || isSocketStale);

  // ── Effects ─────────────────────────────────────────────
  useEffect(() => { manifestRef.current = manifest; }, [manifest]);

  const refreshReaderState = useCallback(
    async (reason: string, showLoading = false) => {
      if (!jobId) return;
      if (refreshInFlightRef.current) {
        queuedRefreshReasonRef.current = reason;
        return refreshInFlightRef.current;
      }
      if (showLoading) setLoading(true);
      const requestId = ++refreshRequestIdRef.current;
      const task = Promise.all([api.getJob(jobId), api.getManifest(jobId)])
        .then(([nextJob, nextManifest]) => {
          if (requestId < lastAppliedRequestIdRef.current) return;
          lastAppliedRequestIdRef.current = requestId;
          setJob(nextJob);
          setManifest(nextManifest);
          setError(null);
          setLastRefreshAt(Date.now());
          setLastRefreshReason(reason);
        })
        .catch((loadError) => {
          setError(loadError instanceof Error ? loadError.message : "Unable to refresh reader state");
        })
        .finally(async () => {
          refreshInFlightRef.current = null;
          if (showLoading) setLoading(false);
          const queuedReason = queuedRefreshReasonRef.current;
          queuedRefreshReasonRef.current = null;
          if (queuedReason) await refreshReaderState(queuedReason);
        });
      refreshInFlightRef.current = task;
      return task;
    },
    [jobId],
  );

  const syncPlaybackState = useCallback(
    (force = false, isPlayingOverride?: boolean) => {
      if (!job || !audioRef.current || isJobTerminal) return;
      const now = Date.now();
      if (!force && now - lastPlaybackSyncAtRef.current < PLAYBACK_SYNC_INTERVAL_MS) return;
      lastPlaybackSyncAtRef.current = now;
      const isPlaying = isPlayingOverride ?? (playIntent && (!audioRef.current.paused || isWaitingForData));
      const currentTime = audioRef.current.currentTime ?? 0;
      const sent = liveClient.sendPlaybackSync(job.id, currentTime, isPlaying);
      if (sent) {
        setLastPlaybackSyncError(null);
      } else {
        void api.updatePlayback(job.id, currentTime, isPlaying)
          .then(() => setLastPlaybackSyncError(null))
          .catch((syncError) => {
            setLastPlaybackSyncError(syncError instanceof Error ? `Playback sync failed: ${syncError.message}` : "Playback sync failed");
          });
      }
    },
    [audioRef, isJobTerminal, isWaitingForData, job, playIntent],
  );

  useEffect(() => { void refreshReaderState("initial", true); }, [refreshReaderState]);

  useEffect(() => {
    const payload = lastEvent?.payload as StreamEventPayload | undefined;
    const eventJob = payload?.job;
    if (!lastEvent || !eventJob || eventJob.id !== jobId) return;
    if (lastEvent.type !== "job_updated" && lastEvent.type !== "job_completed" && lastEvent.type !== "chunk_ready") return;
    setJob(eventJob);
    setManifest((prev) => buildManifestFromEvent(eventJob, prev, payload));
    setError(null);
    setLastRefreshAt(Date.now());
    setLastRefreshReason(`ws:${lastEvent.type}`);
    if (lastEvent.type === "chunk_ready" && !payload?.mime_type && !payload?.init_segment_url && !manifestRef.current) {
      void refreshReaderState(`ws:${lastEvent.type}:reconcile`);
    }
  }, [jobId, lastEvent, refreshReaderState]);

  useEffect(() => {
    if (!shouldUsePollingFallback) return;
    const timer = window.setInterval(() => { void refreshReaderState("poll"); }, READER_POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [refreshReaderState, shouldUsePollingFallback]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !job) return;
    const handlePlay = () => { if (isJobTerminal) setPlayIntent(true); syncPlaybackState(true, true); };
    const handlePause = () => { if (isJobTerminal) { setPlayIntent(false); syncPlaybackState(true, false); return; } if (!playIntent) syncPlaybackState(true, false); };
    const handleWaiting = () => syncPlaybackState(true, playIntent);
    const handleEnded = () => {
      if (!isJobTerminal && renderedDurationSeconds > 0 && audio.currentTime >= Math.max(0, renderedDurationSeconds - GAP_BUFFERING_EPSILON_SECONDS)) {
        syncPlaybackState(true, true); return;
      }
      setPlayIntent(false); syncPlaybackState(true, false);
    };
    const handleError = () => syncPlaybackState(true, false);
    audio.addEventListener("play", handlePlay);
    audio.addEventListener("pause", handlePause);
    audio.addEventListener("waiting", handleWaiting);
    audio.addEventListener("ended", handleEnded);
    audio.addEventListener("error", handleError);
    const interval = window.setInterval(() => { if (playIntent || isWaitingForData) syncPlaybackState(); }, PLAYBACK_SYNC_INTERVAL_MS);
    return () => {
      audio.removeEventListener("play", handlePlay);
      audio.removeEventListener("pause", handlePause);
      audio.removeEventListener("waiting", handleWaiting);
      audio.removeEventListener("ended", handleEnded);
      audio.removeEventListener("error", handleError);
      window.clearInterval(interval);
    };
  }, [audioRef, isJobTerminal, isWaitingForData, job, playIntent, renderedDurationSeconds, syncPlaybackState]);

  useEffect(() => {
    if (seekOverride === null) return;
    if (!isStreamPrimed || renderedDurationSeconds <= 0) return;
    seekToSeconds(Math.min(seekOverride, renderedDurationSeconds));
    setSeekOverride(null);
  }, [isStreamPrimed, seekOverride, renderedDurationSeconds, seekToSeconds]);

  useEffect(() => {
    if (!isJobTerminal || !playIntent || isActuallyPlaying || renderedDurationSeconds <= 0 || currentTimeSeconds < Math.max(0, renderedDurationSeconds - GAP_BUFFERING_EPSILON_SECONDS)) return;
    setPlayIntent(false);
  }, [currentTimeSeconds, isActuallyPlaying, isJobTerminal, playIntent, renderedDurationSeconds]);

  // ── Handlers ─────────────────────────────────────────────

  const handlePlay = async () => {
    if (!job) return;
    if (isJobTerminal) { setPlayIntent(true); setError(null); await requestUserGesturePlay(); return; }
    setPlayIntent(true); setError(null);
    try {
      const nextJob = await api.activateJob(job.id);
      setJob(nextJob);
      setManifest((prev) => buildManifestFromEvent(nextJob, prev));
      await requestUserGesturePlay();
    } catch (playError) {
      setPlayIntent(false);
      setError(playError instanceof Error ? playError.message : "Unable to activate playback");
    }
  };

  const handlePause = async () => {
    if (!job) return;
    setPlayIntent(false);
    pausePlayback();
    if (isJobTerminal) return;
    try {
      const nextJob = await api.pauseJob(job.id);
      setJob(nextJob);
      setManifest((prev) => buildManifestFromEvent(nextJob, prev));
      syncPlaybackState(true, false);
    } catch (pauseError) {
      setError(pauseError instanceof Error ? pauseError.message : "Unable to pause playback");
    }
  };

  const handleSeek = useCallback((seconds: number) => {
    setSeekOverride(seconds);
  }, []);

  const handleSeekToChunk = useCallback(
    async (chunkIndex: number, seekSeconds: number) => {
      if (!job) return;
      setPlaybackAnchorIndex(chunkIndex);
      setPlayIntent(true);
      setSeekOverride(seekSeconds);
      setError(null);
      if (isJobTerminal) {
        await requestUserGesturePlay();
        return;
      }
      try {
        const nextJob = await api.activateJob(job.id);
        setJob(nextJob);
        setManifest((prev) => buildManifestFromEvent(nextJob, prev));
        await requestUserGesturePlay();
      } catch (activationError) {
        setPlayIntent(false);
        setSeekOverride(null);
        setError(activationError instanceof Error ? activationError.message : "Unable to activate playback");
      }
    },
    [isJobTerminal, job, requestUserGesturePlay],
  );

  const handleDownload = useCallback(async () => {
    if (!job || downloadableChunks.length === 0) return;
    setDownloadError(null);
    setIsDownloading(true);
    try {
      const { blob, filename } = await api.downloadJobAudio(job.id);
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = filename;
      link.click();
      URL.revokeObjectURL(url);
    } catch (downloadFailure) {
      setDownloadError(downloadFailure instanceof Error ? downloadFailure.message : "Unable to download rendered audio");
    } finally {
      setIsDownloading(false);
    }
  }, [downloadableChunks.length, job]);

  const handleVoiceChange = async (voiceId: string) => {
    if (!job) return;
    try {
      const nextJob = await api.updateJobVoice(job.id, voiceId);
      setJob(nextJob);
      setManifest((prev) => buildManifestFromEvent(nextJob, prev));
      setError(null);
    } catch (voiceError) {
      setError(voiceError instanceof Error ? voiceError.message : "Unable to change voice");
    }
  };

  const handleReprocess = useCallback(
    async (chunkIndex: number, newText?: string) => {
      if (!job) return;
      try {
        setReprocessingChunkIndex(chunkIndex);
        setReprocessError(null);
        setEditingChunkIndex(null);
        const nextJob = await api.reprocessChunk(job.id, chunkIndex, { new_text: newText, new_voice_id: undefined });
        setJob(nextJob);
        setManifest((prev) => buildManifestFromEvent(nextJob, prev));
        setError(null);
        setTimeout(() => refreshReaderState("reprocess"), 1000);
      } catch (err) {
        setReprocessError(err instanceof Error ? err.message : "Reprocessing failed");
      } finally {
        setReprocessingChunkIndex(null);
      }
    },
    [job, refreshReaderState],
  );

  const handleVersionChange = useCallback(
    async (chunkIndex: number, version: number) => {
      if (!job) return;
      try {
        const nextJob = await api.setActiveVersion(job.id, chunkIndex, version);
        setJob(nextJob);
        setManifest((prev) => buildManifestFromEvent(nextJob, prev));
        setError(null);
        setReprocessError(null);
      } catch (err) {
        setReprocessError(err instanceof Error ? err.message : "Version switch failed");
      }
    },
    [job],
  );

  const handleStartEdit = useCallback((chunk: Chunk) => {
    const text = job ? getChunkText(chunk, job.source_text) : "";
    setEditText(text);
    setEditingChunkIndex(chunk.index);
  }, [job]);

  const handleSaveEdit = useCallback(() => {
    if (editingChunkIndex !== null) void handleReprocess(editingChunkIndex, editText);
  }, [editingChunkIndex, editText, handleReprocess]);

  const handleCancelEdit = useCallback(() => {
    setEditingChunkIndex(null);
    setEditText("");
  }, []);

  const writtenChunkCount = activeChunks.filter((c) => c.status === "written").length;
  const totalChunksInJob = job?.total_chunks_emitted ?? knownChunks.length;

  // ── Scroll-sync chunk content ───────────────────────────
  const contentRef = useRef<HTMLDivElement>(null);
  const chunkRefs = useRef<Map<number, HTMLDivElement>>(new Map());

  useEffect(() => {
    const activeIdx = activeProgress.activeChunkIndex;
    if (activeIdx === null) return;
    const el = chunkRefs.current.get(activeIdx);
    if (!el || !contentRef.current) return;
    try {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
    } catch {
      // scrollIntoView may not be available in all environments (e.g. jsdom)
    }
  }, [activeProgress.activeChunkIndex]);

  // ── Loader / error states ───────────────────────────────
  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="flex items-center gap-3 text-sm text-[var(--ink-secondary)]">
          <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-[var(--amber)] border-t-transparent" />
          Loading reader…
        </div>
      </div>
    );
  }

  if (!job) {
    return (
      <div className="rounded-xl border border-[var(--rose)]/20 bg-[var(--rose)]/10 px-5 py-8 text-center text-sm text-[var(--rose)]">
        {error ?? "Job not found"}
      </div>
    );
  }

  // ── Render source text chunk-by-chunk ────────────────────
  const sourceTextLines = activeChunks.map((chunk) => {
    const chunkText = getChunkText(chunk, job.source_text);
    const isActive = chunk.index === activeProgress.activeChunkIndex;
    const isPlayed = activeProgress.playedIndexes.has(chunk.index);

    return (
      <div
        key={chunk.index}
        ref={(el) => {
          if (el) chunkRefs.current.set(chunk.index, el);
          else chunkRefs.current.delete(chunk.index);
        }}
        className={`relative rounded-lg border-l-2 px-4 py-3 transition-all ${
          isActive
            ? "border-l-[var(--amber)] bg-[var(--amber-soft)] shadow-[var(--amber-glow)]"
            : isPlayed
              ? "border-l-white/5 opacity-60"
              : "border-l-white/5"
        }`}
      >
        {/* Chunk number indicator */}
        <div
          className={`mb-1 text-[10px] font-semibold uppercase tracking-wider ${
            isActive ? "text-[var(--amber)]" : "text-[var(--ink-secondary)]"
          }`}
        >
          Chunk {chunk.index + 1}
        </div>
        <p className="whitespace-pre-wrap text-sm leading-relaxed text-[var(--ink-primary)]">
          {chunkText || "(empty text)"}
        </p>
      </div>
    );
  });

  // ── Chunk detail panel ───────────────────────────────────
  const detailChunk = detailSlot ?? activeChunks.find((c) => c.index === activeProgress.activeChunkIndex) ?? null;

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
    const chunkText = job ? getChunkText(chunk, job.source_text) : "";
    const isEditing = editingChunkIndex === chunk.index;
    const allVersions = knownChunks.filter((c) => c.index === chunk.index);
    const maxVersion = getLatestVersion(knownChunks, chunk.index);
    const maxRetriesReached = chunk.status === "max_retries_exceeded" || maxVersion >= 3;

    return (
      <div className="rounded-lg border border-[var(--line)] bg-[var(--surface)] p-4">
        <div className="flex items-center justify-between mb-3">
          <span className="text-sm font-semibold text-[var(--ink-primary)]">
            Chunk {chunk.index + 1}
          </span>
          {allVersions.length > 1 ? (
            <select
              className="rounded-md border border-[var(--line)] bg-[var(--surface)] px-2 py-1 text-xs text-[var(--ink-primary)]"
              value={activeVersions.get(chunk.index) ?? chunk.version}
              onChange={(e) => handleVersionChange(chunk.index, Number(e.target.value))}
            >
              {allVersions.map((v) => (
                <option key={v.version} value={v.version}>V{v.version} {v.status === "written" ? "✓" : v.status}</option>
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
                  onClick={handleSaveEdit}
                >
                  Save &amp; Reprocess
                </button>
                <button
                  className="rounded-md border border-[var(--line)] px-3 py-1.5 text-xs font-semibold text-[var(--ink-secondary)] hover:text-[var(--ink-primary)]"
                  onClick={handleCancelEdit}
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
                onClick={() => handleStartEdit(chunk)}
              >
                Edit text
              </button>
            </div>
          )}
        </div>

        {/* Status badges */}
        <div className="flex flex-wrap items-center gap-2 mb-3">
          <span className={`rounded-md px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider ${
            chunk.status === "written" ? "bg-[var(--emerald)]/10 text-[var(--emerald)] border border-[var(--emerald)]/20" :
            chunk.status === "failed" || chunk.status === "max_retries_exceeded" ? "bg-[var(--rose)]/10 text-[var(--rose)] border border-[var(--rose)]/20" :
            "bg-white/5 text-[var(--ink-secondary)] border border-[var(--line)]"
          }`}>
            {chunk.status}
          </span>
          {chunk.duration_seconds > 0 ? (
            <span className="text-xs text-[var(--ink-secondary)]">{chunk.duration_seconds.toFixed(1)}s</span>
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
            onClick={() => isEditing ? handleSaveEdit() : void handleReprocess(chunk.index)}
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

  // ── Main render ──────────────────────────────────────────
  return (
    <div className="flex flex-col gap-4">
      {/* Warnings */}
      {((!isJobTerminal && (websocketStatus !== "open" || isSocketStale)) || error || lastPlayerError || downloadError) ? (
        <div
          aria-live="polite"
          className="rounded-lg border border-[var(--amber)]/20 bg-[var(--amber)]/10 px-4 py-3 text-xs text-[var(--amber)]"
        >
          <div className="flex flex-wrap gap-x-4 gap-y-1">
            {!isJobTerminal && (websocketStatus !== "open" || isSocketStale) ? (
              <span>Live updates degraded, using fallback sync</span>
            ) : null}
            {error ? <span>{error}</span> : null}
            {lastPlayerError ? <span>{lastPlayerError}</span> : null}
            {downloadError ? <span>{downloadError}</span> : null}
          </div>
        </div>
      ) : null}

      {/* Playbar */}
      <Playbar
        activeChunkIndex={activeProgress.activeChunkIndex}
        audioRef={audioRef as React.RefObject<HTMLAudioElement | null>}
        canDownload={canDownloadRenderedAudio}
        currentTimeSeconds={currentTimeSeconds}
        isAutoplayBlocked={isAutoplayBlocked}
        isDownloadComplete={isDownloadComplete}
        isDownloading={isDownloading}
        isJobTerminal={isJobTerminal}
        isPlaying={isActuallyPlaying}
        onDownload={handleDownload}
        onPause={handlePause}
        onPlay={handlePlay}
        onSeek={handleSeek}
        onSeekToChunk={handleSeekToChunk}
        renderedDurationSeconds={renderedDurationSeconds}
        slots={timelineSlots}
        totalChunks={totalChunksInJob}
        writtenChunks={writtenChunkCount}
      />

      {/* Main content grid */}
      <div className="grid gap-4 xl:grid-cols-[1.3fr_0.9fr]">
        {/* Left: source text with chunk highlighting */}
        <div
          className="rounded-xl border border-[var(--line)] bg-[var(--surface)] p-5"
        >
          <div className="mb-4 flex items-center justify-between">
            <div>
              <p className="text-xs uppercase tracking-[0.2em] text-[var(--ink-secondary)]">
                Reader
              </p>
              <h2 className="mt-1 text-xl font-bold text-[var(--ink-primary)]">
                {job.title ?? "Untitled job"}
              </h2>
            </div>
            <span className="rounded-md border border-[var(--line)] px-3 py-1 text-xs font-medium text-[var(--ink-secondary)]">
              {job.status}
            </span>
          </div>

          <div className="max-h-[60vh] space-y-2 overflow-y-auto" ref={contentRef}>
            {sourceTextLines.length > 0 ? (
              sourceTextLines
            ) : (
              <p className="py-8 text-center text-sm text-[var(--ink-secondary)]">
                No chunks available yet. Press play to start.
              </p>
            )}
          </div>
        </div>

        {/* Right: detail panel + controls */}
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
              onChange={(event) => void handleVoiceChange(event.target.value)}
              value={job.voice_id}
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
              <div className="flex justify-between"><span>Socket</span><span>{isJobTerminal ? "idle" : websocketStatus}{isSocketStale ? " (stale)" : ""}</span></div>
              <div className="flex justify-between"><span>Last live event</span><span>{formatRelativeTime(lastSocketMessageAt)}</span></div>
              <div className="flex justify-between"><span>Reader refresh</span><span>{formatRelativeTime(lastRefreshAt)} via {lastRefreshReason}</span></div>
              <div className="flex justify-between"><span>Appended chunks</span><span>{appendedChunksCount}</span></div>
              <div className="flex justify-between"><span>Playback anchor</span><span>Chunk {playbackAnchorIndex + 1}</span></div>
              <div className="flex justify-between"><span>Expected next</span><span>{expectedNextChunkIndex === null ? "none" : `Chunk ${expectedNextChunkIndex + 1}`}</span></div>
              <div className="flex justify-between"><span>Playback intent</span><span>{playIntent ? "armed" : "paused"}</span></div>
              <div className="flex justify-between"><span>Player state</span><span>{playerState}</span></div>
              <div className="flex justify-between"><span>Audio</span><span>{isActuallyPlaying ? "playing" : diagnostics.paused ? "paused" : "ready"}</span></div>
              <div className="flex justify-between"><span>Waiting for data</span><span>{isWaitingForData ? "yes" : "no"}</span></div>
              <div className="flex justify-between"><span>Buffered until</span><span>{bufferedUntilSeconds.toFixed(1)}s</span></div>
              <div className="flex justify-between"><span>Current time</span><span>{currentTimeSeconds.toFixed(1)}s</span></div>
              <div className="flex justify-between"><span>Audio ready/network</span><span>{diagnostics.readyState}/{diagnostics.networkState}</span></div>
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
                      chunk.index === activeProgress.activeChunkIndex
                        ? "bg-[var(--amber-soft)]"
                        : "bg-[var(--canvas)]/30"
                    }`}
                    key={chunk.index}
                  >
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-[var(--ink-primary)]">Chunk {chunk.index + 1}</span>
                      <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${
                        chunk.status === "written" ? "bg-[var(--emerald)]/10 text-[var(--emerald)]" :
                        chunk.status === "failed" || chunk.status === "max_retries_exceeded" ? "bg-[var(--rose)]/10 text-[var(--rose)]" :
                        "bg-white/5 text-[var(--ink-secondary)]"
                      }`}>
                        {chunk.status}
                      </span>
                      {chunk.duration_seconds > 0 ? (
                        <span className="text-[var(--ink-secondary)]">{chunk.duration_seconds.toFixed(1)}s</span>
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
                          onClick={() => handleVersionChange(chunk.index, v.version)}
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
      </div>
    </div>
  );
}
