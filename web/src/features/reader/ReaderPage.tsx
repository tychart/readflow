import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "react-router-dom";

import { api } from "../../lib/api";
import { useMediaSourcePlayer } from "../../lib/media-source";
import { useAppStore } from "../../state/store";
import type { JobDetail, JobManifest, JobStatus } from "../../types/api";

const TERMINAL_JOB_STATUSES: JobStatus[] = ["completed", "failed"];
const READER_POLL_INTERVAL_MS = 1_000;
const PLAYBACK_SYNC_INTERVAL_MS = 1_000;

function formatRelativeTime(timestamp: number | null) {
  if (!timestamp) {
    return "never";
  }
  const deltaSeconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  return deltaSeconds === 0 ? "just now" : `${deltaSeconds}s ago`;
}

function isTerminalStatus(status: JobStatus | undefined) {
  return status ? TERMINAL_JOB_STATUSES.includes(status) : false;
}

export function ReaderPage() {
  const { jobId = "" } = useParams();
  const voices = useAppStore((state) => state.voices);
  const lastEvent = useAppStore((state) => state.lastEvent);
  const websocketStatus = useAppStore((state) => state.websocketStatus);
  const lastSocketMessageAt = useAppStore((state) => state.lastSocketMessageAt);
  const lastSocketError = useAppStore((state) => state.lastSocketError);
  const isSocketStale = useAppStore((state) => state.isSocketStale);

  const [job, setJob] = useState<JobDetail | null>(null);
  const [manifest, setManifest] = useState<JobManifest | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [playIntent, setPlayIntent] = useState(false);
  const [lastRefreshAt, setLastRefreshAt] = useState<number | null>(null);
  const [lastRefreshReason, setLastRefreshReason] = useState<string>("initial");
  const [lastPlaybackSyncError, setLastPlaybackSyncError] = useState<string | null>(null);

  const refreshRequestIdRef = useRef(0);
  const lastAppliedRequestIdRef = useRef(0);
  const refreshInFlightRef = useRef<Promise<void> | null>(null);
  const queuedRefreshReasonRef = useRef<string | null>(null);
  const lastPlaybackSyncAtRef = useRef(0);

  const isJobTerminal = isTerminalStatus(job?.status);
  const {
    audioRef,
    appendedChunksCount,
    bufferedUntilSeconds,
    currentTimeSeconds,
    isActuallyPlaying,
    isReady,
    isWaitingForData,
    lastPlayerError,
  } = useMediaSourcePlayer({
    jobId,
    manifest,
    playIntent,
    isTerminal: isJobTerminal,
  });

  const totalDuration = useMemo(
    () =>
      manifest?.chunks.reduce(
        (sum, chunk) => Math.max(sum, chunk.start_seconds + chunk.duration_seconds),
        0,
      ) ?? 0,
    [manifest],
  );
  const playedPercent =
    totalDuration > 0 ? (currentTimeSeconds / totalDuration) * 100 : 0;
  const bufferedPercent =
    totalDuration > 0 ? (bufferedUntilSeconds / totalDuration) * 100 : 0;
  const writtenChunkCount = job?.chunks.filter((chunk) => chunk.status === "written").length ?? 0;

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
      if (!job || !audioRef.current) {
        return;
      }
      const now = Date.now();
      if (!force && now - lastPlaybackSyncAtRef.current < PLAYBACK_SYNC_INTERVAL_MS) {
        return;
      }
      lastPlaybackSyncAtRef.current = now;
      const isPlaying =
        isPlayingOverride ?? (playIntent && (!audioRef.current.paused || isWaitingForData));
      void api
        .updatePlayback(job.id, audioRef.current.currentTime ?? 0, isPlaying)
        .then(() => setLastPlaybackSyncError(null))
        .catch((syncError) => {
          setLastPlaybackSyncError(
            syncError instanceof Error
              ? `Playback sync failed: ${syncError.message}`
              : "Playback sync failed",
          );
        });
    },
    [audioRef, isWaitingForData, job, playIntent],
  );

  useEffect(() => {
    void refreshReaderState("initial", true);
  }, [refreshReaderState]);

  useEffect(() => {
    const eventJob = lastEvent?.payload.job as JobDetail | undefined;
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
    void refreshReaderState(`ws:${lastEvent.type}`);
  }, [jobId, lastEvent, refreshReaderState]);

  useEffect(() => {
    if (!job || isTerminalStatus(job.status)) {
      return;
    }
    const timer = window.setInterval(() => {
      void refreshReaderState("poll");
    }, READER_POLL_INTERVAL_MS);
    return () => {
      window.clearInterval(timer);
    };
  }, [job, refreshReaderState]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !job) {
      return;
    }

    const handlePlay = () => syncPlaybackState(true, true);
    const handlePause = () => syncPlaybackState(true, false);
    const handleSeek = () => syncPlaybackState(true);
    const handleWaiting = () => syncPlaybackState(true, playIntent);
    const handleEnded = () => {
      setPlayIntent(false);
      syncPlaybackState(true, false);
    };
    const handleError = () => syncPlaybackState(true, false);

    audio.addEventListener("play", handlePlay);
    audio.addEventListener("pause", handlePause);
    audio.addEventListener("seeking", handleSeek);
    audio.addEventListener("seeked", handleSeek);
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
      audio.removeEventListener("seeking", handleSeek);
      audio.removeEventListener("seeked", handleSeek);
      audio.removeEventListener("waiting", handleWaiting);
      audio.removeEventListener("ended", handleEnded);
      audio.removeEventListener("error", handleError);
      window.clearInterval(interval);
    };
  }, [audioRef, isWaitingForData, job, playIntent, syncPlaybackState]);

  const handlePlay = async () => {
    if (!job) {
      return;
    }
    setPlayIntent(true);
    try {
      const nextJob = await api.activateJob(job.id);
      setJob(nextJob);
      if (audioRef.current) {
        void audioRef.current.play().catch((playError: unknown) => {
          if (!isReady && !totalDuration) {
            return;
          }
          setError(
            playError instanceof Error
              ? `Unable to start playback: ${playError.message}`
              : "Unable to start playback",
          );
        });
      }
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
    audioRef.current?.pause();
    try {
      const nextJob = await api.pauseJob(job.id);
      setJob(nextJob);
      syncPlaybackState(true, false);
    } catch (pauseError) {
      setError(
        pauseError instanceof Error ? pauseError.message : "Unable to pause playback",
      );
    }
  };

  const handleVoiceChange = async (voiceId: string) => {
    if (!job) {
      return;
    }
    try {
      const nextJob = await api.updateJobVoice(job.id, voiceId);
      setJob(nextJob);
      setError(null);
    } catch (voiceError) {
      setError(
        voiceError instanceof Error ? voiceError.message : "Unable to change voice",
      );
    }
  };

  if (loading) {
    return <div className="panel rounded-[2rem] p-8">Loading reader…</div>;
  }

  if (!job) {
    return <div className="panel rounded-[2rem] p-8 text-rose-700">{error ?? "Job not found"}</div>;
  }

  return (
    <div className="grid gap-6 xl:grid-cols-[1.3fr_0.9fr]">
      <div className="space-y-6">
        {(websocketStatus !== "open" || isSocketStale || isWaitingForData || error || lastPlayerError) ? (
          <div className="panel rounded-[2rem] border border-amber-200 bg-amber-50/80 p-5 text-sm text-amber-950">
            <div className="mb-2 font-semibold uppercase tracking-[0.2em]">Reader warnings</div>
            <div className="space-y-2">
              {websocketStatus !== "open" || isSocketStale ? (
                <div>
                  Live socket is {isSocketStale ? "stale" : websocketStatus}. Polling fallback is active.
                </div>
              ) : null}
              {isWaitingForData && !isJobTerminal ? (
                <div>Playback is waiting for the next chunk to finish buffering.</div>
              ) : null}
              {lastPlayerError ? <div>{lastPlayerError}</div> : null}
              {lastPlaybackSyncError ? <div>{lastPlaybackSyncError}</div> : null}
              {lastSocketError ? <div>{lastSocketError}</div> : null}
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
          <audio className="mb-4 w-full" controls ref={audioRef} />
          <div className="mb-4 h-4 overflow-hidden rounded-full bg-stone-200">
            <div
              className="h-full bg-stone-300"
              style={{ width: `${Math.min(bufferedPercent, 100)}%` }}
            >
              <div
                className="h-full bg-[var(--accent)]"
                style={{ width: `${Math.min(playedPercent, 100)}%` }}
              />
            </div>
          </div>
          <div className="mb-4 grid grid-cols-2 gap-3">
            <button
              className="rounded-full bg-[var(--accent)] px-4 py-3 font-semibold text-white"
              onClick={() => void handlePlay()}
              type="button"
            >
              Play
            </button>
            <button
              className="rounded-full border border-stone-300 bg-white/70 px-4 py-3 font-semibold"
              onClick={() => void handlePause()}
              type="button"
            >
              Pause
            </button>
          </div>
          <label className="mb-2 block text-sm font-semibold uppercase tracking-[0.2em] text-stone-600">
            Voice for future chunks
          </label>
          <select
            className="w-full rounded-2xl border border-stone-300 bg-white/70 px-4 py-3"
            onChange={(event) => void handleVoiceChange(event.target.value)}
            value={job.voice_id}
          >
            {voices.map((voice) => (
              <option key={voice.id} value={voice.id}>
                {voice.display_name}
              </option>
            ))}
          </select>
          <div className="mt-4 text-sm text-stone-600">
            Buffer ready: {bufferedUntilSeconds.toFixed(1)}s of {totalDuration.toFixed(1)}s.{" "}
            {isReady ? "MediaSource ready." : "Preparing stream…"}
          </div>
        </div>
        <div className="panel rounded-[2rem] p-6">
          <h2 className="mb-3 text-lg font-semibold">Live diagnostics</h2>
          <div className="grid gap-3 text-sm text-stone-700 md:grid-cols-2">
            <div className="rounded-2xl bg-white/70 p-4">
              Socket: {websocketStatus}
              {isSocketStale ? " (stale)" : ""}
            </div>
            <div className="rounded-2xl bg-white/70 p-4">
              Last live event: {formatRelativeTime(lastSocketMessageAt)}
            </div>
            <div className="rounded-2xl bg-white/70 p-4">
              Reader refresh: {formatRelativeTime(lastRefreshAt)} via {lastRefreshReason}
            </div>
            <div className="rounded-2xl bg-white/70 p-4">
              Written chunks: {writtenChunkCount}/{job.chunks.length}
            </div>
            <div className="rounded-2xl bg-white/70 p-4">
              Appended chunks: {appendedChunksCount}
            </div>
            <div className="rounded-2xl bg-white/70 p-4">
              Playback intent: {playIntent ? "play" : "pause"}
            </div>
            <div className="rounded-2xl bg-white/70 p-4">
              Audio element: {isActuallyPlaying ? "playing" : "idle"}
            </div>
            <div className="rounded-2xl bg-white/70 p-4">
              Waiting for data: {isWaitingForData ? "yes" : "no"}
            </div>
            <div className="rounded-2xl bg-white/70 p-4">
              Current time: {currentTimeSeconds.toFixed(1)}s
            </div>
            <div className="rounded-2xl bg-white/70 p-4">
              Buffered until: {bufferedUntilSeconds.toFixed(1)}s
            </div>
            <div className="rounded-2xl bg-white/70 p-4 md:col-span-2">
              Last transport/player issue:{" "}
              {lastPlayerError ?? lastPlaybackSyncError ?? lastSocketError ?? "none"}
            </div>
          </div>
        </div>
        <div className="panel rounded-[2rem] p-6">
          <h2 className="mb-3 text-lg font-semibold">Chunk status</h2>
          <div className="space-y-2">
            {job.chunks.map((chunk) => (
              <div
                className="flex items-center justify-between rounded-2xl border border-stone-200 bg-white/60 px-4 py-3"
                key={chunk.index}
              >
                <span>Chunk {chunk.index + 1}</span>
                <span className="text-sm text-stone-600">
                  {chunk.status} {chunk.duration_seconds ? `• ${chunk.duration_seconds.toFixed(1)}s` : ""}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
