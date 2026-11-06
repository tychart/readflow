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
import {
  useReaderMotion,
  useReaderSettings,
} from "../../hooks/useReaderSettings";
import { useRuntimeStatus } from "../../hooks/useRuntimeStatus";
import { useScrollProgressVar } from "../../hooks/useScrollProgress";
import { ApiError, api } from "../../lib/api";
import { modelLabel } from "../../lib/models";
import {
  playerIsSecondsBehindRetainedAudio,
  playerIsSecondsLoaded,
  playerPause,
  playerRequestGesture,
  playerSeekToSeconds,
  playerSeekWithinBuffered,
  usePlayerStore,
} from "../../player/player-store";
import {
  resetReaderSettings,
  setReaderSettings,
} from "../../state/reader-settings";
import { setReaderTitle } from "../../state/reader-title";
import { useAppStore } from "../../state/store";
import type { Chunk, JobDetail, JobManifest } from "../../types/api";
import type { TimelineSlotData } from "../../types/timeline";
import { getChunkText, isTerminalStatus } from "./chunk-utils";
import { ReaderSidebar } from "./ReaderSidebar";
import { ReaderContent, ReaderTextBody } from "./ReaderText";
import { RenderingStallBanner } from "./RenderingStallBanner";
import { RenderToEndButton } from "./RenderToEndButton";
import {
  buildManifestFromPatch,
  buildStreamManifest,
  chunkIndexAtSeconds,
  chunkStartSeconds,
  deriveActiveChunkProgress,
  deriveActiveChunks,
  deriveActiveVersionMap,
  derivePlaybackModel,
  deriveTimelineSlots,
  mergeJobPatch,
  mergeKnownChunks,
  type StreamEventMeta,
  type StreamEventPayload,
  skipTargetSeconds,
} from "./reader-model";
import { buildReaderTextSegments } from "./reader-text";
import { isRenderingStalled } from "./transport";

/* ── Constants ────────────────────────────────────────────── */

const READER_POLL_INTERVAL_MS = 2_000;
/** How many times the reader retries a failed initial load before surfacing the
 *  error. A WebSocket reconnect resets the budget (see the reconnect effect). */
const INITIAL_LOAD_MAX_RETRIES = 5;
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
  const playIntent = usePlayerStore((state) => state.playIntent);
  const setPlayIntent = usePlayerStore((state) => state.setPlayIntent);
  const playbackAnchorIndex = usePlayerStore((state) => state.anchorIndex);
  const setPlaybackAnchorIndex = usePlayerStore(
    (state) => state.setAnchorIndex,
  );
  // Bumped when a seek targets audio the player no longer holds (evicted behind
  // the retained window, or not fetched yet) *without* changing the anchor, so
  // the player reopens the SourceBuffer instead of clamping to loaded audio.
  const restartStream = usePlayerStore((state) => state.restartStream);
  const [lastRefreshAt, setLastRefreshAt] = useState<number | null>(null);
  const [lastRefreshReason, setLastRefreshReason] = useState("initial");
  const lastPlaybackSyncError = usePlayerStore((state) => state.lastSyncError);

  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [isDownloading, setIsDownloading] = useState(false);
  const [isRenderingToEnd, setIsRenderingToEnd] = useState(false);
  const [editingChunkIndex, setEditingChunkIndex] = useState<number | null>(
    null,
  );
  const [editText, setEditText] = useState("");
  const [reprocessingChunkIndex, setReprocessingChunkIndex] = useState<
    number | null
  >(null);
  const [reprocessError, setReprocessError] = useState<string | null>(null);
  const seekOverride = usePlayerStore((state) => state.pendingSeekJobSeconds);
  const setSeekOverride = usePlayerStore((state) => state.requestSeek);

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
  const manifestRef = useRef<JobManifest | null>(null);
  const previousSocketStatusRef = useRef(websocketStatus);

  const isJobTerminal = isTerminalStatus(job?.status);
  useAppBootstrap(!loading && !!job && !isJobTerminal);

  // ── Header title ────────────────────────────────────────
  // The app header lives in the shell, a sibling of this page, so the job title
  // travels through a tiny external store rather than a prop. It is published
  // here (the only place that loaded the job) and cleared on unmount; keeping
  // the clear in its own effect avoids the null flash a cleanup+set pair would
  // produce every time the title itself changes.
  useEffect(() => {
    setReaderTitle(job?.title ?? null);
  }, [job?.title]);

  useEffect(() => () => setReaderTitle(null), []);

  // Device-local reader preferences (jump controls, conveyor, motion).
  const settings = useReaderSettings();
  const motion = useReaderMotion();

  // ── Derived data ────────────────────────────────────────
  const knownChunks = useMemo(
    () => mergeKnownChunks(job, manifest),
    [job, manifest],
  );
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
  }, [knownChunks, playbackAnchorIndex, setPlaybackAnchorIndex]);

  const activeChunks = useMemo(
    () => deriveActiveChunks(knownChunks, activeVersions),
    [knownChunks, activeVersions],
  );

  const playbackModel = useMemo(
    () =>
      derivePlaybackModel(
        knownChunks,
        activeChunks,
        activeVersions,
        playbackAnchorIndex,
      ),
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

  // Hand the document to the app-level player. `openJob` keeps an existing
  // stream for the same job, so a remount (or a WS patch) never interrupts
  // playback; `setSource` only updates the stream inputs.
  useEffect(() => {
    if (!job) return;
    usePlayerStore.getState().openJob({
      id: job.id,
      title: job.title,
      isTerminal: isJobTerminal,
      audioEpoch: job.audio_epoch,
      folderId: job.folder_id ?? null,
      nextJobId: job.next_job_id ?? null,
      previousJobId: job.previous_job_id ?? null,
    });
  }, [job, isJobTerminal]);

  useEffect(() => {
    usePlayerStore.getState().setSource({
      manifest: streamManifest,
      anchorIndex: playbackAnchorIndex,
      anchorOffsetSeconds: anchorOffset,
      durationSeconds: knownDurationSeconds,
    });
  }, [streamManifest, playbackAnchorIndex, anchorOffset, knownDurationSeconds]);

  const canDownloadRenderedAudio = downloadableChunks.length > 0;
  const isDownloadComplete =
    !!job &&
    isJobTerminal &&
    downloadableChunks.length > 0 &&
    downloadableChunks.length === knownChunks.length;

  // Player outputs are owned by the app-level provider; the reader is a
  // consumer. Select them shallowly so a playback tick only re-renders this
  // page, not unrelated routes.
  const {
    appendedChunksCount,
    bufferedUntilSeconds,
    currentTimeSeconds,
    diagnostics,
    isActuallyPlaying,
    isAutoplayBlocked,
    isLoadingAudio,
    isStreamPrimed,
    isWaitingForData,
    lastPlayerError,
    playbackRate,
    playerState,
    renderedDurationSeconds,
  } = usePlayerStore(
    useShallow((state) => ({
      appendedChunksCount: state.appendedChunksCount,
      bufferedUntilSeconds: state.bufferedUntilSeconds,
      currentTimeSeconds: state.currentTimeSeconds,
      diagnostics: state.diagnostics,
      isActuallyPlaying: state.isActuallyPlaying,
      isAutoplayBlocked: state.isAutoplayBlocked,
      isLoadingAudio: state.isLoadingAudio,
      isStreamPrimed: state.isStreamPrimed,
      isWaitingForData: state.isWaitingForData,
      lastPlayerError: state.lastPlayerError,
      playbackRate: state.playbackRate,
      playerState: state.playerState,
      renderedDurationSeconds: state.renderedDurationSeconds,
    })),
  );
  const setPlaybackRate = usePlayerStore((state) => state.setPlaybackRate);

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

  /**
   * Chunk *states* only change when the playhead crosses a chunk boundary; the
   * per-chunk fill inside `activeProgress` changes on every playback tick.
   *
   * Everything downstream that only needs states — the timeline slots and the
   * reader text — is keyed on this signature instead of the progress object, so
   * the 20Hz playback tick does not reconcile every chunk block and every
   * timeline slot in the document. That reconciliation was measured at ~22ms per
   * tick on a 300-chunk document (reader drops to ~26fps), and it is the same
   * kind of work even for a small document whose chunks are long.
   */
  const chunkStateSignature = `${activeProgress.activeChunkIndex ?? "none"}:${activeProgress.playedIndexes.size}`;
  // Identity follows chunkStateSignature: the set is the run's prefix, so
  // (active index, size) determines it exactly.
  // biome-ignore lint/correctness/useExhaustiveDependencies: see comment above.
  const playedIndexes = useMemo(
    () => activeProgress.playedIndexes,
    [chunkStateSignature],
  );

  // Static waveform peaks for the playbar, fetched from the backend per chunk.
  // Updates automatically as chunks arrive or are reprocessed.
  const waveforms = useChunkWaveforms(activeChunks);

  // ── Timeline slots (for WaveformTimeline) ───────────────
  // States only, keyed on the signature rather than the per-tick progress.
  // biome-ignore lint/correctness/useExhaustiveDependencies: see chunkStateSignature.
  const timelineSlots = useMemo<TimelineSlotData[]>(
    () =>
      deriveTimelineSlots(
        activeChunks,
        playbackModel,
        activeProgress,
        playbackAnchorIndex,
      ),
    [activeChunks, playbackModel, playbackAnchorIndex, chunkStateSignature],
  );

  const detailSlot = useMemo(() => {
    const targetIndex = activeProgress.activeChunkIndex;
    if (targetIndex === null) return null;
    return activeChunks.find((c) => c.index === targetIndex) ?? null;
  }, [activeProgress.activeChunkIndex, activeChunks]);

  const shouldUsePollingFallback =
    !!job &&
    !isTerminalStatus(job.status) &&
    (websocketStatus !== "open" || isSocketStale);

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
            loadError instanceof Error
              ? loadError.message
              : "Unable to refresh reader state",
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

  /**
   * Apply a job patch from a WebSocket event or a mutation response, keeping the
   * loaded detail intact. Per-chunk events carry one chunk (`payload.chunk`);
   * `job_updated` and the voice/reprocess endpoints still carry full detail.
   */
  const applyJobPatch = useCallback(
    (
      patch: StreamEventPayload["job"],
      chunk?: Chunk,
      meta: StreamEventMeta = {},
    ) => {
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
    if (
      websocketStatus !== "open" ||
      previous === "open" ||
      previous === "connecting"
    ) {
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

  // ── Handlers ─────────────────────────────────────────────

  const handlePlay = async () => {
    if (!job) return;
    if (isJobTerminal) {
      setPlayIntent(true);
      setError(null);
      await playerRequestGesture();
      return;
    }
    setPlayIntent(true);
    setError(null);
    try {
      const nextJob = await api.activateJob(job.id);
      applyJobPatch(nextJob);
      await playerRequestGesture();
    } catch (playError) {
      setPlayIntent(false);
      setError(
        playError instanceof Error
          ? playError.message
          : "Unable to activate playback",
      );
    }
  };

  const handlePause = async () => {
    if (!job) return;
    setPlayIntent(false);
    playerPause();
    if (isJobTerminal) return;
    try {
      const nextJob = await api.pauseJob(job.id);
      applyJobPatch(nextJob);
    } catch (pauseError) {
      setError(
        pauseError instanceof Error
          ? pauseError.message
          : "Unable to pause playback",
      );
    }
  };

  const handleTogglePlay = () => {
    if (isActuallyPlaying || playIntent) void handlePause();
    else void handlePlay();
  };

  const handleSeekToChunk = useCallback(
    async (chunkIndex: number, seekSeconds: number) => {
      if (!job) return;
      // Seeking preserves the current play state: a playing player stays playing
      // (resuming once the new stream is ready), a paused player stays paused at
      // the new position. Only an actively-playing player needs the job
      // re-activated for backend scheduling.
      const resumeAfterSeek = playIntent;
      const isSameAnchor = chunkIndex === playbackAnchorIndex;
      const streamTargetSeconds = Math.max(0, seekSeconds - anchorOffset);
      setPlaybackAnchorIndex(chunkIndex);
      setSeekOverride(seekSeconds);
      setError(null);
      // Moving the anchor reopens the stream by itself. Staying on the anchor
      // and aiming at audio that has been evicted (or not fetched yet) does not,
      // so ask the player for a rebuild explicitly — otherwise MSE in sequence
      // mode would silently clamp the seek to the retained audio.
      if (isSameAnchor && !playerIsSecondsLoaded(streamTargetSeconds)) {
        restartStream();
      }
      if (isJobTerminal) {
        if (resumeAfterSeek) await playerRequestGesture();
        return;
      }
      if (!resumeAfterSeek) return;
      try {
        const nextJob = await api.activateJob(job.id);
        applyJobPatch(nextJob);
        await playerRequestGesture();
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
    [
      anchorOffset,
      applyJobPatch,
      isJobTerminal,
      job,
      playIntent,
      playbackAnchorIndex,
      restartStream,
      setPlaybackAnchorIndex,
      setPlayIntent,
      setSeekOverride,
    ],
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
   * Relative seek for the −10s / +10s buttons, the arrow keys and J/L.
   *
   * While the target is buffered this is an instant in-stream seek. The player
   * only retains a bounded window of audio (MSE cannot hold a whole book), so a
   * target behind the retained audio — or in a stream that has not primed yet —
   * has to go through the anchor path, which reopens the stream at the chunk
   * containing the target.
   */
  const handleSkip = (deltaSeconds: number) => {
    if (renderedDurationSeconds <= 0) return;
    const targetStreamSeconds = skipTargetSeconds(
      currentTimeSeconds,
      deltaSeconds,
      renderedDurationSeconds,
    );
    if (playerSeekWithinBuffered(targetStreamSeconds) !== null) return;
    if (
      isStreamPrimed &&
      !playerIsSecondsBehindRetainedAudio(targetStreamSeconds)
    ) {
      // Ahead of the buffered end: clamp into what is loaded and let the
      // appending window catch up (the player enters its waiting state).
      playerSeekToSeconds(targetStreamSeconds);
      return;
    }
    const timelineTarget = targetStreamSeconds + anchorOffset;
    // Position math runs over the whole timeline (including any gap chunks), so
    // the resolved anchor matches what the timeline itself would seek to.
    void handleSeekToChunk(
      chunkIndexAtSeconds(activeChunks, timelineTarget),
      timelineTarget,
    );
  };

  // Page-wide playback keys: the reader should not require clicking the
  // controls first. Handlers are read from a ref inside the hook, so this does
  // not resubscribe on every playback tick.
  usePlaybackShortcuts({ togglePlay: handleTogglePlay, skipBy: handleSkip });

  /**
   * Jump to a chunk from its block in the reader text. Stable identity matters:
   * `ReaderChunkBlock` is memoized, so an unstable callback would re-render
   * every block in a book on every playback tick.
   */
  const handleJumpToChunk = useCallback(
    (chunkIndex: number) => {
      void handleSeekToChunkWithScroll(
        chunkIndex,
        chunkStartSeconds(activeChunks, chunkIndex),
      );
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
        retryError instanceof Error
          ? retryError.message
          : "Unable to retry rendering",
      );
    } finally {
      setIsRetryingStall(false);
    }
  }, [applyJobPatch, job, refreshReaderState]);

  const handleSettingsChange = useCallback(
    (patch: Partial<typeof settings>) => {
      setReaderSettings(patch);
    },
    [],
  );

  /**
   * Speed is applied to the player immediately and remembered for the next
   * session. The player owns the live rate (it re-applies it every tick on
   * Firefox MSE); the stored preference is what a reader starts from.
   */
  const handlePlaybackRateChange = useCallback(
    (rate: number) => {
      setPlaybackRate(rate);
      setReaderSettings({ playbackRate: rate });
    },
    [setPlaybackRate],
  );

  // Adopt the remembered speed on open, and follow it back after a settings
  // reset (which is the only other thing that can change it while mounted).
  useEffect(() => {
    setPlaybackRate(settings.playbackRate);
  }, [setPlaybackRate, settings.playbackRate]);

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

  /** Manual "render the rest of this job now" — ignores a configured lookahead cap.
   *  It never un-pauses a paused job: pause stays the only intentional stop. */
  const handleRenderToEnd = useCallback(async () => {
    if (!job) return;
    setIsRenderingToEnd(true);
    try {
      const nextJob = await api.renderJobToEnd(job.id, true);
      applyJobPatch(nextJob);
      setError(null);
    } catch (renderError) {
      setError(
        renderError instanceof Error
          ? renderError.message
          : "Unable to render the rest of the job",
      );
    } finally {
      setIsRenderingToEnd(false);
    }
  }, [applyJobPatch, job]);

  const handleVoiceChange = async (
    voiceId: string,
    rerenderWritten = false,
  ) => {
    if (!job) return;
    try {
      const nextJob = await api.updateJobVoice(
        job.id,
        voiceId,
        rerenderWritten,
      );
      if (rerenderWritten) {
        // Every chunk was invalidated so the old take is gone. Reset the local
        // playback state to match: the bumped audio epoch tears the MSE stream
        // down, and these are the reader-side equivalents (no autoplay into an
        // empty stream, playhead back at the start).
        setPlayIntent(false);
        playerPause();
        setSeekOverride(null);
        setPlaybackAnchorIndex(0);
      }
      applyJobPatch(nextJob);
      setError(null);
    } catch (voiceError) {
      setError(
        voiceError instanceof Error
          ? voiceError.message
          : "Unable to change voice",
      );
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
        setReprocessError(
          err instanceof Error ? err.message : "Reprocessing failed",
        );
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
        setReprocessError(
          err instanceof Error ? err.message : "Version switch failed",
        );
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
    if (editingChunkIndex !== null)
      void handleReprocess(editingChunkIndex, editText);
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

  // ── Scroll-linked playbar compaction — must be before early returns ──
  // The progress value is written as the `--scroll-progress` custom property on
  // the sticky wrapper below, NOT held in state: it changes on every scroll
  // frame, and re-rendering (and re-laying-out) the page per frame is what made
  // the bar stutter and flicker mid-shrink on a phone.
  //
  // It is mirrored onto `<html>` so the app header — outside this subtree — can
  // fade the job title in on the same continuous value.
  const attachScrollProgress = useScrollProgressVar({ alsoWriteRoot: true });

  // ── Reader text layout — must be before early returns ─────
  // Slicing the document is memoized so playback ticks (which re-render the
  // reader ~20x/s) never re-slice a book-sized source text.
  const textSegments = useMemo(
    () => buildReaderTextSegments(activeChunks, job?.source_text ?? ""),
    [activeChunks, job?.source_text],
  );

  // ── Loader / error / main content ──────────────────────
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
        playedIndexes={playedIndexes}
        segments={textSegments}
        showJumpButtons={settings.showChunkJumpButtons}
      />
    );

    content = (
      <>
        {/* Sticky playbar wrapper — flush against the app header. Owns the
          `--scroll-progress` value every collapsing part below interpolates on. */}
        <div
          className="sticky top-[56px] z-30 w-full"
          ref={attachScrollProgress}
        >
          {/* Background layer — a static surface whose opacity follows scroll.
            Deliberately no CSS transition and no backdrop blur: the value is
            already continuous, a transition would just lag behind and restart
            every frame, and animating `backdrop-filter` forces the phone GPU to
            re-blur a full-width layer on every scroll frame (the flicker). */}
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-0"
            style={{
              background: "var(--surface)",
              opacity: "calc(var(--scroll-progress, 0) * 0.95)",
              borderBottom: "1px solid var(--line)",
              boxShadow: "0 1px 3px rgba(0,0,0,0.3)",
            }}
          />
          {/* Content — padding shrinks progressively */}
          <div
            className="relative z-10 mx-auto w-full"
            style={{
              padding:
                "calc(20px - var(--scroll-progress, 0) * 12px) calc(16px - var(--scroll-progress, 0) * 4px)",
            }}
          >
            <Playbar
              canDownload={canDownloadRenderedAudio}
              displayDurationSeconds={displayDurationSeconds}
              displayRenderedDurationSeconds={displayRenderedDurationSeconds}
              displayTimeSeconds={displayTimeSeconds}
              isAutoplayBlocked={isAutoplayBlocked}
              isDownloadComplete={isDownloadComplete}
              isDownloading={isDownloading}
              isJobTerminal={isJobTerminal}
              isLoadingAudio={isLoadingAudio}
              isPlaying={isActuallyPlaying}
              isWaitingForData={isWaitingForData}
              playIntent={playIntent}
              onDownload={handleDownload}
              onPause={handlePause}
              onPlay={handlePlay}
              onSeekToChunk={handleSeekToChunkWithScroll}
              onSkip={handleSkip}
              renderedDurationSeconds={renderedDurationSeconds}
              renderAheadSlot={
                <RenderToEndButton
                  enabled={job?.render_to_end === true}
                  isPending={isRenderingToEnd}
                  isTerminal={isJobTerminal}
                  onRenderToEnd={handleRenderToEnd}
                />
              }
              showTransport={!isPhoneViewport}
              playbackRate={playbackRate}
              settingsSlot={
                <ReaderSettingsMenu
                  isOverlay={!isLargeScreen}
                  onChange={handleSettingsChange}
                  onPlaybackRateChange={handlePlaybackRateChange}
                  onReset={resetReaderSettings}
                  playbackRate={playbackRate}
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
                  isPlaying={isActuallyPlaying}
                  maxSeekSeconds={displayRenderedDurationSeconds}
                  motion={motion}
                  onSeek={handleSeekToChunkWithScroll}
                  playbackRate={playbackRate}
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
                (!isJobTerminal &&
                  (websocketStatus !== "open" || isSocketStale)) ||
                error ||
                lastPlayerError ||
                downloadError
                  ? "visible border-[var(--amber)]/20 bg-[var(--amber)]/10 text-[var(--amber)] opacity-100"
                  : "invisible opacity-0"
              }`}
            >
              <div className="flex flex-wrap gap-x-4 gap-y-1">
                {!isJobTerminal &&
                (websocketStatus !== "open" || isSocketStale) ? (
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
              Waiting for the GPU: currently rendering{" "}
              {modelLabel(residentModelId)}
              {residentVoiceLabel ? ` · ${residentVoiceLabel}` : ""}. This job
              starts when that model rotates (about{" "}
              {runtimeStatus?.model_residency_batches ?? 10} batches) or its
              queue finishes.
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
                  isPhoneViewport && settings.showConveyor
                    ? "bottom-[10rem]"
                    : undefined
                }
              />
            </div>
          )}
        </div>

        {/* Phone bottom dock — transport plus the conveyor, in the thumb zone. */}
        {isPhoneViewport && settings.showConveyor ? (
          <ReaderDock
            isAutoplayBlocked={isAutoplayBlocked}
            isLoadingAudio={isLoadingAudio}
            isPlaying={isActuallyPlaying}
            isWaitingForData={isWaitingForData}
            maxSeekSeconds={displayRenderedDurationSeconds}
            motion={motion}
            onPause={handlePause}
            onPlay={handlePlay}
            onSeek={handleSeekToChunkWithScroll}
            onSkip={handleSkip}
            playbackRate={playbackRate}
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

  return <div className="flex flex-col">{content}</div>;
}
