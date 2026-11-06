import {
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
} from "react";
import { ShadowAudio } from "../components/ShadowAudio";
import { api } from "../lib/api";
import { liveClient } from "../lib/live-client";
import { useMediaSourcePlayer } from "../lib/media-source";
import { getReaderSettings } from "../state/reader-settings";
import { resolveAutoAdvance } from "./auto-advance";
import { collectHeardChunkIndexes } from "./heard";
import {
  getPlayerControls,
  playerNavigate,
  registerPlayerControls,
  usePlayerStore,
} from "./player-store";

const PLAYBACK_SYNC_INTERVAL_MS = 3_000;
/** How close to the end of the buffered stream counts as "finished". */
const GAP_BUFFERING_EPSILON_SECONDS = 0.5;

/**
 * Owns the single `<audio>` element and the media stream for the whole app.
 *
 * It lives above the router on purpose: navigating to the library (or to
 * admin) must not stop a book, and auto-advance in M5 swaps jobs without
 * tearing the element down. ReaderPage writes the stream/anchor inputs into the
 * player store; this component feeds them to `useMediaSourcePlayer` and mirrors
 * the hook's state back for every consumer (reader, mini-player).
 */
export function PlayerProvider({ children }: { children: ReactNode }) {
  const job = usePlayerStore((state) => state.job);
  const manifest = usePlayerStore((state) => state.manifest);
  const anchorIndex = usePlayerStore((state) => state.anchorIndex);
  const anchorOffsetSeconds = usePlayerStore(
    (state) => state.anchorOffsetSeconds,
  );
  const streamRestartKey = usePlayerStore((state) => state.streamRestartKey);
  const pendingSeekJobSeconds = usePlayerStore(
    (state) => state.pendingSeekJobSeconds,
  );
  const playIntent = usePlayerStore((state) => state.playIntent);

  const player = useMediaSourcePlayer({
    jobId: job?.id ?? "",
    manifest,
    playbackAnchorIndex: anchorIndex,
    playIntent,
    isTerminal: job?.isTerminal ?? false,
    pendingSeekSeconds:
      pendingSeekJobSeconds === null
        ? null
        : Math.max(0, pendingSeekJobSeconds - anchorOffsetSeconds),
    onSeekApplied: () => usePlayerStore.getState().seekApplied(),
    streamRestartKey,
  });

  const {
    audioRef,
    appendedChunksCount,
    bufferedUntilSeconds,
    currentTimeSeconds,
    diagnostics,
    isActuallyPlaying,
    isAutoplayBlocked,
    isLoadingAudio,
    isReady,
    isSecondsBehindRetainedAudio,
    isSecondsLoaded,
    isStreamPrimed,
    isWaitingForData,
    lastPlayerError,
    pausePlayback,
    playerState,
    playbackRate,
    renderedDurationSeconds,
    requestUserGesturePlay,
    seekToSeconds,
    seekWithinBuffered,
    setPlaybackRate,
  } = player;

  // Commands are imperative and must stay out of the render path: the reader
  // calls them from event handlers, not while rendering.
  useLayoutEffect(() => {
    registerPlayerControls({
      seekToSeconds,
      seekWithinBuffered,
      isSecondsLoaded,
      isSecondsBehindRetainedAudio,
      setPlaybackRate,
      pausePlayback,
      requestUserGesturePlay,
    });
    return () => registerPlayerControls(null);
  }, [
    isSecondsBehindRetainedAudio,
    isSecondsLoaded,
    pausePlayback,
    requestUserGesturePlay,
    seekToSeconds,
    seekWithinBuffered,
    setPlaybackRate,
  ]);

  // Mirror the hook into the store once per commit. Selectors keep subscribers
  // from re-rendering when their slice did not change.
  useLayoutEffect(() => {
    usePlayerStore.getState().syncOutputs({
      appendedChunksCount,
      bufferedUntilSeconds,
      currentTimeSeconds,
      diagnostics,
      isActuallyPlaying,
      isAutoplayBlocked,
      isLoadingAudio,
      isReady,
      isStreamPrimed,
      isWaitingForData,
      lastPlayerError,
      playerState,
      playbackRate,
      renderedDurationSeconds,
    });
  });

  // Event handlers run outside React's render cycle and must not close over a
  // stale tick. Assigning the latest values during render is safe here: the ref
  // is only read from DOM event handlers.
  const latestRef = useRef({
    renderedDurationSeconds,
    isJobTerminal: job?.isTerminal ?? false,
  });
  latestRef.current = {
    renderedDurationSeconds,
    isJobTerminal: job?.isTerminal ?? false,
  };

  const lastSyncAtRef = useRef(0);
  const lastHttpSyncAtRef = useRef(0);
  // Chunk indexes played past 90% since the last report. Additive on the
  // server, so a dropped report can never lose listening history.
  const pendingHeardRef = useRef<Set<number>>(new Set());

  // A chunk becomes heard only through real playback. The mirrored store lags
  // the element by a commit, so this is evaluated from the values that just
  // rendered (each playback tick), and never while a seek is pending.
  useEffect(() => {
    const state = usePlayerStore.getState();
    if (!state.manifest || !state.isActuallyPlaying) return;
    if (state.isWaitingForData || state.pendingSeekJobSeconds !== null) return;
    collectHeardChunkIndexes(
      state.manifest.chunks,
      state.currentTimeSeconds + state.anchorOffsetSeconds,
      pendingHeardRef.current,
    );
  }, [
    anchorOffsetSeconds,
    currentTimeSeconds,
    isActuallyPlaying,
    isWaitingForData,
    manifest,
  ]);

  const syncPlayback = useCallback(
    (force = false, playingOverride?: boolean) => {
      const state = usePlayerStore.getState();
      const current = state.job;
      if (!current) return;
      const now = Date.now();
      const heard = [...pendingHeardRef.current];
      const httpDue =
        force ||
        heard.length > 0 ||
        now - lastHttpSyncAtRef.current >= PLAYBACK_SYNC_INTERVAL_MS;
      if (!force && now - lastSyncAtRef.current < PLAYBACK_SYNC_INTERVAL_MS) {
        return;
      }
      lastSyncAtRef.current = now;
      const position =
        state.pendingSeekJobSeconds ??
        state.currentTimeSeconds + state.anchorOffsetSeconds;
      const isPlaying =
        playingOverride ??
        (state.playIntent &&
          (state.isActuallyPlaying || state.isWaitingForData));
      // The socket ping is a latency hint for the scheduler; it is meaningless
      // for a completed job (local-only). Listening progress still goes over
      // HTTP because it carries the heard chunks.
      if (!current.isTerminal) {
        liveClient.sendPlaybackSync(current.id, position, isPlaying);
      }
      if (!httpDue) return;
      lastHttpSyncAtRef.current = now;
      void api
        .updateProgress(current.id, position, isPlaying, heard)
        .then(() => {
          for (const index of heard) pendingHeardRef.current.delete(index);
          state.setLastSyncError(null);
        })
        .catch((syncError: unknown) => {
          state.setLastSyncError(
            syncError instanceof Error
              ? syncError.message
              : "Unable to sync playback position",
          );
        });
    },
    [],
  );

  // A seek is a deliberate position change, so report it as soon as the player
  // applies it instead of waiting for the next interval.
  const previousPendingSeekRef = useRef(pendingSeekJobSeconds);
  useEffect(() => {
    if (
      previousPendingSeekRef.current !== null &&
      pendingSeekJobSeconds === null
    ) {
      syncPlayback(true);
    }
    previousPendingSeekRef.current = pendingSeekJobSeconds;
  }, [pendingSeekJobSeconds, syncPlayback]);

  // Persist progress when the tab goes away. Pausing/seek events already
  // flush; this covers a closed tab or a phone switching apps.
  useEffect(() => {
    const flush = () => syncPlayback(true);
    const onVisibility = () => {
      if (document.visibilityState === "hidden") flush();
    };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", flush);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", flush);
    };
  }, [syncPlayback]);

  // Auto-advance is a property of the end of a job, not of the reader page:
  // the provider already owns end detection, and navigating updates the reader
  // route while this provider (and the audio element) stays mounted.
  const autoAdvancedForRef = useRef<string | null>(null);
  useEffect(() => {
    autoAdvancedForRef.current = null;
  }, [job?.id]);
  const maybeAutoAdvance = useCallback(() => {
    const state = usePlayerStore.getState();
    const nextJobId = resolveAutoAdvance({
      job: state.job,
      currentTimeSeconds: state.currentTimeSeconds,
      renderedDurationSeconds: state.renderedDurationSeconds,
      continuousPlay: getReaderSettings().continuousPlay,
    });
    if (!nextJobId || autoAdvancedForRef.current === state.job?.id) return;
    autoAdvancedForRef.current = state.job?.id ?? null;
    playerNavigate(`/jobs/${nextJobId}?play=1`);
  }, []);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    const handlePlay = () => {
      const state = usePlayerStore.getState();
      if (state.job?.isTerminal) state.setPlayIntent(true);
      syncPlayback(true, true);
    };
    const handlePause = () => {
      const state = usePlayerStore.getState();
      if (state.job?.isTerminal) {
        state.setPlayIntent(false);
        syncPlayback(true, false);
        return;
      }
      if (!state.playIntent) syncPlayback(true, false);
    };
    const handleWaiting = () =>
      syncPlayback(true, usePlayerStore.getState().playIntent);
    const handleEnded = () => {
      const state = usePlayerStore.getState();
      const rendered = latestRef.current.renderedDurationSeconds;
      // `audio.currentTime` is the authoritative position here: the mirrored
      // store state may still be one tick behind when the browser fires the
      // event. Not being at the end means a gap: keep intent so the player can
      // enter its waiting state instead of stopping the session.
      if (!state.job) return;
      // The stream is not loaded yet, so "ended" says nothing about the job;
      // the hook's own waiting/priming state will cover it.
      if (rendered <= 0) return;
      if (
        !state.job.isTerminal &&
        audio.currentTime >=
          Math.max(0, rendered - GAP_BUFFERING_EPSILON_SECONDS)
      ) {
        syncPlayback(true, true);
        return;
      }
      state.setPlayIntent(false);
      syncPlayback(true, false);
      if (state.job?.isTerminal) maybeAutoAdvance();
    };
    const handleError = () => syncPlayback(true, false);
    audio.addEventListener("play", handlePlay);
    audio.addEventListener("pause", handlePause);
    audio.addEventListener("waiting", handleWaiting);
    audio.addEventListener("ended", handleEnded);
    audio.addEventListener("error", handleError);
    const interval = window.setInterval(() => {
      const state = usePlayerStore.getState();
      if (state.playIntent || state.isWaitingForData) syncPlayback();
    }, PLAYBACK_SYNC_INTERVAL_MS);
    return () => {
      audio.removeEventListener("play", handlePlay);
      audio.removeEventListener("pause", handlePause);
      audio.removeEventListener("waiting", handleWaiting);
      audio.removeEventListener("ended", handleEnded);
      audio.removeEventListener("error", handleError);
      window.clearInterval(interval);
    };
  }, [audioRef, maybeAutoAdvance, syncPlayback]);

  // A terminal job whose playhead sits at the end of a fully buffered stream
  // has finished, even when the browser never fires `ended` (MSE often does
  // not). Clearing intent here is what un-sticks the play button and the
  // spinner; this used to live in ReaderPage.
  useEffect(() => {
    if (
      !job?.isTerminal ||
      !playIntent ||
      isActuallyPlaying ||
      renderedDurationSeconds <= 0 ||
      currentTimeSeconds <
        Math.max(0, renderedDurationSeconds - GAP_BUFFERING_EPSILON_SECONDS)
    ) {
      return;
    }
    usePlayerStore.getState().setPlayIntent(false);
    maybeAutoAdvance();
  }, [
    currentTimeSeconds,
    isActuallyPlaying,
    job?.isTerminal,
    maybeAutoAdvance,
    playIntent,
    renderedDurationSeconds,
  ]);

  // Kept reachable for debugging from the console, like the old reader-owned
  // hook was. It is also the only way tests can wait for a registered control.
  useEffect(() => {
    (window as { __readflowPlayer?: unknown }).__readflowPlayer = player;
  });

  return (
    <>
      <ShadowAudio audioRef={audioRef} />
      {children}
    </>
  );
}

/** True once the provider has registered its controls (i.e. a stream can be driven). */
export function hasPlayerControls(): boolean {
  return getPlayerControls() !== null;
}
