import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { JobManifest } from "../types/api";

const PLAYABLE_EPSILON_SECONDS = 0.05;

export type PlayerState =
  | "idle"
  | "priming"
  | "waiting_for_first_chunk"
  | "ready_paused"
  | "playing"
  | "stalled_waiting_for_next_chunk"
  | "ended"
  | "error";

interface UseMediaSourcePlayerOptions {
  jobId: string;
  manifest: JobManifest | null;
  playIntent: boolean;
  isTerminal: boolean;
}

interface QueuedChunk {
  index: number;
  url: string;
}

interface AudioDiagnostics {
  paused: boolean;
  readyState: number;
  networkState: number;
}

async function fetchBuffer(url: string): Promise<ArrayBuffer> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch media segment: ${response.status}`);
  }
  return response.arrayBuffer();
}

function getBufferedEnd(audio: HTMLAudioElement | null) {
  if (!audio || audio.buffered.length === 0) {
    return 0;
  }
  return audio.buffered.end(audio.buffered.length - 1);
}

function hasBufferedAhead(audio: HTMLAudioElement | null, bufferedUntilSeconds: number) {
  if (!audio) {
    return false;
  }
  return bufferedUntilSeconds > (audio.currentTime ?? 0) + PLAYABLE_EPSILON_SECONDS;
}

function appendBuffer(sourceBuffer: SourceBuffer, payload: ArrayBuffer) {
  return new Promise<void>((resolve, reject) => {
    const handleUpdateEnd = () => {
      sourceBuffer.removeEventListener("error", handleError);
      resolve();
    };
    const handleError = () => {
      sourceBuffer.removeEventListener("updateend", handleUpdateEnd);
      reject(new Error("SourceBuffer append failed"));
    };
    sourceBuffer.addEventListener("updateend", handleUpdateEnd, { once: true });
    sourceBuffer.addEventListener("error", handleError, { once: true });
    sourceBuffer.appendBuffer(payload);
  });
}

function safePause(audio: HTMLAudioElement) {
  try {
    audio.pause();
  } catch {
    // jsdom does not implement full media playback controls.
  }
}

function safeLoad(audio: HTMLAudioElement) {
  try {
    audio.load();
  } catch {
    // jsdom does not implement full media playback controls.
  }
}

function isAutoplayPolicyError(error: unknown) {
  return error instanceof DOMException && error.name === "NotAllowedError";
}

function readablePlaybackError(error: unknown, fallback: string) {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return fallback;
}

function clampToBuffered(audio: HTMLAudioElement | null, targetSeconds: number) {
  if (!audio || audio.buffered.length === 0) {
    return 0;
  }

  const clampedTarget = Math.max(0, targetSeconds);
  for (let index = 0; index < audio.buffered.length; index += 1) {
    const start = audio.buffered.start(index);
    const end = audio.buffered.end(index);
    if (clampedTarget < start) {
      return start;
    }
    if (clampedTarget <= end) {
      return clampedTarget;
    }
  }
  return audio.buffered.end(audio.buffered.length - 1);
}

export function useMediaSourcePlayer({
  jobId,
  manifest,
  playIntent,
  isTerminal,
}: UseMediaSourcePlayerOptions) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const sourceBufferRef = useRef<SourceBuffer | null>(null);
  const objectUrlRef = useRef<string | null>(null);
  const activeStreamKeyRef = useRef<string | null>(null);
  const processingQueueRef = useRef(false);
  const initSegmentAppendedRef = useRef(false);
  const initSegmentPendingRef = useRef(false);
  const appendQueueRef = useRef<QueuedChunk[]>([]);
  const appendedChunkIndexesRef = useRef<Set<number>>(new Set());
  const pendingChunkIndexesRef = useRef<Set<number>>(new Set());

  const [bufferedUntilSeconds, setBufferedUntilSeconds] = useState(0);
  const [currentTimeSeconds, setCurrentTimeSeconds] = useState(0);
  const [isReady, setIsReady] = useState(false);
  const [isStreamPrimed, setIsStreamPrimed] = useState(false);
  const [isActuallyPlaying, setIsActuallyPlaying] = useState(false);
  const [isWaitingForData, setIsWaitingForData] = useState(false);
  const [lastPlayerError, setLastPlayerError] = useState<string | null>(null);
  const [appendedChunksCount, setAppendedChunksCount] = useState(0);
  const [hasEnded, setHasEnded] = useState(false);
  const [playerState, setPlayerState] = useState<PlayerState>("idle");
  const [isAutoplayBlocked, setIsAutoplayBlocked] = useState(false);
  const [diagnostics, setDiagnostics] = useState<AudioDiagnostics>({
    paused: true,
    readyState: 0,
    networkState: 0,
  });

  const streamKey = manifest ? `${jobId}:${manifest.mime_type}` : null;
  const mimeType = manifest?.mime_type ?? null;
  const initSegmentUrl = manifest?.init_segment_url ?? null;
  const renderedDurationSeconds = useMemo(
    () =>
      manifest?.chunks.reduce((maxDuration, chunk) => {
        if (chunk.status !== "written") {
          return maxDuration;
        }
        return Math.max(maxDuration, chunk.start_seconds + chunk.duration_seconds);
      }, 0) ?? 0,
    [manifest],
  );

  const updatePlaybackState = useCallback(() => {
    const audio = audioRef.current;
    setBufferedUntilSeconds(getBufferedEnd(audio));
    setCurrentTimeSeconds(audio?.currentTime ?? 0);
    setDiagnostics({
      paused: audio?.paused ?? true,
      readyState: audio?.readyState ?? 0,
      networkState: audio?.networkState ?? 0,
    });
  }, []);

  const attemptPlay = useCallback(
    async (reason: "auto" | "user") => {
      const audio = audioRef.current;
      if (!audio || !isReady || !isStreamPrimed || isTerminal) {
        return false;
      }
      if (!hasBufferedAhead(audio, bufferedUntilSeconds)) {
        return false;
      }

      try {
        await audio.play();
        setIsAutoplayBlocked(false);
        setLastPlayerError(null);
        return true;
      } catch (error) {
        if (reason === "auto" && isAutoplayPolicyError(error)) {
          setIsAutoplayBlocked(true);
          setLastPlayerError("Playback blocked by browser; press play to resume.");
          return false;
        }
        if (isAutoplayPolicyError(error)) {
          setIsAutoplayBlocked(true);
        }
        setLastPlayerError(
          readablePlaybackError(error, "Unable to resume playback automatically"),
        );
        return false;
      }
    },
    [bufferedUntilSeconds, isReady, isStreamPrimed, isTerminal],
  );

  const processQueue = useCallback(async () => {
    if (processingQueueRef.current || !sourceBufferRef.current || !activeStreamKeyRef.current) {
      return;
    }
    processingQueueRef.current = true;
    try {
      while (appendQueueRef.current.length > 0) {
        const nextChunk = appendQueueRef.current[0];
        const currentStreamKey: string | null = activeStreamKeyRef.current;
        if (!currentStreamKey || currentStreamKey !== streamKey) {
          break;
        }

        try {
          const payload = await fetchBuffer(nextChunk.url);
          if (activeStreamKeyRef.current !== currentStreamKey || !sourceBufferRef.current) {
            break;
          }
          await appendBuffer(sourceBufferRef.current, payload);
          appendQueueRef.current.shift();
          pendingChunkIndexesRef.current.delete(nextChunk.index);
          appendedChunkIndexesRef.current.add(nextChunk.index);
          setAppendedChunksCount(appendedChunkIndexesRef.current.size);
          setLastPlayerError(null);
          setHasEnded(false);
          updatePlaybackState();
        } catch (error) {
          pendingChunkIndexesRef.current.delete(nextChunk.index);
          setLastPlayerError(
            readablePlaybackError(error, "Unable to append streamed audio"),
          );
          break;
        }
      }
    } finally {
      processingQueueRef.current = false;
    }
  }, [streamKey, updatePlaybackState]);

  useEffect(() => {
    if (!streamKey || !mimeType || !audioRef.current) {
      return;
    }
    if (!("MediaSource" in window)) {
      setLastPlayerError("MediaSource is not available in this browser");
      setPlayerState("error");
      return;
    }

    let cancelled = false;
    const mediaSource = new MediaSource();
    const objectUrl = URL.createObjectURL(mediaSource);
    const audio = audioRef.current;

    activeStreamKeyRef.current = streamKey;
    sourceBufferRef.current = null;
    objectUrlRef.current = objectUrl;
    initSegmentAppendedRef.current = false;
    initSegmentPendingRef.current = false;
    appendQueueRef.current = [];
    appendedChunkIndexesRef.current = new Set();
    pendingChunkIndexesRef.current = new Set();
    processingQueueRef.current = false;
    setBufferedUntilSeconds(0);
    setCurrentTimeSeconds(0);
    setIsReady(false);
    setIsStreamPrimed(false);
    setIsActuallyPlaying(false);
    setIsWaitingForData(false);
    setLastPlayerError(null);
    setAppendedChunksCount(0);
    setHasEnded(false);
    setIsAutoplayBlocked(false);
    setDiagnostics({ paused: true, readyState: 0, networkState: 0 });
    safePause(audio);
    audio.src = objectUrl;

    const handleSourceOpen = async () => {
      try {
        const sourceBuffer = mediaSource.addSourceBuffer(mimeType);
        sourceBufferRef.current = sourceBuffer;
        if (!cancelled && activeStreamKeyRef.current === streamKey) {
          setIsReady(true);
          setLastPlayerError(null);
          updatePlaybackState();
        }
      } catch (error) {
        if (!cancelled) {
          setLastPlayerError(
            readablePlaybackError(error, "Failed to initialize media stream"),
          );
        }
      }
    };

    mediaSource.addEventListener("sourceopen", () => void handleSourceOpen(), { once: true });

    return () => {
      cancelled = true;
      activeStreamKeyRef.current = null;
      sourceBufferRef.current = null;
      appendQueueRef.current = [];
      initSegmentAppendedRef.current = false;
      initSegmentPendingRef.current = false;
      appendedChunkIndexesRef.current.clear();
      pendingChunkIndexesRef.current.clear();
      processingQueueRef.current = false;
      setIsReady(false);
      setIsStreamPrimed(false);
      setHasEnded(false);
      setIsAutoplayBlocked(false);
      safePause(audio);
      audio.removeAttribute("src");
      safeLoad(audio);
      if (objectUrlRef.current) {
        URL.revokeObjectURL(objectUrlRef.current);
        objectUrlRef.current = null;
      }
    };
  }, [mimeType, streamKey, updatePlaybackState]);

  useEffect(() => {
    if (
      !isReady ||
      !streamKey ||
      !initSegmentUrl ||
      !sourceBufferRef.current ||
      initSegmentAppendedRef.current ||
      initSegmentPendingRef.current
    ) {
      return;
    }

    const currentStreamKey = streamKey;
    initSegmentPendingRef.current = true;

    void (async () => {
      try {
        const initBuffer = await fetchBuffer(initSegmentUrl);
        if (activeStreamKeyRef.current !== currentStreamKey || !sourceBufferRef.current) {
          return;
        }
        await appendBuffer(sourceBufferRef.current, initBuffer);
        if (activeStreamKeyRef.current !== currentStreamKey) {
          return;
        }
        initSegmentAppendedRef.current = true;
        setIsStreamPrimed(true);
        setLastPlayerError(null);
        updatePlaybackState();
        void processQueue();
      } catch (error) {
        setLastPlayerError(
          readablePlaybackError(error, "Failed to initialize media stream"),
        );
      } finally {
        initSegmentPendingRef.current = false;
      }
    })();
  }, [initSegmentUrl, isReady, processQueue, streamKey, updatePlaybackState]);

  useEffect(() => {
    if (!manifest || !isReady || !isStreamPrimed || activeStreamKeyRef.current !== streamKey) {
      return;
    }
    const missingChunks = manifest.chunks
      .filter(
        (chunk) =>
          chunk.status === "written" &&
          !!chunk.segment_url &&
          !appendedChunkIndexesRef.current.has(chunk.index) &&
          !pendingChunkIndexesRef.current.has(chunk.index),
      )
      .sort((left, right) => left.index - right.index);

    if (missingChunks.length === 0) {
      return;
    }

    for (const chunk of missingChunks) {
      if (!chunk.segment_url) {
        continue;
      }
      pendingChunkIndexesRef.current.add(chunk.index);
      appendQueueRef.current.push({ index: chunk.index, url: chunk.segment_url });
    }
    appendQueueRef.current.sort((left, right) => left.index - right.index);
    void processQueue();
  }, [isReady, isStreamPrimed, manifest, processQueue, streamKey]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) {
      return;
    }

    const handlePlay = () => {
      setIsActuallyPlaying(true);
      setIsWaitingForData(false);
      setIsAutoplayBlocked(false);
      setLastPlayerError(null);
      setHasEnded(false);
      updatePlaybackState();
    };
    const handlePause = () => {
      setIsActuallyPlaying(false);
      updatePlaybackState();
    };
    const handleWaiting = () => {
      setIsWaitingForData(true);
      setIsActuallyPlaying(false);
      updatePlaybackState();
    };
    const handleProgress = () => {
      updatePlaybackState();
    };
    const handleTimeUpdate = () => {
      updatePlaybackState();
    };
    const handleSeeking = () => {
      updatePlaybackState();
    };
    const handleEnded = () => {
      setHasEnded(true);
      setIsActuallyPlaying(false);
      setIsWaitingForData(false);
      updatePlaybackState();
    };
    const handlePlaying = () => {
      setHasEnded(false);
      setIsActuallyPlaying(true);
      setIsWaitingForData(false);
      setIsAutoplayBlocked(false);
      setLastPlayerError(null);
      updatePlaybackState();
    };
    const handleError = () => {
      setIsActuallyPlaying(false);
      setLastPlayerError("Audio playback failed");
      updatePlaybackState();
    };

    audio.addEventListener("play", handlePlay);
    audio.addEventListener("pause", handlePause);
    audio.addEventListener("waiting", handleWaiting);
    audio.addEventListener("progress", handleProgress);
    audio.addEventListener("timeupdate", handleTimeUpdate);
    audio.addEventListener("seeking", handleSeeking);
    audio.addEventListener("seeked", handleProgress);
    audio.addEventListener("ended", handleEnded);
    audio.addEventListener("playing", handlePlaying);
    audio.addEventListener("error", handleError);

    return () => {
      audio.removeEventListener("play", handlePlay);
      audio.removeEventListener("pause", handlePause);
      audio.removeEventListener("waiting", handleWaiting);
      audio.removeEventListener("progress", handleProgress);
      audio.removeEventListener("timeupdate", handleTimeUpdate);
      audio.removeEventListener("seeking", handleSeeking);
      audio.removeEventListener("seeked", handleProgress);
      audio.removeEventListener("ended", handleEnded);
      audio.removeEventListener("playing", handlePlaying);
      audio.removeEventListener("error", handleError);
    };
  }, [updatePlaybackState]);

  useEffect(() => {
    if (!playIntent || isTerminal || isAutoplayBlocked) {
      return;
    }
    const audio = audioRef.current;
    if (!audio || !isReady || !isStreamPrimed) {
      return;
    }
    if (!hasBufferedAhead(audio, bufferedUntilSeconds)) {
      return;
    }
    if (!audio.paused && !isWaitingForData) {
      return;
    }
    void attemptPlay("auto");
  }, [
    attemptPlay,
    bufferedUntilSeconds,
    isAutoplayBlocked,
    isReady,
    isStreamPrimed,
    isTerminal,
    isWaitingForData,
    playIntent,
  ]);

  useEffect(() => {
    if (lastPlayerError) {
      setPlayerState("error");
      return;
    }
    if (playIntent) {
      if (!isStreamPrimed || renderedDurationSeconds <= PLAYABLE_EPSILON_SECONDS) {
        setPlayerState("waiting_for_first_chunk");
        return;
      }
      if (isActuallyPlaying) {
        setPlayerState("playing");
        return;
      }
      if (
        isWaitingForData ||
        bufferedUntilSeconds <= currentTimeSeconds + PLAYABLE_EPSILON_SECONDS
      ) {
        setPlayerState(
          currentTimeSeconds <= PLAYABLE_EPSILON_SECONDS
            ? "waiting_for_first_chunk"
            : "stalled_waiting_for_next_chunk",
        );
        return;
      }
      setPlayerState("ready_paused");
      return;
    }
    if (hasEnded && isTerminal) {
      setPlayerState("ended");
      return;
    }
    if (streamKey && !isStreamPrimed) {
      setPlayerState("priming");
      return;
    }
    if (isStreamPrimed && renderedDurationSeconds > PLAYABLE_EPSILON_SECONDS) {
      setPlayerState("ready_paused");
      return;
    }
    setPlayerState("idle");
  }, [
    bufferedUntilSeconds,
    currentTimeSeconds,
    hasEnded,
    isActuallyPlaying,
    isStreamPrimed,
    isTerminal,
    isWaitingForData,
    lastPlayerError,
    playIntent,
    renderedDurationSeconds,
    streamKey,
  ]);

  const requestUserGesturePlay = useCallback(async () => {
    const played = await attemptPlay("user");
    if (!played) {
      updatePlaybackState();
    }
    return played;
  }, [attemptPlay, updatePlaybackState]);

  const pausePlayback = useCallback(() => {
    audioRef.current?.pause();
    updatePlaybackState();
  }, [updatePlaybackState]);

  const seekToSeconds = useCallback(
    (targetSeconds: number) => {
      const audio = audioRef.current;
      if (!audio) {
        return 0;
      }
      const cappedTarget = Math.min(targetSeconds, renderedDurationSeconds);
      const clampedTarget = clampToBuffered(audio, cappedTarget);
      audio.currentTime = clampedTarget;
      setHasEnded(false);
      updatePlaybackState();
      return clampedTarget;
    },
    [renderedDurationSeconds, updatePlaybackState],
  );

  return {
    audioRef,
    appendedChunksCount,
    bufferedUntilSeconds,
    currentTimeSeconds,
    diagnostics,
    isActuallyPlaying,
    isAutoplayBlocked,
    isReady,
    isStreamPrimed,
    isWaitingForData,
    lastPlayerError,
    pausePlayback,
    playerState,
    renderedDurationSeconds,
    requestUserGesturePlay,
    seekToSeconds,
  };
}
