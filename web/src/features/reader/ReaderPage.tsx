import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Navigate, useParams } from "react-router-dom";
import { useShallow } from "zustand/shallow";

import { ChunkConveyor } from "../../components/ChunkConveyor";
import { Playbar } from "../../components/Playbar";
import { ReaderDock } from "../../components/ReaderDock";
import { ReaderSettingsMenu } from "../../components/ReaderSettingsMenu";
import { useAppBootstrap } from "../../hooks/useAppBootstrap";
import { useChunkWaveforms } from "../../hooks/useChunkWaveforms";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import { usePlaybackShortcuts } from "../../hooks/usePlaybackShortcuts";
import { useReaderSettings, useReaderMotion } from "../../hooks/useReaderSettings";
import { useRuntimeStatus } from "../../hooks/useRuntimeStatus";
import { ApiError, api } from "../../lib/api";
import { liveClient } from "../../lib/live-client";
import { useMediaSourcePlayer } from "../../lib/media-source";
import { modelLabel } from "../../lib/models";
import { resetReaderSettings, setReaderSettings } from "../../state/reader-settings";
import { useAppStore } from "../../state/store";
import type { Chunk, JobDetail, JobManifest } from "../../types/api";
import type { TimelineSlotData } from "../../types/timeline";
import { getChunkText, isTerminalStatus } from "./chunk-utils";
import { PlaybackSpeedControl } from "./PlaybackSpeedControl";
import {
  buildManifestFromPatch,
  buildStreamManifest,
  chunkStartSeconds,
  deriveActiveChunkProgress,
  deriveActiveChunks,
  deriveActiveVersionMap,
  derivePlaybackModel,
  deriveTimelineSlots,
  mergeJobPatch,
  mergeKnownChunks,
  skipTargetSeconds,
  type StreamEventMeta,
  type StreamEventPayload,
} from "./reader-model";
import { buildReaderTextSegments } from "./reader-text";
import {
  ReaderContent,
  ReaderTextBody,
} from "./ReaderText";
import { ReaderSidebar } from "./ReaderSidebar";
import { RenderingStallBanner } from "./RenderingStallBanner";
import { isRenderingStalled } from "./transport";

/* ── Constants ────────────────────────────────────────────── */

const READER_POLL_INTERVAL_MS = 2_000;
/** How many times the reader retries a failed initial load before surfacing the
 *  error. A WebSocket reconnect resets the budget (see the reconnect effect). */
const INITIAL_LOAD_MAX_RETRIES = 5;
const PLAYBACK_SYNC_INTERVAL_MS = 3_000;
const GAP_BUFFERING_EPSILON_SECONDS = 0.5;
/** How often the reader re-checks whether rendering has stalled. */
const RENDER_STALL_POLL_MS = 5_000;

/* ── Store state type ─────────────────────────────────────── */

interface ReaderPageStoreState {
  lastEvent: ReturnType<typeof useAppStore.getState>["lastEvent"];
  websocketStatus: ReturnType<typeof useAppStore.getState>["websocketStatus"];
  isSocketStale: ReturnType<typeof useAppStore.getState>["isSocketStale"];
  voices: ReturnType<typeof useAppStore.getState>["voices"];
}

/* ── Component ────────────────────────────────────────────── */

export function ReaderPage() {
  const { jobId = "" } = useParams();
  const { lastEvent, websocketStatus, isSocketStale, voices } = useAppStore(
    useShallow(
      (state): ReaderPageStoreState => ({
        lastEvent: state.lastEvent,
        websocketStatus: state.websocketStatus,
        isSocketStale: state.isSocketStale,
        voices: state.voices,
      }),
    ),
  );

  const [job, setJob] = useState<JobDetail | null>(null);
  const [manifest, setManifest] = useState<JobManifest | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // The id of a job the backend confirmed is gone (404). Stored as the id — not
  // a boolean — so navigating to a different job id clears it during render
  // instead of needing an effect.
  const [missingJobId, setMissingJobId] = useState<string | null>(null);
  const isMissingJob = missingJobId === jobId;
  // Counts fallback retries of a failed initial load; bounded so a genuinely
  // dead backend surfaces an error instead of being polled forever.
  const [loadRetryAttempt, setLoadRetryAttempt] = useState(0);
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

  // ── Responsive chrome ───────────────────────────────────
  // The first render derives from `window.innerWidth` because jsdom reports
  // every media query as non-matching; the live query takes over after mount.
  const hasWindow = typeof window !== "undefined";
  const isLargeScreen = useMediaQuery(
    "(min-width: 1024px)",
    hasWindow ? window.innerWidth >= 1024 : true,
  );
  const isPhoneViewport = useMediaQuery(
    "(max-width: 767px)",
    hasWindow ? window.innerWidth < 768 : false,
  );

  const [sidebarOpen, setSidebarOpen] = useState(isLargeScreen);

  // The sidebar is inline on large screens and an overlay below them. Only an
  // actual breakpoint change moves it, so a manual toggle survives re-renders.
  const previousIsLargeScreenRef = useRef(isLargeScreen);
  useEffect(() => {
    if (previousIsLargeScreenRef.current === isLargeScreen) return;
    previousIsLargeScreenRef.current = isLargeScreen;
    setSidebarOpen(isLargeScreen);
  }, [isLargeScreen]);

  const toggleSidebar = useCallback(() => setSidebarOpen((prev) => !prev), []);

  const refreshRequestIdRef = useRef(0);
  const lastAppliedRequestIdRef = useRef(0);
  const refreshInFlightRef = useRef<Promise<void> | null>(null);
  const queuedRefreshReasonRef = useRef<string | null>(null);
  const lastPlaybackSyncAtRef = useRef(0);
  const manifestRef = useRef<JobManifest | null>(null);
  const previousSocketStatusRef = useRef(websocketStatus);

  const isJobTerminal = isTerminalStatus(job?.status);
  useAppBootstrap(!loading && !!job && !isJobTerminal);

  // Device-local reader preferences (jump controls, conveyor, motion).
  const settings = useReaderSettings();
  const motion = useReaderMotion();

  // ── Derived data ────────────────────────────────────────
  const knownChunks = useMemo(() => mergeKnownChunks(job, manifest), [job, manifest]);
  const activeVersions = useMemo(
    () => deriveActiveVersionMap(knownChunks, job?.active_chunk_version),
    [job?.active_chunk_version, knownChunks],
  );

  useEffect(() => {
    if (knownChunks.length === 0) {
      if (playbackAnchorIndex !== 0) setPlaybackAnchorIndex(0);
      return;
    }
    if (!knownChunks.some((c) => c.index === playbackAnchorIndex)) {
      setPlaybackAnchorIndex(knownChunks[0]?.index ?? 0);
    }
  }, [knownChunks, playbackAnchorIndex]);

  const activeChunks = useMemo(
    () => deriveActiveChunks(knownChunks, activeVersions),
    [knownChunks, activeVersions],
  );

  const playbackModel = useMemo(
    () => derivePlaybackModel(knownChunks, activeChunks, activeVersions, playbackAnchorIndex),
    [knownChunks, activeChunks, activeVersions, playbackAnchorIndex],
  );

  const {
    contiguousReadyChunks,
    expectedNextChunkIndex,
    downloadableChunks,
    knownDurationSeconds,
    anchorOffsetSeconds: anchorOffset,
  } = playbackModel;

  // A job whose model isn't the resident one is waiting behind another model's
  // queue (a model swap is a full GPU reload). Show that proactively instead
  // of only when playback finally runs dry.
  const runtimeStatus = useRuntimeStatus();
  const residentModelId = runtimeStatus?.resident_model_id ?? null;
  const residentVoiceId = runtimeStatus?.resident_voice_id ?? null;
  const waitingOnModel =
    !isJobTerminal &&
    !!job &&
    !!residentModelId &&
    job.model_id !== residentModelId &&
    expectedNextChunkIndex !== null;
  const residentVoiceLabel =
    voices.find((voice) => voice.id === residentVoiceId)?.display_name ??
    residentVoiceId ??
    "";

  const streamManifest = useMemo(
    () => buildStreamManifest(manifest, contiguousReadyChunks),
    [contiguousReadyChunks, manifest],
  );

  const canDownloadRenderedAudio = downloadableChunks.length > 0;
  const isDownloadComplete =
    !!job &&
    isJobTerminal &&
    downloadableChunks.length > 0 &&
    downloadableChunks.length === knownChunks.length;

  // Called by the player once a pending seek has been applied; clears the
  // reader's pending-seek state so auto-play can resume.
  const handleSeekApplied = useCallback(() => setSeekOverride(null), []);

  const {
    audioRef,
    appendedChunksCount,
    bufferedUntilSeconds,
    currentTimeSeconds,
    diagnostics,
    isActuallyPlaying,
    isAutoplayBlocked,
    isWaitingForData,
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
    pendingSeekSeconds: seekOverride !== null ? Math.max(0, seekOverride - anchorOffset) : null,
    onSeekApplied: handleSeekApplied,
  });

  // ── Render-stall detection ──────────────────────────────
  // The player can sit in "waiting for data" forever if the backend stops
  // producing; tracking when the last chunk arrived lets the UI tell "slow"
  // apart from "stopped" and offer a retry instead of spinning silently.
  const writtenChunkCount = activeChunks.reduce(
    (count, chunk) => (chunk.status === "written" ? count + 1 : count),
    0,
  );
  const lastChunkAtRef = useRef(Date.now());
  useEffect(() => {
    lastChunkAtRef.current = Date.now();
  }, [writtenChunkCount, jobId]);
  const [, forceStallTick] = useState(0);
  useEffect(() => {
    if (!playIntent || isJobTerminal) return;
    const id = window.setInterval(
      () => forceStallTick((tick) => tick + 1),
      RENDER_STALL_POLL_MS,
    );
    return () => window.clearInterval(id);
  }, [playIntent, isJobTerminal]);
  const secondsSinceChunk = (Date.now() - lastChunkAtRef.current) / 1000;
  const renderingStalled = isRenderingStalled(
    { isJobTerminal, playIntent, isWaitingForData },
    secondsSinceChunk,
  );
  const [stallDismissed, setStallDismissed] = useState(false);
  useEffect(() => {
    // A recovered producer clears the dismissal so a later stall is shown again.
    if (!renderingStalled) setStallDismissed(false);
  }, [renderingStalled]);
  const [isRetryingStall, setIsRetryingStall] = useState(false);

  const activeProgress = useMemo(
    () => deriveActiveChunkProgress(contiguousReadyChunks, currentTimeSeconds),
    [contiguousReadyChunks, currentTimeSeconds],
  );

  // Static waveform peaks for the playbar, fetched from the backend per chunk.
  // Updates automatically as chunks arrive or are reprocessed.
  const waveforms = useChunkWaveforms(activeChunks);

  // ── Timeline slots (for WaveformTimeline) ───────────────
  const timelineSlots = useMemo<TimelineSlotData[]>(
    () => deriveTimelineSlots(activeChunks, playbackModel, activeProgress, playbackAnchorIndex),
    [activeChunks, playbackModel, activeProgress, playbackAnchorIndex],
  );

  const detailSlot = useMemo(() => {
    const targetIndex = activeProgress.activeChunkIndex;
    if (targetIndex === null) return null;
    return activeChunks.find((c) => c.index === targetIndex) ?? null;
  }, [activeProgress.activeChunkIndex, activeChunks]);

  const shouldUsePollingFallback =
    !!job && !isTerminalStatus(job.status) && (websocketStatus !== "open" || isSocketStale);

  // ── Effects ─────────────────────────────────────────────
  useEffect(() => {
    manifestRef.current = manifest;
  }, [manifest]);

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
          if (loadError instanceof ApiError && loadError.status === 404) {
            setMissingJobId(jobId);
            return;
          }
          setError(
            loadError instanceof Error ? loadError.message : "Unable to refresh reader state",
          );
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
      const isPlaying =
        isPlayingOverride ?? (playIntent && (!audioRef.current.paused || isWaitingForData));
      const currentTime = audioRef.current.currentTime ?? 0;
      const sent = liveClient.sendPlaybackSync(job.id, currentTime, isPlaying);
      if (sent) {
        setLastPlaybackSyncError(null);
      } else {
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

  /**
   * Apply a job patch from a WebSocket event or a mutation response, keeping the
   * loaded detail intact. Per-chunk events carry one chunk (`payload.chunk`);
   * `job_updated` and the voice/reprocess endpoints still carry full detail.
   */
  const applyJobPatch = useCallback(
    (patch: StreamEventPayload["job"], chunk?: Chunk, meta: StreamEventMeta = {}) => {
      if (!patch) return;
      setJob((prev) => (prev ? mergeJobPatch(prev, patch, chunk) : prev));
      setManifest((prev) => buildManifestFromPatch(prev, patch, chunk, meta));
    },
    [],
  );

  useEffect(() => {
    void refreshReaderState("initial", true);
  }, [refreshReaderState]);

  // The live link only returns through "reconnecting" after a real drop, so a
  // first connect ("connecting" → "open") is ignored — the initial load already
  // fetched. A genuine reconnect means the server restarted, and because jobs
  // are in-memory the one we are holding may be gone. Revalidate it: this is
  // what catches a job that vanished while the tab stayed open (a completed job
  // has polling off and will never receive another event).
  useEffect(() => {
    const previous = previousSocketStatusRef.current;
    previousSocketStatusRef.current = websocketStatus;
    if (websocketStatus !== "open" || previous === "open" || previous === "connecting") {
      return;
    }
    setLoadRetryAttempt(0);
    void refreshReaderState("reconnect");
  }, [refreshReaderState, websocketStatus]);

  // Fallback for a failed initial load: retry a bounded number of times. This
  // exists because the API and the page can restart together, so the first
  // request fails with a network error (no status) before the reconnect effect
  // above ever gets a socket. Bounded so a dead backend is not polled forever.
  useEffect(() => {
    if (job || isMissingJob) return;
    if (loadRetryAttempt >= INITIAL_LOAD_MAX_RETRIES) return;
    const timer = window.setTimeout(() => {
      setLoadRetryAttempt((attempt) => attempt + 1);
      void refreshReaderState("retry");
    }, READER_POLL_INTERVAL_MS);
    return () => window.clearTimeout(timer);
  }, [isMissingJob, job, loadRetryAttempt, refreshReaderState]);

  useEffect(() => {
    const payload = lastEvent?.payload as StreamEventPayload | undefined;
    const eventJob = payload?.job;
    if (!lastEvent || !eventJob || eventJob.id !== jobId) return;
    if (
      lastEvent.type !== "job_updated" &&
      lastEvent.type !== "job_completed" &&
      lastEvent.type !== "chunk_ready"
    ) {
      return;
    }
    applyJobPatch(eventJob, payload?.chunk, payload);
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
  }, [applyJobPatch, jobId, lastEvent, refreshReaderState]);

  useEffect(() => {
    if (!shouldUsePollingFallback) return;
    const timer = window.setInterval(() => {
      void refreshReaderState("poll");
    }, READER_POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [refreshReaderState, shouldUsePollingFallback]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !job) return;
    const handlePlay = () => {
      if (isJobTerminal) setPlayIntent(true);
      syncPlaybackState(true, true);
    };
    const handlePause = () => {
      if (isJobTerminal) {
        setPlayIntent(false);
        syncPlaybackState(true, false);
        return;
      }
      if (!playIntent) syncPlaybackState(true, false);
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
      if (playIntent || isWaitingForData) syncPlaybackState();
    }, PLAYBACK_SYNC_INTERVAL_MS);
    return () => {
      audio.removeEventListener("play", handlePlay);
      audio.removeEventListener("pause", handlePause);
      audio.removeEventListener("waiting", handleWaiting);
      audio.removeEventListener("ended", handleEnded);
      audio.removeEventListener("error", handleError);
      window.clearInterval(interval);
    };
  }, [
    audioRef,
    isJobTerminal,
    isWaitingForData,
    job,
    playIntent,
    renderedDurationSeconds,
    syncPlaybackState,
  ]);

  // Time display values in original (non-normalized) coordinates.
  // While a seek is pending the stream is rebuilding/priming, so
  // currentTimeSeconds is stale (reset to 0 at the new anchor). Showing the seek
  // target instead keeps the playhead at the released position rather than
  // briefly snapping back to the start of the anchored chunk.
  const displayTimeSeconds = seekOverride ?? currentTimeSeconds + anchorOffset;
  const displayDurationSeconds = knownDurationSeconds;
  // End of the playable range in original timeline coordinates. The player's
  // renderedDurationSeconds is stream-normalized (resets at the playback
  // anchor), so it must be shifted back by the anchor offset before the
  // timeline — which renders in original coordinates — can use it as the
  // playhead maximum.
  const displayRenderedDurationSeconds = anchorOffset + renderedDurationSeconds;

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

  // ── Handlers ─────────────────────────────────────────────

  const handlePlay = async () => {
    if (!job) return;
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
      applyJobPatch(nextJob);
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
      applyJobPatch(nextJob);
      syncPlaybackState(true, false);
    } catch (pauseError) {
      setError(pauseError instanceof Error ? pauseError.message : "Unable to pause playback");
    }
  };

  // Keyboard/direct seeks use normalized stream coords and seek immediately
  // (no need to wait for buffer — the stream is already set up)
  /**
   * Relative seek for the −10s / +10s buttons and their shortcuts. Bounded by
   * the rendered stream, so skipping past the end lands on the last playable
   * position and lets the player enter its waiting state rather than seeking
   * into audio that does not exist.
   */
  const handleSkip = (deltaSeconds: number) => {
    if (renderedDurationSeconds <= 0) return;
    seekToSeconds(skipTargetSeconds(currentTimeSeconds, deltaSeconds, renderedDurationSeconds));
  };

  const handleTogglePlay = () => {
    if (isActuallyPlaying || playIntent) void handlePause();
    else void handlePlay();
  };

  // Page-wide playback keys: the reader should not require clicking the
  // controls first. Handlers are read from a ref inside the hook, so this does
  // not resubscribe on every playback tick.
  usePlaybackShortcuts({ togglePlay: handleTogglePlay, skipBy: handleSkip });

  const handleSeekToChunk = useCallback(
    async (chunkIndex: number, seekSeconds: number) => {
      if (!job) return;
      // Seeking preserves the current play state: a playing player stays playing
      // (resuming once the new stream is ready), a paused player stays paused at
      // the new position. Only an actively-playing player needs the job
      // re-activated for backend scheduling.
      const resumeAfterSeek = playIntent;
      setPlaybackAnchorIndex(chunkIndex);
      setSeekOverride(seekSeconds);
      setError(null);
      if (isJobTerminal) {
        if (resumeAfterSeek) await requestUserGesturePlay();
        return;
      }
      if (!resumeAfterSeek) return;
      try {
        const nextJob = await api.activateJob(job.id);
        applyJobPatch(nextJob);
        await requestUserGesturePlay();
      } catch (activationError) {
        setPlayIntent(false);
        setSeekOverride(null);
        setError(
          activationError instanceof Error
            ? activationError.message
            : "Unable to activate playback",
        );
      }
    },
    [applyJobPatch, isJobTerminal, job, playIntent, requestUserGesturePlay],
  );

  // Track the last user-initiated chunk change so the scroll-into-view effect
  // can distinguish explicit seeks from automatic playback progression.
  const userScrolledChunkRef = useRef<number | null>(null);

  const handleSeekToChunkWithScroll = useCallback(
    async (chunkIndex: number, seekSeconds: number) => {
      userScrolledChunkRef.current = chunkIndex;
      await handleSeekToChunk(chunkIndex, seekSeconds);
    },
    [handleSeekToChunk],
  );

  /**
   * Jump to a chunk from its block in the reader text. Stable identity matters:
   * `ReaderChunkBlock` is memoized, so an unstable callback would re-render
   * every block in a book on every playback tick.
   */
  const handleJumpToChunk = useCallback(
    (chunkIndex: number) => {
      void handleSeekToChunkWithScroll(chunkIndex, chunkStartSeconds(activeChunks, chunkIndex));
    },
    [activeChunks, handleSeekToChunkWithScroll],
  );

  /**
   * Retry a stalled render: re-fetch state (in case the producer died and the
   * reader missed events) and re-activate the job so the backend schedules it
   * again. Also resets the stall timer so the banner cannot re-fire instantly.
   */
  const handleRetryRender = useCallback(async () => {
    if (!job) return;
    setIsRetryingStall(true);
    try {
      await refreshReaderState("stall-retry");
      const nextJob = await api.activateJob(job.id);
      applyJobPatch(nextJob);
      setError(null);
      lastChunkAtRef.current = Date.now();
    } catch (retryError) {
      setError(
        retryError instanceof Error ? retryError.message : "Unable to retry rendering",
      );
    } finally {
      setIsRetryingStall(false);
    }
  }, [applyJobPatch, job, refreshReaderState]);

  const handleSettingsChange = useCallback((patch: Partial<typeof settings>) => {
    setReaderSettings(patch);
  }, []);

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
      setDownloadError(
        downloadFailure instanceof Error
          ? downloadFailure.message
          : "Unable to download rendered audio",
      );
    } finally {
      setIsDownloading(false);
    }
  }, [downloadableChunks.length, job]);

  const handleVoiceChange = async (voiceId: string, rerenderWritten = false) => {
    if (!job) return;
    try {
      const nextJob = await api.updateJobVoice(job.id, voiceId, rerenderWritten);
      if (rerenderWritten) {
        // Every chunk was invalidated so the old take is gone. Reset the local
        // playback state to match: the bumped audio epoch tears the MSE stream
        // down, and these are the reader-side equivalents (no autoplay into an
        // empty stream, playhead back at the start).
        setPlayIntent(false);
        pausePlayback();
        setSeekOverride(null);
        setPlaybackAnchorIndex(0);
      }
      applyJobPatch(nextJob);
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
        const nextJob = await api.reprocessChunk(job.id, chunkIndex, {
          new_text: newText,
          new_voice_id: undefined,
        });
        applyJobPatch(nextJob);
        setError(null);
        setTimeout(() => refreshReaderState("reprocess"), 1000);
      } catch (err) {
        setReprocessError(err instanceof Error ? err.message : "Reprocessing failed");
      } finally {
        setReprocessingChunkIndex(null);
      }
    },
    [applyJobPatch, job, refreshReaderState],
  );

  const handleVersionChange = useCallback(
    async (chunkIndex: number, version: number) => {
      if (!job) return;
      try {
        const nextJob = await api.setActiveVersion(job.id, chunkIndex, version);
        applyJobPatch(nextJob);
        setError(null);
        setReprocessError(null);
      } catch (err) {
        setReprocessError(err instanceof Error ? err.message : "Version switch failed");
      }
    },
    [applyJobPatch, job],
  );

  const handleStartEdit = useCallback(
    (chunk: Chunk) => {
      const text = job ? getChunkText(chunk, job.source_text) : "";
      setEditText(text);
      setEditingChunkIndex(chunk.index);
    },
    [job],
  );

  const handleSaveEdit = useCallback(() => {
    if (editingChunkIndex !== null) void handleReprocess(editingChunkIndex, editText);
  }, [editingChunkIndex, editText, handleReprocess]);

  const handleCancelEdit = useCallback(() => {
    setEditingChunkIndex(null);
    setEditText("");
  }, []);

  const totalChunksInJob = job?.total_chunks_emitted ?? knownChunks.length;

  // ── Scroll-sync chunk content ───────────────────────────
  const contentRef = useRef<HTMLDivElement>(null);
  const chunkRefs = useRef<Map<number, HTMLDivElement>>(new Map());

  const handleRegisterChunkRef = useCallback(
    (chunkIndex: number, element: HTMLDivElement | null) => {
      if (element) chunkRefs.current.set(chunkIndex, element);
      else chunkRefs.current.delete(chunkIndex);
    },
    [],
  );

  // Reset userScrolledChunkRef after a brief window
  useEffect(() => {
    if (userScrolledChunkRef.current === null) return;
    const timer = setTimeout(() => {
      userScrolledChunkRef.current = null;
    }, 400);
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
    window.addEventListener("scroll", handleScroll, { passive: true });
    return () => window.removeEventListener("scroll", handleScroll);
  }, []);

  // ── Reader text layout — must be before early returns ─────
  // Slicing the document is memoized so playback ticks (which re-render the
  // reader ~20x/s) never re-slice a book-sized source text.
  const textSegments = useMemo(
    () => buildReaderTextSegments(activeChunks, job?.source_text ?? ""),
    [activeChunks, job?.source_text],
  );

  // ── Loader / error / main content ──────────────────────
  // A single wrapper is returned for every state so the <audio> element keeps
  // its identity across the loading → loaded transition. useMediaSourcePlayer
  // attaches its media event listeners from an effect guarded on the element
  // existing, so a remount there would silently drop progress / seeking /
  // playing events for the rest of the session.
  const audioElement = (
    <audio
      aria-hidden="true"
      className="hidden"
      ref={audioRef as React.RefObject<HTMLAudioElement | null>}
    />
  );

  // Still inside the bounded initial-load retry budget: a restart is the common
  // cause, so show a calm reconnect state instead of a red failure.
  const isRetryingInitialLoad =
    !job && !isMissingJob && loadRetryAttempt < INITIAL_LOAD_MAX_RETRIES;

  let content: React.ReactNode;

  if (loading) {
    content = (
      <div className="flex items-center justify-center py-20">
        <div className="flex items-center gap-3 text-sm text-[var(--ink-secondary)]">
          <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-[var(--amber)] border-t-transparent" />
          Loading reader…
        </div>
      </div>
    );
  } else if (isMissingJob) {
    // Unknown job id — send the user back to the jobs page. `replace` keeps the
    // dead URL out of history so Back does not bounce through it again.
    content = <Navigate replace to="/" />;
  } else if (!job) {
    content = isRetryingInitialLoad ? (
      <div className="flex items-center justify-center py-20">
        <div className="flex items-center gap-3 text-sm text-[var(--ink-secondary)]">
          <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-[var(--amber)] border-t-transparent" />
          Reconnecting to the server…
        </div>
      </div>
    ) : (
      <div className="rounded-xl border border-[var(--rose)]/20 bg-[var(--rose)]/10 px-5 py-8 text-center text-sm text-[var(--rose)]">
        {error ?? "Job not found"}
      </div>
    );
  } else {
    const readerLines: React.ReactNode = (
      <ReaderTextBody
        activeChunkIndex={activeProgress.activeChunkIndex}
        onJumpToChunk={handleJumpToChunk}
        onRegisterChunkRef={handleRegisterChunkRef}
        playedIndexes={activeProgress.playedIndexes}
        segments={textSegments}
        showJumpButtons={settings.showChunkJumpButtons}
      />
    );

    content = (
      <>
      {/* Sticky playbar wrapper — flush against the app header */}
      <div className="sticky top-[56px] z-30 w-full">
        {/* Background layer — fades in smoothly with scroll progress */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 transition-all duration-300"
          style={{
            background: "var(--surface)",
            opacity: scrollProgress * 0.95,
            backdropFilter:
              scrollProgress > 0.05 ? `blur(${Math.round(scrollProgress * 12)}px)` : "none",
            WebkitBackdropFilter:
              scrollProgress > 0.05 ? `blur(${Math.round(scrollProgress * 12)}px)` : "none",
            borderBottom: scrollProgress > 0.05 ? "1px solid var(--line)" : "1px solid transparent",
            boxShadow: scrollProgress > 0.5 ? "0 1px 3px rgba(0,0,0,0.3)" : "none",
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
            displayDurationSeconds={displayDurationSeconds}
            displayRenderedDurationSeconds={displayRenderedDurationSeconds}
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
            onSeekToChunk={handleSeekToChunkWithScroll}
            onSkip={handleSkip}
            renderedDurationSeconds={renderedDurationSeconds}
            showTransport={!isPhoneViewport}
            speedSlot={
              <PlaybackSpeedControl value={playbackRate} onChange={setPlaybackRate} />
            }
            settingsSlot={
              <ReaderSettingsMenu
                isOverlay={!isLargeScreen}
                onChange={handleSettingsChange}
                onReset={resetReaderSettings}
                settings={settings}
                showConveyorControls
              />
            }
            slots={timelineSlots}
            totalChunks={totalChunksInJob}
            waveforms={waveforms}
            writtenChunks={writtenChunkCount}
          />

          {/* Chunk conveyor — the zoomed, thumb-sized scrub strip. Shares the
              sticky wrapper with the main playbar so it stays reachable while
              reading deep into a long document. Phones move it into the bottom
              dock instead, where a thumb can actually reach it. */}
          {settings.showConveyor && !isPhoneViewport ? (
            <div className="mt-2">
              <ChunkConveyor
                maxSeekSeconds={displayRenderedDurationSeconds}
                motion={motion}
                onSeek={handleSeekToChunkWithScroll}
                playheadSeconds={displayTimeSeconds}
                slots={timelineSlots}
                waveforms={waveforms}
                windowSizeSetting={settings.conveyorWindowSize}
              />
            </div>
          ) : null}
        </div>
      </div>

      {/* Warnings — in content area, below the header */}
      <div className="mx-auto w-full max-w-6xl px-4 pt-5 md:px-6">
        <div className="h-[44px]">
          <div
            aria-live="polite"
            className={`rounded-lg border px-4 py-3 text-xs transition-all duration-200 ${
              (!isJobTerminal && (websocketStatus !== "open" || isSocketStale)) ||
              error ||
              lastPlayerError ||
              downloadError
                ? "visible border-[var(--amber)]/20 bg-[var(--amber)]/10 text-[var(--amber)] opacity-100"
                : "invisible opacity-0"
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

      {/* Waiting on a model swap — the job's chunks are queued behind another
          model that has to finish or rotate first. */}
      {waitingOnModel ? (
        <div className="mx-auto w-full max-w-6xl px-4 pt-3 md:px-6">
          <div
            className="rounded-lg border border-[var(--line)] bg-[var(--surface-raised)] px-4 py-3 text-xs text-[var(--ink-secondary)]"
            role="status"
          >
            Waiting for the GPU: currently rendering {modelLabel(residentModelId)}
            {residentVoiceLabel ? ` · ${residentVoiceLabel}` : ""}. This job starts
            when that model rotates (about{" "}
            {runtimeStatus?.model_residency_batches ?? 10} batches) or its queue
            finishes.
          </div>
        </div>
      ) : null}

      {/* Rendering stall — the producer stopped; offer a retry instead of
          spinning "Buffering…" forever. */}
      {renderingStalled && !stallDismissed && !waitingOnModel ? (
        <div className="mx-auto w-full max-w-6xl px-4 pt-3 md:px-6">
          <RenderingStallBanner
            isRetrying={isRetryingStall}
            onDismiss={() => setStallDismissed(true)}
            onRetry={() => void handleRetryRender()}
          />
        </div>
      ) : null}

      {/* Main content area — reader text + sidebar. The extra bottom padding
          keeps the phone dock from covering the last block. */}
      <div
        className={`mx-auto w-full max-w-6xl px-4 py-4 md:px-6 md:py-6 ${
          isPhoneViewport && settings.showConveyor ? "pb-40" : ""
        }`}
      >
        {isLargeScreen && !sidebarOpen ? (
          /* ── Sidebar closed: reader centered ── */
          <div className="mx-auto flex w-full max-w-4xl flex-col">
            <ReaderContent
              contentRef={contentRef}
              title={job.title ?? "Untitled job"}
              status={job.status}
              lines={readerLines}
              isLargeScreen={isLargeScreen}
              isPlaying={isActuallyPlaying}
              motion={motion}
              sidebarOpen={sidebarOpen}
              onToggleSidebar={toggleSidebar}
            />
          </div>
        ) : (
          /* ── Sidebar open (or mobile): side-by-side ── */
          <div className="flex gap-6">
            <div className="min-w-0 flex-1">
              <ReaderContent
                contentRef={contentRef}
                title={job.title ?? "Untitled job"}
                status={job.status}
                lines={readerLines}
                isLargeScreen={isLargeScreen}
                isPlaying={isActuallyPlaying}
                motion={motion}
                sidebarOpen={sidebarOpen}
                onToggleSidebar={toggleSidebar}
              />
            </div>

            <ReaderSidebar
              detailChunk={detailSlot}
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
              playbackRate={playbackRate}
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
              overlayTogglePositionClassName={
                // The phone dock owns the bottom strip; lift the floating sidebar
                // toggle above it so the two controls never overlap.
                isPhoneViewport && settings.showConveyor ? "bottom-[10rem]" : undefined
              }
            />
          </div>
        )}
      </div>

      {/* Phone bottom dock — transport plus the conveyor, in the thumb zone. */}
      {isPhoneViewport && settings.showConveyor ? (
        <ReaderDock
          isAutoplayBlocked={isAutoplayBlocked}
          isPlaying={isActuallyPlaying}
          isWaitingForData={isWaitingForData}
          maxSeekSeconds={displayRenderedDurationSeconds}
          motion={motion}
          onPause={handlePause}
          onPlay={handlePlay}
          onSeek={handleSeekToChunkWithScroll}
          onSkip={handleSkip}
          playIntent={playIntent}
          playheadSeconds={displayTimeSeconds}
          slots={timelineSlots}
          waveforms={waveforms}
          windowSizeSetting={settings.conveyorWindowSize}
        />
      ) : null}
      </>
    );
  }

  return (
    <div className="flex flex-col">
      {audioElement}
      {content}
    </div>
  );
}
