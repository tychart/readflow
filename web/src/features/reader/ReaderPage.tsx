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
import type { TimelineSlotData, TimelineSlotState } from "../../components/WaveformTimeline";
import { useAppBootstrap } from "../../hooks/useAppBootstrap";
import { useChunkWaveforms } from "../../hooks/useChunkWaveforms";
import { useMediaSourcePlayer } from "../../lib/media-source";
import { useAppStore } from "../../state/store";
import type { Chunk, ChunkStatus, JobDetail, JobManifest, JobStatus } from "../../types/api";
import { ReaderSidebar } from "./ReaderSidebar";

/* ── Constants ────────────────────────────────────────────── */

const TERMINAL_JOB_STATUSES: JobStatus[] = ["completed", "failed"];
const READER_POLL_INTERVAL_MS = 2_000;
const PLAYBACK_SYNC_INTERVAL_MS = 3_000;
const GAP_BUFFERING_EPSILON_SECONDS = 0.5;

/* ── Types ────────────────────────────────────────────────── */

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

function isReprocessing(status: ChunkStatus): boolean {
  return status === "planned" || status === "queued" || status === "rendering" || status === "reprocessing";
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
  lastEvent: ReturnType<typeof useAppStore.getState>["lastEvent"];
  websocketStatus: ReturnType<typeof useAppStore.getState>["websocketStatus"];
  isSocketStale: ReturnType<typeof useAppStore.getState>["isSocketStale"];
}

/* ── Component ────────────────────────────────────────────── */

export function ReaderPage() {
  const { jobId = "" } = useParams();
  const {
    lastEvent,
    websocketStatus,
    isSocketStale,
  } = useAppStore(
    useShallow(
      (state): ReaderPageStoreState => ({
        lastEvent: state.lastEvent,
        websocketStatus: state.websocketStatus,
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

  // ── Sidebar state ────────────────────────────────────────
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [isLargeScreen, setIsLargeScreen] = useState(
    typeof window !== "undefined" ? window.innerWidth >= 1024 : true,
  );

  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia("(min-width: 1024px)");
    const handler = (e: MediaQueryListEvent) => {
      setIsLargeScreen(e.matches);
      // Auto-open sidebar when going to large, auto-close when going to small
      if (e.matches) setSidebarOpen(true);
      else setSidebarOpen(false);
    };
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);

  const toggleSidebar = useCallback(() => setSidebarOpen((prev) => !prev), []);

  const refreshRequestIdRef = useRef(0);
  const lastAppliedRequestIdRef = useRef(0);
  const refreshInFlightRef = useRef<Promise<void> | null>(null);
  const queuedRefreshReasonRef = useRef<string | null>(null);
  const lastPlaybackSyncAtRef = useRef(0);
  const manifestRef = useRef<JobManifest | null>(null);

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
    pendingSeek: seekOverride !== null,
  });

  const activeProgress = useMemo(
    () => deriveActiveChunkProgress(contiguousReadyChunks, currentTimeSeconds),
    [contiguousReadyChunks, currentTimeSeconds],
  );

  // Static waveform peaks for the playbar, fetched from the backend per chunk.
  // Updates automatically as chunks arrive or are reprocessed.
  const waveforms = useChunkWaveforms(activeChunks);


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
      };
    });
  }, [activeChunks, activeProgress, activeContiguousReadyIndexes, playbackAnchorIndex, writtenAfterGapIndexes, missingExpectedIndexes]);

  const detailSlot = useMemo(() => {
    const targetIndex = activeProgress.activeChunkIndex;
    if (targetIndex === null) return null;
    return activeChunks.find((c) => c.index === targetIndex) ?? null;
  }, [activeProgress.activeChunkIndex, activeChunks]);

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

  // Compute the original timeline position of the playback anchor.
  // When the anchor is non-zero (user sought to a later chunk), the
  // stream sent to useMediaSourcePlayer normalizes chunk start_seconds
  // to 0. So seekOverride (in original coords) must be normalized by
  // subtracting this offset before comparing with bufferedUntilSeconds.
  // Original timeline position of the playback anchor (for display coordinate conversion)
  const anchorOffset = useMemo(
    () =>
      knownChunks
        .filter((c) => c.index < playbackAnchorIndex)
        .reduce((acc, c) => acc + c.duration_seconds, 0),
    [knownChunks, playbackAnchorIndex],
  );

  // Time display values in original (non-normalized) coordinates
  const displayTimeSeconds = currentTimeSeconds + anchorOffset;
  const displayDurationSeconds = useMemo(
    () => knownChunks.reduce((acc, c) => acc + c.duration_seconds, 0),
    [knownChunks],
  );

  // Seek override: waits for stream + buffer to be ready, in normalized coords
  useEffect(() => {
    if (seekOverride === null) return;
    if (!isStreamPrimed || renderedDurationSeconds <= 0) return;
    // Normalize the seek target from original timeline coords to stream coords
    const normalizedSeek = Math.max(0, seekOverride - anchorOffset);
    if (normalizedSeek > bufferedUntilSeconds) return;
    seekToSeconds(Math.min(normalizedSeek, renderedDurationSeconds));
    setSeekOverride(null);
  }, [
    anchorOffset,
    bufferedUntilSeconds,
    isStreamPrimed,
    renderedDurationSeconds,
    seekOverride,
    seekToSeconds,
  ]);

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

  // Keyboard/direct seeks use normalized stream coords and seek immediately
  // (no need to wait for buffer — the stream is already set up)
  const handleSeek = useCallback((seconds: number) => {
    seekToSeconds(seconds);
  }, [seekToSeconds]);

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

  // Set userScrolledChunkRef so the scroll-into-view effect can distinguish
  // user-initiated seeks from automatic playback progression
  const handleSeekToChunkWithScroll = useCallback(
    async (chunkIndex: number, seekSeconds: number) => {
      userScrolledChunkRef.current = chunkIndex;
      await handleSeekToChunk(chunkIndex, seekSeconds);
    },
    [handleSeekToChunk],
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

  // Track the last user-initiated chunk change so we can scroll on explicit seeks
  // but NOT during automatic playback (which causes scroll-anchoring conflicts)
  const userScrolledChunkRef = useRef<number | null>(null);

  // Reset userScrolledChunkRef after a brief window
  useEffect(() => {
    if (userScrolledChunkRef.current === null) return;
    const timer = setTimeout(() => { userScrolledChunkRef.current = null; }, 400);
    return () => clearTimeout(timer);
  }, [playbackAnchorIndex]);

  useEffect(() => {
    const activeIdx = activeProgress.activeChunkIndex;
    if (activeIdx === null) return;
    // Only scroll if this was a user-initiated change (via seek/click), not during playback
    if (userScrolledChunkRef.current !== activeIdx) return;
    const el = chunkRefs.current.get(activeIdx);
    if (!el || !contentRef.current) return;
    try {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
    } catch {
      // scrollIntoView may not be available in all environments (e.g. jsdom)
    }
  }, [activeProgress.activeChunkIndex]);

  // ── Scroll-triggered progressive playbar shrink — must be before early returns ──
  const [scrollProgress, setScrollProgress] = useState(0);

  useEffect(() => {
    // Progressively shrink the playbar as the user scrolls down.
    // At 0px scroll: fully expanded. At ~220px scroll: fully compact.
    const handleScroll = () => {
      const progress = Math.min(1, Math.max(0, window.scrollY / 220));
      setScrollProgress(progress);
    };
    handleScroll();
    window.addEventListener('scroll', handleScroll, { passive: true });
    return () => window.removeEventListener('scroll', handleScroll);
  }, []);

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

  // ── Chunk detail panel (for sidebar) ────────────────────
  const detailChunk = detailSlot ?? activeChunks.find((c) => c.index === activeProgress.activeChunkIndex) ?? null;

  // ── ReaderContent sub-component (used in both centered and side-by-side layouts) ──
  const ReaderContent = ({
    contentRef: contentRefProp,
  }: {
    contentRef: React.RefObject<HTMLDivElement | null>;
  }) => (
    <>
      {/* Header row with title + toggle */}
      <div className="mb-4 flex items-center justify-between">
        <div>
          <p className="text-xs uppercase tracking-[0.2em] text-[var(--ink-secondary)]">
            Reader
          </p>
          <h2 className="mt-1 text-xl font-bold text-[var(--ink-primary)]">
            {job?.title ?? "Untitled job"}
          </h2>
        </div>
        <div className="flex items-center gap-2">
          <span className="rounded-md border border-[var(--line)] px-3 py-1 text-xs font-medium text-[var(--ink-secondary)]">
            {job?.status}
          </span>
          {/* Sidebar toggle — only on large screens when sidebar is inline */}
          {isLargeScreen && (
            <button
              aria-label={sidebarOpen ? "Close sidebar" : "Open sidebar"}
              className="flex h-8 w-8 items-center justify-center rounded-md text-[var(--ink-secondary)] hover:bg-[var(--hover-bg)] hover:text-[var(--ink-primary)] transition-colors"
              onClick={toggleSidebar}
              type="button"
            >
              {sidebarOpen ? (
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
                  <rect height="18" rx="2" ry="2" width="18" x="3" y="3" />
                  <line x1="15" x2="15" y1="3" y2="21" />
                </svg>
              ) : (
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
                  <rect height="18" rx="2" ry="2" width="18" x="3" y="3" />
                  <line x1="9" x2="9" y1="3" y2="21" />
                </svg>
              )}
            </button>
          )}
        </div>
      </div>

      {/* Source text — no inner scroll, flows with page */}
      <div className="rounded-xl border border-[var(--line)] bg-[var(--surface)] p-5" ref={contentRefProp}>
        <div className="space-y-2">
          {sourceTextLines.length > 0 ? (
            sourceTextLines
          ) : (
            <p className="py-8 text-center text-sm text-[var(--ink-secondary)]">
              No chunks available yet. Press play to start.
            </p>
          )}
        </div>
      </div>
    </>
  );

  // ── Main render ──────────────────────────────────────────
  return (
    <div className="flex flex-col">
      {/* Sticky playbar wrapper — flush against the app header */}
      <div className="sticky top-[56px] z-30 w-full">
        {/* Background layer — fades in smoothly with scroll progress */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 transition-all duration-300"
          style={{
            background: 'var(--surface)',
            opacity: scrollProgress * 0.95,
            backdropFilter: scrollProgress > 0.05 ? `blur(${Math.round(scrollProgress * 12)}px)` : 'none',
            WebkitBackdropFilter: scrollProgress > 0.05 ? `blur(${Math.round(scrollProgress * 12)}px)` : 'none',
            borderBottom: scrollProgress > 0.05 ? '1px solid var(--line)' : '1px solid transparent',
            boxShadow: scrollProgress > 0.5 ? '0 1px 3px rgba(0,0,0,0.3)' : 'none',
          }}
        />
        {/* Content — padding shrinks progressively */}
        <div
          className="relative z-10 mx-auto w-full"
          style={{
            padding: `${Math.round(20 - scrollProgress * 12)}px ${Math.round(16 - scrollProgress * 4)}px`,
          }}
        >
          <Playbar
            canDownload={canDownloadRenderedAudio}
            scrollProgress={scrollProgress}
            currentTimeSeconds={currentTimeSeconds}
            displayDurationSeconds={displayDurationSeconds}
            displayTimeSeconds={displayTimeSeconds}
            isAutoplayBlocked={isAutoplayBlocked}
            isDownloadComplete={isDownloadComplete}
            isDownloading={isDownloading}
            isJobTerminal={isJobTerminal}
            isPlaying={isActuallyPlaying}
            isWaitingForData={isWaitingForData}
            playIntent={playIntent}
            onDownload={handleDownload}
            onPause={handlePause}
            onPlay={handlePlay}
            onSeek={handleSeek}
            onSeekToChunk={handleSeekToChunkWithScroll}
            renderedDurationSeconds={renderedDurationSeconds}
            slots={timelineSlots}
            totalChunks={totalChunksInJob}
            waveforms={waveforms}
            writtenChunks={writtenChunkCount}
          />
        </div>
      </div>

      {/* Hidden audio element for MediaSource playback */}
      <audio aria-hidden="true" className="hidden" ref={audioRef as React.RefObject<HTMLAudioElement | null>} />

      {/* Warnings — in content area, below the header */}
      <div className="mx-auto w-full max-w-6xl px-4 pt-5 md:px-6">
        <div className="h-[44px]">
          <div
            aria-live="polite"
            className={`rounded-lg border px-4 py-3 text-xs transition-all duration-200 ${
              ((!isJobTerminal && (websocketStatus !== "open" || isSocketStale)) || error || lastPlayerError || downloadError)
                ? 'visible opacity-100 border-[var(--amber)]/20 bg-[var(--amber)]/10 text-[var(--amber)]'
                : 'invisible opacity-0'
            }`}
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
        </div>
      </div>

      {/* Main content area — reader text + sidebar */}
      <div className="mx-auto w-full max-w-6xl px-4 py-4 md:px-6 md:py-6">
        {isLargeScreen && !sidebarOpen ? (
          /* ── Sidebar closed: reader centered ── */
          <div className="mx-auto flex w-full max-w-4xl flex-col">
            <ReaderContent
              contentRef={contentRef}
            />
          </div>
        ) : (
          /* ── Sidebar open (or mobile): side-by-side ── */
          <div className="flex gap-6">
            <div className="min-w-0 flex-1">
              <ReaderContent
                contentRef={contentRef}
              />
            </div>

            <ReaderSidebar
              detailChunk={detailChunk}
              activeChunks={activeChunks}
              knownChunks={knownChunks}
              activeVersions={activeVersions}
              activeChunkIndex={activeProgress.activeChunkIndex}
              job={job}
              editingChunkIndex={editingChunkIndex}
              editText={editText}
              setEditText={setEditText}
              reprocessingChunkIndex={reprocessingChunkIndex}
              reprocessError={reprocessError}
              onVoiceChange={handleVoiceChange}
              onVersionChange={handleVersionChange}
              onReprocess={handleReprocess}
              onStartEdit={handleStartEdit}
              onSaveEdit={handleSaveEdit}
              onCancelEdit={handleCancelEdit}
              appendedChunksCount={appendedChunksCount}
              playbackAnchorIndex={playbackAnchorIndex}
              expectedNextChunkIndex={expectedNextChunkIndex}
              playIntent={playIntent}
              playerState={playerState}
              isActuallyPlaying={isActuallyPlaying}
              audioDiagnostics={diagnostics}
              isWaitingForData={isWaitingForData}
              bufferedUntilSeconds={bufferedUntilSeconds}
              currentTimeSeconds={currentTimeSeconds}
              lastPlayerError={lastPlayerError}
              lastPlaybackSyncError={lastPlaybackSyncError}
              isJobTerminal={isJobTerminal}
              lastRefreshAt={lastRefreshAt}
              lastRefreshReason={lastRefreshReason}
              isOpen={sidebarOpen}
              onToggle={toggleSidebar}
              isOverlay={!isLargeScreen}
            />
          </div>
        )}
      </div>
    </div>
  );
}
