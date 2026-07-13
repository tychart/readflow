import {
  type PointerEvent as ReactPointerEvent,
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
import { useAppBootstrap } from "../../hooks/useAppBootstrap";
import { useMediaSourcePlayer, type PlayerState } from "../../lib/media-source";
import { useAppStore } from "../../state/store";
import type { Chunk, ChunkStatus, JobDetail, JobManifest, JobStatus } from "../../types/api";
import { PlaybackSpeedControl } from "./PlaybackSpeedControl";
import { calculateChunkSeekTargetSeconds } from "./timeline";

const TERMINAL_JOB_STATUSES: JobStatus[] = ["completed", "failed"];
const READER_POLL_INTERVAL_MS = 2_000;
const PLAYBACK_SYNC_INTERVAL_MS = 3_000;
const TIMELINE_PLACEHOLDER_SECONDS = 4;
const GAP_BUFFERING_EPSILON_SECONDS = 0.5;

type TimelineSlotState =
  | "played"
  | "playing"
  | "ready"
  | "ready_after_gap"
  | "missing_expected"
  | "failed";

interface TimelineSlot {
  chunk: Chunk;
  state: TimelineSlotState;
  fillPercent: number;
  isAnchor: boolean;
  visualDurationSeconds: number;
  version: number;
  deprecated: boolean;
  reprocessing: boolean;
}

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

/**
 * Formats a timestamp as a relative time string.
 */
function formatRelativeTime(timestamp: number | null): string {
  if (!timestamp) {
    return "never";
  }
  const deltaSeconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  return deltaSeconds === 0 ? "just now" : `${deltaSeconds}s ago`;
}

/**
 * Formats seconds into a MM:SS clock string.
 */
function formatClock(seconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(totalSeconds / 60);
  const remainder = totalSeconds % 60;
  return `${minutes}:${String(remainder).padStart(2, "0")}`;
}

/**
 * Checks if a job status is terminal (completed or failed).
 */
function isTerminalStatus(status: JobStatus | undefined): boolean {
  return status ? TERMINAL_JOB_STATUSES.includes(status) : false;
}

/**
 * Sorts chunks by their index in ascending order.
 */
function sortChunks(chunks: Chunk[]): Chunk[] {
  return [...chunks].sort((left, right) => left.index - right.index);
}

/**
 * Builds a manifest from a stream event payload, preserving existing data.
 */
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

  if (!nextMimeType) {
    return null;
  }

  return {
    mime_type: nextMimeType,
    init_segment_url: nextInitSegmentUrl,
    chunks: sortChunks(job.chunks),
  } satisfies JobManifest;
}

/**
 * Merges chunks from job or manifest, preferring manifest data.
 */
function mergeKnownChunks(job: JobDetail | null, manifest: JobManifest | null): Chunk[] {
  if (manifest) {
    return sortChunks(manifest.chunks);
  }
  if (job) {
    return sortChunks(job.chunks);
  }
  return [];
}

/**
 * Returns a human-readable status text for a timeline slot.
 */
function chunkStatusText(state: TimelineSlotState): string {
  switch (state) {
    case "played":
      return "played";
    case "playing":
      return "active";
    case "ready":
      return "ready";
    case "ready_after_gap":
      return "ready after gap";
    case "missing_expected":
      return "expected but not received";
    case "failed":
      return "failed";
    default:
      return "unknown";
  }
}

/**
 * Describes the current player state for display to the user.
 */
function describePlayerState(playerState: PlayerState, isAutoplayBlocked: boolean): string {
  if (isAutoplayBlocked) {
    return "Playback blocked by browser; press play to resume.";
  }

  switch (playerState) {
    case "priming":
      return "Preparing stream…";
    case "waiting_for_first_chunk":
      return "Waiting for first chunk…";
    case "stalled_waiting_for_next_chunk":
      return "Waiting for next chunk…";
    case "ready_paused":
      return "Ready to play.";
    case "playing":
      return "Playing live stream.";
    case "ended":
      return "Playback complete.";
    case "error":
      return "Playback error.";
    default:
      return "Waiting to start.";
  }
}

/**
 * Returns the CSS tone class for the player status display.
 */
function statusTone(
  playerState: PlayerState,
  isAutoplayBlocked: boolean,
  hasError: boolean,
): string {
  if (hasError) {
    return "border-rose-200 bg-rose-50/80 text-rose-900";
  }
  if (
    isAutoplayBlocked ||
    playerState === "waiting_for_first_chunk" ||
    playerState === "stalled_waiting_for_next_chunk" ||
    playerState === "priming"
  ) {
    return "border-amber-200 bg-amber-50/80 text-amber-950";
  }
  return "border-emerald-200 bg-emerald-50/80 text-emerald-950";
}

/**
 * Mirrors the backend ChunkPlanner.normalize_text() so that
 * char_start/char_end indices (which were computed against the
 * normalized text) map to the correct positions in the source.
 */
function normalizeText(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Extracts the text for a chunk from the job source text.
 * Normalizes the source first so that character boundaries
 * (computed by the backend against normalized text) map
 * to the correct positions and produce the same content
 * that the backend stored as chunk.text.
 */
function getChunkText(chunk: Chunk, sourceText: string): string {
  const normalized = normalizeText(sourceText);
  return normalized.slice(chunk.char_start, chunk.char_end).trim();
}

/**
 * Derives the active version map from chunks, preferring highest version per index.
 */
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

/**
 * Gets the latest version number for a chunk index from a chunk list.
 */
function getLatestVersion(chunks: Chunk[], index: number): number {
  let max = -1;
  for (const chunk of chunks) {
    if (chunk.index === index && chunk.version > max) {
      max = chunk.version;
    }
  }
  return max;
}

/**
 * Checks if a chunk is in a reprocessing or pending state.
 */
function isReprocessing(status: ChunkStatus): boolean {
  return status === "planned" || status === "queued" || status === "rendering" || status === "reprocessing";
}

/**
 * Gets the retry count for a chunk (version number = number of reprocessing attempts).
 */
function getRetryCount(status: ChunkStatus, version: number): number {
  if (status === "max_retries_exceeded") return 3;
  return version; // V0 = original, V1 = 1 retry, etc.
}

/**
 * Builds a stream manifest from contiguous ready chunks, re-normalizing start times.
 * Builds a stream manifest from contiguous ready chunks, re-normalizing start times.
 */
function buildStreamManifest(
  fullManifest: JobManifest | null,
  contiguousReadyChunks: Chunk[],
): JobManifest | null {
  if (!fullManifest) {
    return null;
  }

  let runningStart = 0;
  const normalizedChunks = contiguousReadyChunks.map((chunk) => {
    const normalized = {
      ...chunk,
      start_seconds: runningStart,
    };
    runningStart += chunk.duration_seconds;
    return normalized;
  });

  return {
    mime_type: fullManifest.mime_type,
    init_segment_url: fullManifest.init_segment_url,
    chunks: normalizedChunks,
  };
}

/**
 * Derives progress information for the currently playing chunk.
 */
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

    fillByIndex.set(
      chunk.index,
      chunk.duration_seconds > 0 ? (remaining / chunk.duration_seconds) * 100 : 0,
    );
    activeChunkIndex = chunk.index;
    break;
  }

  return { activeChunkIndex, fillByIndex, playedIndexes };
}

/**
 * Generates an accessible description for a timeline slot.
 */
function describeTimelineSlot(slot: TimelineSlot): string {
  const chunkNumber = slot.chunk.index + 1;
  return `Chunk ${chunkNumber} ${chunkStatusText(slot.state)}`;
}

interface ReaderPageStoreState {
  voices: ReturnType<typeof useAppStore.getState>["voices"];
  lastEvent: ReturnType<typeof useAppStore.getState>["lastEvent"];
  websocketStatus: ReturnType<typeof useAppStore.getState>["websocketStatus"];
  lastSocketMessageAt: ReturnType<typeof useAppStore.getState>["lastSocketMessageAt"];
  lastSocketError: ReturnType<typeof useAppStore.getState>["lastSocketError"];
  isSocketStale: ReturnType<typeof useAppStore.getState>["isSocketStale"];
}

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
  const [hoveredChunkIndex, setHoveredChunkIndex] = useState<number | null>(null);
  const [pendingAnchorSeekSeconds, setPendingAnchorSeekSeconds] = useState<number | null>(null);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [isDownloading, setIsDownloading] = useState(false);
  // Versioning & reprocessing state.
  // activeVersions is derived from job.active_chunk_version — the backend is
  // the single source of truth for which version is active.  When the user
  // selects a different version via the dropdown the change goes through the
  // backend API first, so the job state always reflects the latest selection.
  // For indices the backend hasn't explicitly assigned an active version to
  // yet (e.g. a fresh reprocessing chunk before the backend broadcasts the
  // job state), we fall back to deriving the highest version from knownChunks.
  const knownChunks = useMemo(() => mergeKnownChunks(job, manifest), [job, manifest]);
  const activeVersions = useMemo(() => {
    const versions = new Map<number, number>();
    const av = job?.active_chunk_version;
    if (av && Object.keys(av).length > 0) {
      for (const [idxStr, ver] of Object.entries(av)) {
        versions.set(Number(idxStr), ver);
      }
    }
    // Fill in any indices the backend doesn't know about — fall back to
    // deriving the highest version from known chunks.
    for (const chunk of knownChunks) {
      if (!versions.has(chunk.index)) {
        const derived = deriveActiveVersions([chunk]);
        for (const [idx, ver] of derived) {
          versions.set(idx, ver);
        }
      }
    }
    return versions;
  }, [job?.active_chunk_version, knownChunks]);
  const [editingChunkIndex, setEditingChunkIndex] = useState<number | null>(null);
  const [editText, setEditText] = useState("");
  const [reprocessingChunkIndex, setReprocessingChunkIndex] = useState<number | null>(null);
  const [reprocessError, setReprocessError] = useState<string | null>(null);

  const refreshRequestIdRef = useRef(0);
  const lastAppliedRequestIdRef = useRef(0);
  const refreshInFlightRef = useRef<Promise<void> | null>(null);
  const queuedRefreshReasonRef = useRef<string | null>(null);
  const lastPlaybackSyncAtRef = useRef(0);
  const manifestRef = useRef<JobManifest | null>(null);
  const seekingPointerIdRef = useRef<number | null>(null);
  const suppressSlotClickIndexRef = useRef<number | null>(null);

  const isJobTerminal = isTerminalStatus(job?.status);
  useAppBootstrap(!loading && !!job && !isJobTerminal);



  useEffect(() => {
    if (knownChunks.length === 0) {
      if (playbackAnchorIndex !== 0) {
        setPlaybackAnchorIndex(0);
      }
      return;
    }
    if (!knownChunks.some((chunk) => chunk.index === playbackAnchorIndex)) {
      setPlaybackAnchorIndex(knownChunks[0]?.index ?? 0);
    }
  }, [knownChunks, playbackAnchorIndex]);

  const anchoredChunks = useMemo(
    () => knownChunks.filter((chunk) => chunk.index >= playbackAnchorIndex),
    [knownChunks, playbackAnchorIndex],
  );

  const contiguousReadyChunks = useMemo(() => {
    const contiguous: Chunk[] = [];
    for (const chunk of anchoredChunks) {
      if (chunk.status !== "written") {
        break;
      }
      contiguous.push(chunk);
    }
    return contiguous;
  }, [anchoredChunks]);

  // Derive active chunks (one per index, using active version)
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

  // Recompute version-aware indexes using active chunks
  const activeContiguousReadyIndexes = useMemo(() => {
    const set = new Set<number>();
    for (const chunk of contiguousReadyChunks) {
      const activeVer = activeVersions.get(chunk.index);
      if (activeVer !== undefined && chunk.version === activeVer) {
        set.add(chunk.index);
      }
    }
    return set;
  }, [contiguousReadyChunks, activeVersions]);

  // Version-aware gap detection using active chunks only
  const activeFirstGapChunk = useMemo(() => {
    return activeChunks.find((chunk) => chunk.status !== "written") ?? null;
  }, [activeChunks]);
  const expectedNextChunkIndex = activeFirstGapChunk?.index ?? null;
  const writtenAfterGapIndexes = useMemo(
    () =>
      new Set(
        activeChunks.filter(
          (chunk) =>
            chunk.index >= (expectedNextChunkIndex ?? Number.POSITIVE_INFINITY) &&
            chunk.status === "written",
        ).map((chunk) => chunk.index),
      ),
    [activeChunks, expectedNextChunkIndex],
  );
  const missingExpectedIndexes = useMemo(
    () =>
      new Set(
        activeChunks
          .filter((chunk) => chunk.status !== "written" && chunk.status !== "failed")
          .map((chunk) => chunk.index),
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
      if (chunk.index !== contiguous.length || chunk.status !== "written" || !chunk.segment_url) {
        break;
      }
      contiguous.push(chunk);
    }
    return contiguous;
  }, [knownChunks]);
  const canDownloadRenderedAudio = downloadableChunks.length > 0;
  const isDownloadComplete =
    !!job &&
    isJobTerminal &&
    downloadableChunks.length > 0 &&
    downloadableChunks.length === knownChunks.length;
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
    playbackRate,
    renderedDurationSeconds,
    requestUserGesturePlay,
    seekToSeconds,
    setPlaybackRate,
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
  const streamStartByIndex = useMemo(() => {
    let runningStart = 0;
    const starts = new Map<number, number>();
    for (const chunk of contiguousReadyChunks) {
      starts.set(chunk.index, runningStart);
      runningStart += chunk.duration_seconds;
    }
    return starts;
  }, [contiguousReadyChunks]);

  const timelineSlots = useMemo<TimelineSlot[]>(() => {
    return activeChunks.map((chunk) => {
      const activeVer = activeVersions.get(chunk.index) ?? 0;
      let state: TimelineSlotState;
      if (chunk.status === "failed") {
        state = "failed";
      } else if (chunk.status === "max_retries_exceeded") {
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
        chunk,
        state,
        fillPercent: activeProgress.fillByIndex.get(chunk.index) ?? (state === "played" ? 100 : 0),
        isAnchor: chunk.index === playbackAnchorIndex,
        visualDurationSeconds:
          chunk.duration_seconds > 0 ? chunk.duration_seconds : TIMELINE_PLACEHOLDER_SECONDS,
        version: chunk.version,
        deprecated: chunk.deprecated,
        reprocessing: chunk.reprocessing,
      };
    });
  }, [
    activeProgress.activeChunkIndex,
    activeProgress.fillByIndex,
    activeProgress.playedIndexes,
    activeChunks,
    activeContiguousReadyIndexes,
    missingExpectedIndexes,
    playbackAnchorIndex,
    writtenAfterGapIndexes,
    activeVersions,
  ]);

  const detailSlot = useMemo(() => {
    if (hoveredChunkIndex !== null) {
      return timelineSlots.find((slot) => slot.chunk.index === hoveredChunkIndex) ?? null;
    }
    return timelineSlots.find((slot) => slot.chunk.index === activeProgress.activeChunkIndex) ?? null;
  }, [activeProgress.activeChunkIndex, hoveredChunkIndex, timelineSlots]);

  const writtenChunkCount = activeChunks.filter((chunk) => chunk.status === "written").length;
  const totalChunksInJob = job?.total_chunks_emitted ?? knownChunks.length;
  const shouldUsePollingFallback =
    !!job && !isTerminalStatus(job.status) && (websocketStatus !== "open" || isSocketStale);
  const liveStatus = describePlayerState(playerState, isAutoplayBlocked);
  const showSpinner =
    playerState === "priming" ||
    playerState === "waiting_for_first_chunk" ||
    playerState === "stalled_waiting_for_next_chunk";
  const primaryButtonLabel =
    playIntent && !isAutoplayBlocked ? "Pause" : isAutoplayBlocked ? "Resume" : "Play";
  const hasReachedTerminalPlaybackEnd =
    isJobTerminal &&
    renderedDurationSeconds > 0 &&
    currentTimeSeconds >= Math.max(0, renderedDurationSeconds - GAP_BUFFERING_EPSILON_SECONDS);

  useEffect(() => {
    manifestRef.current = manifest;
  }, [manifest]);

  const refreshReaderState = useCallback(
    async (reason: string, showLoading = false) => {
      if (!jobId) {
        return;
      }
      if (refreshInFlightRef.current) {
        queuedRefreshReasonRef.current = reason;
        return refreshInFlightRef.current;
      }
      if (showLoading) {
        setLoading(true);
      }
      const requestId = ++refreshRequestIdRef.current;
      const task = Promise.all([api.getJob(jobId), api.getManifest(jobId)])
        .then(([nextJob, nextManifest]) => {
          if (requestId < lastAppliedRequestIdRef.current) {
            return;
          }
          lastAppliedRequestIdRef.current = requestId;
          setJob(nextJob);
          setManifest(nextManifest);
          setError(null);
          setLastRefreshAt(Date.now());
          setLastRefreshReason(reason);
        })
        .catch((loadError) => {
          setError(
            loadError instanceof Error ? loadError.message : "Unable to refresh reader state",
          );
        })
        .finally(async () => {
          refreshInFlightRef.current = null;
          if (showLoading) {
            setLoading(false);
          }
          const queuedReason = queuedRefreshReasonRef.current;
          queuedRefreshReasonRef.current = null;
          if (queuedReason) {
            await refreshReaderState(queuedReason);
          }
        });
      refreshInFlightRef.current = task;
      return task;
    },
    [jobId],
  );

  const syncPlaybackState = useCallback(
    (force = false, isPlayingOverride?: boolean) => {
      if (!job || !audioRef.current || isJobTerminal) {
        return;
      }
      const now = Date.now();
      if (!force && now - lastPlaybackSyncAtRef.current < PLAYBACK_SYNC_INTERVAL_MS) {
        return;
      }
      lastPlaybackSyncAtRef.current = now;
      const isPlaying =
        isPlayingOverride ?? (playIntent && (!audioRef.current.paused || isWaitingForData));
      const currentTime = audioRef.current.currentTime ?? 0;

      // Prefer WebSocket — silent in access logs and lighter-weight
      const sent = liveClient.sendPlaybackSync(job.id, currentTime, isPlaying);
      if (sent) {
        setLastPlaybackSyncError(null);
      } else {
        // Fall back to HTTP when WebSocket isn't available
        void api
          .updatePlayback(job.id, currentTime, isPlaying)
          .then(() => setLastPlaybackSyncError(null))
          .catch((syncError) => {
            setLastPlaybackSyncError(
              syncError instanceof Error
                ? `Playback sync failed: ${syncError.message}`
                : "Playback sync failed",
            );
          });
      }
    },
    [audioRef, isJobTerminal, isWaitingForData, job, playIntent],
  );

  useEffect(() => {
    void refreshReaderState("initial", true);
  }, [refreshReaderState]);

  useEffect(() => {
    const payload = lastEvent?.payload as StreamEventPayload | undefined;
    const eventJob = payload?.job;
    if (!lastEvent || !eventJob || eventJob.id !== jobId) {
      return;
    }
    if (
      lastEvent.type !== "job_updated" &&
      lastEvent.type !== "job_completed" &&
      lastEvent.type !== "chunk_ready"
    ) {
      return;
    }

    setJob(eventJob);
    setManifest((previousManifest) => buildManifestFromEvent(eventJob, previousManifest, payload));
    setError(null);
    setLastRefreshAt(Date.now());
    setLastRefreshReason(`ws:${lastEvent.type}`);

    if (
      lastEvent.type === "chunk_ready" &&
      !payload?.mime_type &&
      !payload?.init_segment_url &&
      !manifestRef.current
    ) {
      void refreshReaderState(`ws:${lastEvent.type}:reconcile`);
    }
  }, [jobId, lastEvent, refreshReaderState]);

  useEffect(() => {
    if (!shouldUsePollingFallback) {
      return;
    }
    const timer = window.setInterval(() => {
      void refreshReaderState("poll");
    }, READER_POLL_INTERVAL_MS);
    return () => {
      window.clearInterval(timer);
    };
  }, [refreshReaderState, shouldUsePollingFallback]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !job) {
      return;
    }

    const handlePlay = () => {
      if (isJobTerminal) {
        setPlayIntent(true);
      }
      syncPlaybackState(true, true);
    };
    const handlePause = () => {
      if (isJobTerminal) {
        setPlayIntent(false);
        syncPlaybackState(true, false);
        return;
      }
      if (!playIntent) {
        syncPlaybackState(true, false);
      }
    };
    const handleWaiting = () => syncPlaybackState(true, playIntent);
    const handleEnded = () => {
      if (
        !isJobTerminal &&
        renderedDurationSeconds > 0 &&
        audio.currentTime >= Math.max(0, renderedDurationSeconds - GAP_BUFFERING_EPSILON_SECONDS)
      ) {
        syncPlaybackState(true, true);
        return;
      }
      setPlayIntent(false);
      syncPlaybackState(true, false);
    };
    const handleError = () => syncPlaybackState(true, false);

    audio.addEventListener("play", handlePlay);
    audio.addEventListener("pause", handlePause);
    audio.addEventListener("waiting", handleWaiting);
    audio.addEventListener("ended", handleEnded);
    audio.addEventListener("error", handleError);

    const interval = window.setInterval(() => {
      if (playIntent || isWaitingForData) {
        syncPlaybackState();
      }
    }, PLAYBACK_SYNC_INTERVAL_MS);

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
    if (pendingAnchorSeekSeconds === null) {
      return;
    }
    if (!isStreamPrimed || renderedDurationSeconds <= 0) {
      return;
    }
    seekToSeconds(Math.min(pendingAnchorSeekSeconds, renderedDurationSeconds));
    setPendingAnchorSeekSeconds(null);
  }, [isStreamPrimed, pendingAnchorSeekSeconds, renderedDurationSeconds, seekToSeconds]);

  useEffect(() => {
    if (
      !isJobTerminal ||
      !playIntent ||
      isActuallyPlaying ||
      renderedDurationSeconds <= 0 ||
      currentTimeSeconds < Math.max(0, renderedDurationSeconds - GAP_BUFFERING_EPSILON_SECONDS)
    ) {
      return;
    }
    setPlayIntent(false);
  }, [
    currentTimeSeconds,
    isActuallyPlaying,
    isJobTerminal,
    playIntent,
    renderedDurationSeconds,
  ]);

  const handlePlay = async () => {
    if (!job) {
      return;
    }
    if (isJobTerminal) {
      setPlayIntent(true);
      setError(null);
      await requestUserGesturePlay();
      return;
    }
    setPlayIntent(true);
    setError(null);
    try {
      const nextJob = await api.activateJob(job.id);
      setJob(nextJob);
      setManifest((previousManifest) => buildManifestFromEvent(nextJob, previousManifest));
      await requestUserGesturePlay();
    } catch (playError) {
      setPlayIntent(false);
      setError(
        playError instanceof Error ? playError.message : "Unable to activate playback",
      );
    }
  };

  const handlePause = async () => {
    if (!job) {
      return;
    }
    setPlayIntent(false);
    pausePlayback();
    if (isJobTerminal) {
      return;
    }
    try {
      const nextJob = await api.pauseJob(job.id);
      setJob(nextJob);
      setManifest((previousManifest) => buildManifestFromEvent(nextJob, previousManifest));
      syncPlaybackState(true, false);
    } catch (pauseError) {
      setError(
        pauseError instanceof Error ? pauseError.message : "Unable to pause playback",
      );
    }
  };

  const activatePlaybackAtChunk = useCallback(
    async (chunk: Chunk, startOffsetSeconds = 0) => {
      if (!job) {
        return;
      }
      if (isJobTerminal) {
        setPlaybackAnchorIndex(chunk.index);
        setHoveredChunkIndex(chunk.index);
        setPlayIntent(true);
        setPendingAnchorSeekSeconds(startOffsetSeconds);
        setError(null);
        await requestUserGesturePlay();
        return;
      }
      setPlaybackAnchorIndex(chunk.index);
      setHoveredChunkIndex(chunk.index);
      setPlayIntent(true);
      setPendingAnchorSeekSeconds(startOffsetSeconds);
      setError(null);
      try {
        const nextJob = await api.activateJob(job.id);
        setJob(nextJob);
        setManifest((previousManifest) => buildManifestFromEvent(nextJob, previousManifest));
        await requestUserGesturePlay();
      } catch (activationError) {
        setPlayIntent(false);
        setPendingAnchorSeekSeconds(null);
        setError(
          activationError instanceof Error
            ? activationError.message
            : "Unable to activate playback",
        );
      }
    },
    [isJobTerminal, job, requestUserGesturePlay],
  );

  const armPlaybackAtMissingChunk = useCallback(
    async (chunk: Chunk) => {
      if (!job) {
        return;
      }
      setPlaybackAnchorIndex(chunk.index);
      setHoveredChunkIndex(chunk.index);
      setPlayIntent(true);
      setPendingAnchorSeekSeconds(null);
      setError(null);
      try {
        const nextJob = await api.activateJob(job.id);
        setJob(nextJob);
        setManifest((previousManifest) => buildManifestFromEvent(nextJob, previousManifest));
      } catch (activationError) {
        setPlayIntent(false);
        setError(
          activationError instanceof Error
            ? activationError.message
            : "Unable to activate playback",
        );
      }
    },
    [job],
  );

  const seekWithinTimelineSlot = useCallback(
    (slot: TimelineSlot, element: HTMLButtonElement, clientX: number) => {
      if (!activeContiguousReadyIndexes.has(slot.chunk.index) || slot.chunk.duration_seconds <= 0) {
        return false;
      }
      const rect = element.getBoundingClientRect();
      if (rect.width <= 0) {
        return false;
      }
      const chunkStartSeconds = streamStartByIndex.get(slot.chunk.index) ?? 0;
      seekToSeconds(
        calculateChunkSeekTargetSeconds(
          clientX,
          { left: rect.left, width: rect.width },
          chunkStartSeconds,
          slot.chunk.duration_seconds,
        ),
      );
      return true;
    },
    [activeContiguousReadyIndexes, seekToSeconds, streamStartByIndex],
  );

  const resumeTerminalPlaybackAfterSeek = useCallback(() => {
    if (!isJobTerminal || playIntent || !hasReachedTerminalPlaybackEnd) {
      return;
    }
    setPlayIntent(true);
    setError(null);
    void requestUserGesturePlay();
  }, [
    hasReachedTerminalPlaybackEnd,
    isJobTerminal,
    playIntent,
    requestUserGesturePlay,
  ]);

  const handleTimelinePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>, slot: TimelineSlot) => {
      if (event.button !== 0) {
        return;
      }
      const target = event.currentTarget;
      const didSeek = seekWithinTimelineSlot(slot, target, event.clientX);
      if (!didSeek) {
        return;
      }
      resumeTerminalPlaybackAfterSeek();
      suppressSlotClickIndexRef.current = slot.chunk.index;
      seekingPointerIdRef.current = event.pointerId;
      if (typeof target.setPointerCapture === "function") {
        target.setPointerCapture(event.pointerId);
      }
      event.preventDefault();
    },
    [resumeTerminalPlaybackAfterSeek, seekWithinTimelineSlot],
  );

  const handleTimelinePointerMove = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>, slot: TimelineSlot) => {
      if (seekingPointerIdRef.current !== event.pointerId) {
        return;
      }
      seekWithinTimelineSlot(slot, event.currentTarget, event.clientX);
    },
    [seekWithinTimelineSlot],
  );

  const clearTimelineSeeking = useCallback((pointerId: number) => {
    if (seekingPointerIdRef.current === pointerId) {
      seekingPointerIdRef.current = null;
      syncPlaybackState(true);
    }
  }, [syncPlaybackState]);

  const handleVoiceChange = async (voiceId: string) => {
    if (!job) {
      return;
    }
    try {
      const nextJob = await api.updateJobVoice(job.id, voiceId);
      setJob(nextJob);
      setManifest((previousManifest) => buildManifestFromEvent(nextJob, previousManifest));
      setError(null);
    } catch (voiceError) {
      setError(
        voiceError instanceof Error ? voiceError.message : "Unable to change voice",
      );
    }
  };

  // Versioning & reprocessing handlers
  const handleReprocess = useCallback(
    async (chunkIndex: number, newText?: string) => {
      if (!job) return;
      try {
        setReprocessingChunkIndex(chunkIndex);
        setReprocessError(null);
        setEditingChunkIndex(null);
        const nextJob = await api.reprocessChunk(job.id, chunkIndex, {
          new_text: newText,
          new_voice_id: undefined,
        });
        setJob(nextJob);
        setManifest((prev) => buildManifestFromEvent(nextJob, prev));
        setError(null);
        // Refresh after a short delay to catch the first scheduler update
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
  }, [job?.source_text]);

  const handleSaveEdit = useCallback(() => {
    if (editingChunkIndex !== null) {
      void handleReprocess(editingChunkIndex, editText);
    }
  }, [editingChunkIndex, editText, handleReprocess]);

  const handleCancelEdit = useCallback(() => {
    setEditingChunkIndex(null);
    setEditText("");
  }, []);

  const handleDownload = useCallback(async () => {
    if (!job || downloadableChunks.length === 0) {
      return;
    }

    setDownloadError(null);
    setIsDownloading(true);
    try {
      const { blob, filename } = await api.downloadJobAudio(job.id);
      const downloadUrl = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = downloadUrl;
      link.download = filename;
      link.click();
      URL.revokeObjectURL(downloadUrl);
    } catch (downloadFailure) {
      setDownloadError(
        downloadFailure instanceof Error
          ? downloadFailure.message
          : "Unable to download rendered audio",
      );
    } finally {
      setIsDownloading(false);
    }
  }, [downloadableChunks.length, job]);

  const handleTimelineSlotClick = async (slot: TimelineSlot) => {
    if (suppressSlotClickIndexRef.current === slot.chunk.index) {
      suppressSlotClickIndexRef.current = null;
      return;
    }

    if (slot.chunk.status === "failed") {
      // Allow clicking on failed chunks to show detail panel with retry option
      setHoveredChunkIndex(slot.chunk.index);
      return;
    }

    if (activeContiguousReadyIndexes.has(slot.chunk.index)) {
      seekToSeconds(streamStartByIndex.get(slot.chunk.index) ?? 0);
      resumeTerminalPlaybackAfterSeek();
      return;
    }

    if (slot.chunk.status === "written") {
      await activatePlaybackAtChunk(slot.chunk);
      return;
    }

    // For reprocessing or missing chunks, show the detail panel
    setHoveredChunkIndex(slot.chunk.index);
    await armPlaybackAtMissingChunk(slot.chunk);
  };

  if (loading) {
    return <div className="panel rounded-[2rem] p-8">Loading reader…</div>;
  }

  if (!job) {
    return (
      <div className="panel rounded-[2rem] p-8 text-rose-700">{error ?? "Job not found"}</div>
    );
  }

  return (
    <div className="grid gap-6 xl:grid-cols-[1.3fr_0.9fr]">
      <div className="space-y-6">
        {((!isJobTerminal && (websocketStatus !== "open" || isSocketStale)) ||
          error ||
          lastPlayerError ||
          downloadError) ? (
          <div
            aria-live="polite"
            className="panel rounded-[2rem] border border-amber-200 bg-amber-50/80 p-5 text-sm text-amber-950"
          >
            <div className="mb-2 font-semibold uppercase tracking-[0.2em]">Reader warnings</div>
            <div className="space-y-2">
              {!isJobTerminal && (websocketStatus !== "open" || isSocketStale) ? (
                <div>Live updates degraded, using fallback sync…</div>
              ) : null}
              {error ? <div>{error}</div> : null}
              {lastPlayerError ? <div>{lastPlayerError}</div> : null}
              {lastSocketError ? <div>{lastSocketError}</div> : null}
              {downloadError ? <div>{downloadError}</div> : null}
            </div>
          </div>
        ) : null}

        <div className="panel rounded-[2rem] p-8">
          <div className="mb-4 flex items-center justify-between gap-4">
            <div>
              <p className="text-sm uppercase tracking-[0.3em] text-stone-600">Reader</p>
              <h1 className="display-font text-4xl">{job.title ?? "Untitled job"}</h1>
            </div>
            <div className="rounded-full bg-white/80 px-4 py-2 text-sm text-stone-600">
              {job.status}
            </div>
          </div>
          <div className="rounded-3xl bg-white/60 p-5">
            <p className="whitespace-pre-wrap leading-8 text-stone-800">{job.source_text}</p>
          </div>
        </div>
      </div>

      <div className="space-y-6">
        <div className="panel rounded-[2rem] p-6">
          <audio aria-hidden="true" className="hidden" ref={audioRef} />

          <div
            aria-label={`Playback status: ${liveStatus}`}
            className={`mb-5 rounded-3xl border px-4 py-3 text-sm ${statusTone(
              playerState,
              isAutoplayBlocked,
              !!(error || lastPlayerError),
            )}`}
          >
            <div className="flex flex-wrap items-center gap-3">
              {showSpinner ? (
                <span
                  aria-hidden="true"
                  className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent"
                />
              ) : null}
              <span className="font-medium">{liveStatus}</span>
            </div>
          </div>

          <div className="mb-5 flex flex-wrap items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <button
                className="rounded-full bg-[var(--accent)] px-5 py-3 font-semibold text-white"
                onClick={() => void (playIntent && !isAutoplayBlocked ? handlePause() : handlePlay())}
                type="button"
              >
                {primaryButtonLabel}
              </button>
              <div className="text-sm text-stone-600">
                {formatClock(currentTimeSeconds)} / {formatClock(renderedDurationSeconds)}
              </div>
              <PlaybackSpeedControl
                value={playbackRate}
                onChange={setPlaybackRate}
              />
            </div>
            <div className="flex items-center gap-3">
              <button
                className="rounded-full border border-stone-300 bg-white/80 px-4 py-3 text-sm font-semibold text-stone-700 disabled:cursor-not-allowed disabled:opacity-50"
                disabled={!canDownloadRenderedAudio || isDownloading}
                onClick={() => void handleDownload()}
                type="button"
              >
                {isDownloading
                  ? "Preparing download…"
                  : !canDownloadRenderedAudio
                    ? "Download not ready"
                  : isDownloadComplete
                    ? "Download full audio"
                    : "Download rendered audio so far"}
              </button>
              <div className="text-right text-sm text-stone-600">
                <div>Playable now: {renderedDurationSeconds.toFixed(1)}s</div>
                <div>Buffered: {bufferedUntilSeconds.toFixed(1)}s</div>
              </div>
            </div>
          </div>

          <div className="overflow-hidden rounded-[1.75rem] border border-stone-200 bg-stone-200/80">
            <div className="flex items-stretch bg-white/45 overflow-hidden rounded-[1.5rem]">
                {timelineSlots.map((slot) => {
                  const isMissing = slot.state === "missing_expected";
                  const isReadyAfterGap = slot.state === "ready_after_gap";
                  const isPlayingSlot = slot.state === "playing";
                  const isPlayed = slot.state === "played";
                  const isFailed = slot.state === "failed";
                  const isReprocessingSlot = slot.reprocessing;

                  return (
                    <button
                      aria-label={describeTimelineSlot(slot)}
                      className={`group relative h-12 overflow-hidden border-y border-transparent text-left transition ${
                        slot.isAnchor
                          ? "z-10 border-stone-900/60 shadow-[0_0_0_1px_rgba(28,25,23,0.18)]"
                          : ""
                      } ${isFailed ? "cursor-not-allowed" : "cursor-pointer"}`}
                      data-slot-state={slot.state}
                      key={slot.chunk.index}
                    onClick={() => void handleTimelineSlotClick(slot)}
                    onFocus={() => setHoveredChunkIndex(slot.chunk.index)}
                    onMouseEnter={() => setHoveredChunkIndex(slot.chunk.index)}
                    onMouseLeave={() => setHoveredChunkIndex(null)}
                    onPointerDown={(event) => handleTimelinePointerDown(event, slot)}
                    onPointerMove={(event) => handleTimelinePointerMove(event, slot)}
                    onPointerUp={(event) => clearTimelineSeeking(event.pointerId)}
                    onPointerCancel={(event) => clearTimelineSeeking(event.pointerId)}
                    style={{
                      flex: `${slot.visualDurationSeconds} 0 0`,
                    }}
                      type="button"
                    >
                      <div
                        className={`absolute inset-0 ${
                          isFailed
                            ? "bg-rose-200/90"
                            : isPlayed
                              ? "bg-[var(--accent)]/85"
                              : isReprocessingSlot
                                ? "bg-stone-400/50"
                                : "bg-stone-400/65"
                        }`}
                      />
                      {isMissing && !isReprocessingSlot ? (
                        <div
                          className="absolute inset-0 opacity-85"
                          style={{
                            backgroundImage:
                              "repeating-linear-gradient(-45deg, rgba(220,38,38,0.28) 0px, rgba(220,38,38,0.28) 6px, transparent 6px, transparent 12px)",
                          }}
                        />
                      ) : null}
                      {isReprocessingSlot ? (
                        <div
                          className="absolute inset-0 animate-pulse"
                          style={{
                            backgroundColor: isPlayed
                              ? "rgba(120, 160, 140, 0.15)"
                              : "rgba(180, 180, 180, 0.15)",
                          }}
                        />
                      ) : null}
                      {!isPlayed && !isFailed && slot.fillPercent > 0 && !isReprocessingSlot ? (
                        <div
                          className="absolute inset-y-0 left-0 bg-[var(--accent)]/85"
                          style={{ width: `${Math.min(slot.fillPercent, 100)}%` }}
                        />
                      ) : null}
                      {isPlayingSlot ? (
                        <div
                          className="absolute inset-y-0 z-10 w-0.5 bg-stone-950/90"
                          style={{ left: `${Math.min(slot.fillPercent, 100)}%` }}
                        />
                      ) : null}
                      {slot.chunk.index < timelineSlots.length - 1 ? (
                        <div className="absolute inset-y-1 right-0 z-10 w-px bg-white/65" />
                      ) : null}
                      {/* Reload icon for reprocessing chunks */}
                      {isReprocessingSlot ? (
                        <div className="absolute inset-y-0 left-0 z-10 flex items-center justify-center">
                          <span className="text-lg leading-none" title="Reprocessing">↻</span>
                        </div>
                      ) : null}
                      {/* Version badge when reprocessing */}
                      {isReprocessingSlot ? (
                        <div className="absolute inset-x-0 bottom-0 z-10 flex justify-center">
                          <span className="rounded-full bg-stone-500/70 px-1.5 py-px text-[8px] font-bold text-white">
                            V{slot.chunk.version}
                          </span>
                        </div>
                      ) : null}
                      <div className="absolute inset-x-0 top-1 z-10 text-center text-[10px] font-semibold text-stone-900/55 transition group-hover:text-stone-950/80 group-focus-visible:text-stone-950/80">
                        {slot.chunk.index + 1}
                      </div>
                    </button>
                  );
                })}
            </div>
          </div>

          <div className="mt-4 grid gap-3 text-sm text-stone-700 md:grid-cols-[1.4fr_0.8fr]">
            {/* Chunk detail panel */}
            {detailSlot ? (
              (() => {
                const chunk = detailSlot.chunk;
                const chunkText = job ? getChunkText(chunk, job.source_text) : "";
                const isEditing = editingChunkIndex === chunk.index;
                const allVersions = knownChunks.filter((c) => c.index === chunk.index);
                const maxVersion = getLatestVersion(knownChunks, chunk.index);
                const retryCount = getRetryCount(chunk.status, chunk.version);
                const maxRetriesReached = chunk.status === "max_retries_exceeded" || maxVersion >= 3;

                const chunkDetailContent = (
                  <div className="rounded-2xl bg-white/70 p-4 space-y-3">
                    {/* Header: chunk number + version dropdown */}
                    <div className="flex items-center justify-between">
                      <div className="font-semibold">Chunk {chunk.index + 1}</div>
                      {allVersions.length > 1 ? (
                        <select
                          className="rounded-lg border border-stone-300 bg-white/80 px-2 py-1 text-xs"
                          value={activeVersions.get(chunk.index) ?? chunk.version}
                          onChange={(e) => handleVersionChange(chunk.index, Number(e.target.value))}
                        >
                          {allVersions.map((v) => (
                            <option key={v.version} value={v.version}>
                              V{v.version} {v.status === "written" ? "✓" : v.status}
                            </option>
                          ))}
                        </select>
                      ) : null}
                    </div>

                    {/* Text display / edit */}
                    <div className="rounded-xl bg-stone-100/80 p-3">
                      {isEditing ? (
                        <div className="space-y-2">
                          <textarea
                            className="w-full resize-none rounded-lg border border-stone-300 bg-white p-2 text-sm leading-relaxed"
                            rows={3}
                            value={editText}
                            onChange={(e) => setEditText(e.target.value)}
                          />
                          <div className="flex items-center gap-2">
                            <button
                              className="rounded-lg bg-[var(--accent)] px-3 py-1.5 text-xs font-semibold text-white"
                              onClick={handleSaveEdit}
                            >
                              Save &amp; Reprocess
                            </button>
                            <button
                              className="rounded-lg border border-stone-300 px-3 py-1.5 text-xs font-semibold text-stone-600"
                              onClick={handleCancelEdit}
                            >
                              Cancel
                            </button>
                          </div>
                        </div>
                      ) : (
                        <div>
                          <p className="max-h-20 overflow-y-auto text-sm leading-relaxed text-stone-700">
                            {chunkText || "(empty text)"}
                          </p>
                          <button
                            className="mt-1 text-xs text-stone-500 hover:text-stone-800"
                            onClick={() => handleStartEdit(chunk)}
                          >
                            Edit text
                          </button>
                        </div>
                      )}
                    </div>

                    {/* Status info */}
                    <div className="flex flex-wrap items-center gap-2 text-xs">
                      <span className="rounded-full bg-stone-200/80 px-2 py-0.5">{chunkStatusText(detailSlot.state)}</span>
                      {chunk.duration_seconds > 0 ? (
                        <span className="text-stone-600">{chunk.duration_seconds.toFixed(1)}s</span>
                      ) : null}
                      <span className="text-stone-500">V{chunk.version}</span>
                    </div>

                    {/* Reprocess button */}
                    {!maxRetriesReached && (chunk.status === "written" || chunk.status === "failed" || detailSlot.state === "failed") ? (
                      <button
                        className={`w-full rounded-lg px-3 py-2 text-xs font-semibold transition ${
                          reprocessingChunkIndex === chunk.index
                            ? "bg-stone-300 text-stone-600"
                            : "bg-amber-100 text-amber-800 hover:bg-amber-200"
                        }`}
                        onClick={() => isEditing ? handleSaveEdit() : void handleReprocess(chunk.index)}
                        disabled={reprocessingChunkIndex === chunk.index}
                      >
                        {reprocessingChunkIndex === chunk.index
                          ? "Reprocessing…"
                          : chunk.status === "failed" || detailSlot.state === "failed"
                            ? `Retry (${retryCount}/3)`
                            : `Reprocess (${retryCount}/3)`}
                      </button>
                    ) : null}

                    {maxRetriesReached ? (
                      <div className="rounded-lg bg-rose-100/80 px-3 py-2 text-xs text-rose-700">
                        Max retries exceeded (3/3)
                      </div>
                    ) : null}

                    {/* Version-specific info */}
                    {detailSlot.state === "ready_after_gap" ? (
                      <div className="text-xs text-amber-600">Ready, but blocked until earlier missing chunks arrive.</div>
                    ) : null}
                    {detailSlot.state === "missing_expected" && !detailSlot.reprocessing ? (
                      <div className="text-xs text-amber-600">This chunk is expected but has not arrived yet.</div>
                    ) : null}
                    {detailSlot.reprocessing ? (
                      <div className="text-xs text-stone-500">New version being rendered. Current version remains playable.</div>
                    ) : null}

                    {reprocessError ? (
                      <div className="rounded-lg bg-rose-100/80 px-3 py-2 text-xs text-rose-700">{reprocessError}</div>
                    ) : null}
                  </div>
                );

                return chunkDetailContent;
              })()
            ) : (
              <div className="rounded-2xl bg-white/70 p-4">
                <div className="font-semibold">No chunk selected</div>
                <div className="text-sm text-stone-600">
                  Press play to arm playback and wait for the first rendered audio chunk.
                </div>
              </div>
            )}

            {/* Live status panel */}
            <div className="rounded-2xl bg-white/70 p-4">
              <div className="mb-2 font-semibold">Live status</div>
              <div>
                {isJobTerminal
                  ? "Reader is local-only"
                  : websocketStatus === "open" && !isSocketStale
                    ? "WS live"
                    : "Fallback sync"}
              </div>
              <div>
                {writtenChunkCount}/{activeChunks.length} chunks rendered
              </div>
              <div>
                {totalChunksInJob} total chunks emitted
              </div>
            </div>
          </div>

          <label
            className="mb-2 mt-5 block text-sm font-semibold uppercase tracking-[0.2em] text-stone-600"
            htmlFor="voice-change-select"
          >
            Voice for future chunks
          </label>
          <select
            className="w-full rounded-2xl border border-stone-300 bg-white/70 px-4 py-3"
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

        <details className="panel rounded-[2rem] p-6" open>
          <summary className="cursor-pointer text-lg font-semibold">Live diagnostics</summary>
          <div className="mt-4 grid gap-3 text-sm text-stone-700 md:grid-cols-2">
            <div className="rounded-2xl bg-white/70 p-4">
              Socket: {isJobTerminal ? "idle" : websocketStatus}
              {isSocketStale ? " (stale)" : ""}
            </div>
            <div className="rounded-2xl bg-white/70 p-4">
              Last live event: {formatRelativeTime(lastSocketMessageAt)}
            </div>
            <div className="rounded-2xl bg-white/70 p-4">
              Reader refresh: {formatRelativeTime(lastRefreshAt)} via {lastRefreshReason}
            </div>
            <div className="rounded-2xl bg-white/70 p-4">
              Appended chunks: {appendedChunksCount}
            </div>
            <div className="rounded-2xl bg-white/70 p-4">
              Playback anchor: Chunk {playbackAnchorIndex + 1}
            </div>
            <div className="rounded-2xl bg-white/70 p-4">
              Expected next chunk:{" "}
              {expectedNextChunkIndex === null ? "none" : `Chunk ${expectedNextChunkIndex + 1}`}
            </div>
            <div className="rounded-2xl bg-white/70 p-4">
              Playback intent: {playIntent ? "armed" : "paused"}
            </div>
            <div className="rounded-2xl bg-white/70 p-4">Player state: {playerState}</div>
            <div className="rounded-2xl bg-white/70 p-4">
              Audio: {isActuallyPlaying ? "playing" : diagnostics.paused ? "paused" : "ready"}
            </div>
            <div className="rounded-2xl bg-white/70 p-4">
              Waiting for data: {isWaitingForData ? "yes" : "no"}
            </div>
            <div className="rounded-2xl bg-white/70 p-4">
              Stream primed: {isStreamPrimed ? "yes" : "no"}
            </div>
            <div className="rounded-2xl bg-white/70 p-4">
              Ready after gap: {writtenAfterGapIndexes.size}
            </div>
            <div className="rounded-2xl bg-white/70 p-4">
              Missing expected: {missingExpectedIndexes.size}
            </div>
            <div className="rounded-2xl bg-white/70 p-4">
              Buffered until: {bufferedUntilSeconds.toFixed(1)}s
            </div>
            <div className="rounded-2xl bg-white/70 p-4">
              Current time: {currentTimeSeconds.toFixed(1)}s
            </div>
            <div className="rounded-2xl bg-white/70 p-4">
              Audio ready/network: {diagnostics.readyState}/{diagnostics.networkState}
            </div>
            <div className="rounded-2xl bg-white/70 p-4">
              Speed (state): {playbackRate.toFixed(3)}×
            </div>
            <div className="rounded-2xl bg-white/70 p-4">
              Speed (DOM): {diagnostics.playbackRate.toFixed(3)}×
            </div>
            <div className="rounded-2xl bg-white/70 p-4 md:col-span-2">
              Last transport/player issue:{" "}
              {lastPlayerError ?? lastPlaybackSyncError ?? lastSocketError ?? "none"}
            </div>
          </div>
        </details>

        <div className="panel rounded-[2rem] p-6">
          <h2 className="mb-3 text-lg font-semibold">Chunk status</h2>
          <div className="space-y-2">
            {activeChunks.map((chunk) => {
              const allVersions = knownChunks.filter((c) => c.index === chunk.index);
              return (
                <div
                  className="rounded-2xl border border-stone-200 bg-white/60 px-4 py-3"
                  key={chunk.index}
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span className="font-medium">Chunk {chunk.index + 1}</span>
                      <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${
                        chunk.status === "written" ? "bg-emerald-100 text-emerald-700" :
                        chunk.status === "failed" || chunk.status === "max_retries_exceeded" ? "bg-rose-100 text-rose-700" :
                        chunk.status === "reprocessing" ? "bg-amber-100 text-amber-700" :
                        "bg-stone-100 text-stone-600"
                      }`}>
                        {chunk.status}
                      </span>
                      <span className="text-xs text-stone-500">V{chunk.version}</span>
                      {chunk.duration_seconds > 0 ? (
                        <span className="text-xs text-stone-500">• {chunk.duration_seconds.toFixed(1)}s</span>
                      ) : null}
                      {chunk.reprocessing ? (
                        <span className="text-xs text-stone-400">↻ reprocessing</span>
                      ) : null}
                    </div>
                    <div className="flex items-center gap-1">
                      {allVersions.map((v) => (
                        <button
                          key={v.version}
                          className={`rounded px-1.5 py-0.5 text-xs ${
                            v.version === chunk.version
                              ? "bg-[var(--accent)] text-white"
                              : v.deprecated
                                ? "text-stone-400 line-through"
                                : "text-stone-600 hover:bg-stone-100"
                          }`}
                          onClick={() => handleVersionChange(chunk.index, v.version)}

                        >
                          V{v.version}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
