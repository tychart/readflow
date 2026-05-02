import { useCallback, useEffect, useRef, useState } from "react";

import type { JobManifest } from "../types/api";

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
  const appendQueueRef = useRef<QueuedChunk[]>([]);
  const appendedChunkIndexesRef = useRef<Set<number>>(new Set());
  const pendingChunkIndexesRef = useRef<Set<number>>(new Set());

  const [bufferedUntilSeconds, setBufferedUntilSeconds] = useState(0);
  const [isReady, setIsReady] = useState(false);
  const [currentTimeSeconds, setCurrentTimeSeconds] = useState(0);
  const [isActuallyPlaying, setIsActuallyPlaying] = useState(false);
  const [isWaitingForData, setIsWaitingForData] = useState(false);
  const [lastPlayerError, setLastPlayerError] = useState<string | null>(null);
  const [appendedChunksCount, setAppendedChunksCount] = useState(0);

  const streamKey = manifest ? `${jobId}:${manifest.init_segment_url ?? "no-init"}` : null;
  const mimeType = manifest?.mime_type ?? null;
  const initSegmentUrl = manifest?.init_segment_url ?? null;

  const updateBufferedState = () => {
    const audio = audioRef.current;
    setBufferedUntilSeconds(getBufferedEnd(audio));
    setCurrentTimeSeconds(audio?.currentTime ?? 0);
  };

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
          updateBufferedState();
        } catch (error) {
          pendingChunkIndexesRef.current.delete(nextChunk.index);
          setLastPlayerError(
            error instanceof Error ? error.message : "Unable to append streamed audio",
          );
          break;
        }
      }
    } finally {
      processingQueueRef.current = false;
    }
  }, [streamKey]);

  useEffect(() => {
    if (!streamKey || !mimeType || !audioRef.current) {
      return;
    }
    if (!("MediaSource" in window)) {
      setLastPlayerError("MediaSource is not available in this browser");
      return;
    }

    let cancelled = false;
    const mediaSource = new MediaSource();
    const objectUrl = URL.createObjectURL(mediaSource);
    const audio = audioRef.current;

    activeStreamKeyRef.current = streamKey;
    sourceBufferRef.current = null;
    objectUrlRef.current = objectUrl;
    appendQueueRef.current = [];
    appendedChunkIndexesRef.current = new Set();
    pendingChunkIndexesRef.current = new Set();
    processingQueueRef.current = false;
    setIsReady(false);
    setBufferedUntilSeconds(0);
    setCurrentTimeSeconds(0);
    setIsActuallyPlaying(false);
    setIsWaitingForData(false);
    setLastPlayerError(null);
    setAppendedChunksCount(0);
    audio.src = objectUrl;

    const handleSourceOpen = async () => {
      try {
        const sourceBuffer = mediaSource.addSourceBuffer(mimeType);
        sourceBufferRef.current = sourceBuffer;
        if (initSegmentUrl) {
          const initBuffer = await fetchBuffer(initSegmentUrl);
          if (cancelled || activeStreamKeyRef.current !== streamKey) {
            return;
          }
          await appendBuffer(sourceBuffer, initBuffer);
        }
        if (!cancelled && activeStreamKeyRef.current === streamKey) {
          setIsReady(true);
          updateBufferedState();
        }
      } catch (error) {
        if (!cancelled) {
          setLastPlayerError(
            error instanceof Error ? error.message : "Failed to initialize media stream",
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
      appendedChunkIndexesRef.current.clear();
      pendingChunkIndexesRef.current.clear();
      processingQueueRef.current = false;
      setIsReady(false);
      if (objectUrlRef.current) {
        URL.revokeObjectURL(objectUrlRef.current);
        objectUrlRef.current = null;
      }
    };
  }, [initSegmentUrl, mimeType, streamKey]);

  useEffect(() => {
    if (!manifest || !isReady || activeStreamKeyRef.current !== streamKey) {
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
  }, [isReady, manifest, processQueue, streamKey]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) {
      return;
    }

    const handlePlay = () => {
      setIsActuallyPlaying(true);
      setIsWaitingForData(false);
      setLastPlayerError(null);
      updateBufferedState();
    };
    const handlePause = () => {
      setIsActuallyPlaying(false);
      updateBufferedState();
    };
    const handleWaiting = () => {
      setIsWaitingForData(true);
      updateBufferedState();
    };
    const handleProgress = () => {
      updateBufferedState();
    };
    const handleTimeUpdate = () => {
      updateBufferedState();
    };
    const handleSeeking = () => {
      updateBufferedState();
    };
    const handleEnded = () => {
      setIsActuallyPlaying(false);
      setIsWaitingForData(false);
      updateBufferedState();
    };
    const handlePlaying = () => {
      setIsActuallyPlaying(true);
      setIsWaitingForData(false);
      updateBufferedState();
    };
    const handleError = () => {
      setIsActuallyPlaying(false);
      setLastPlayerError("Audio playback failed");
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
  }, []);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !playIntent || !isReady || isTerminal) {
      return;
    }
    const hasBufferedAhead = bufferedUntilSeconds > audio.currentTime + 0.05;
    if (!hasBufferedAhead || (!isWaitingForData && !audio.paused)) {
      return;
    }
    void audio.play().catch((error: unknown) => {
      setLastPlayerError(
        error instanceof Error ? error.message : "Unable to resume playback automatically",
      );
    });
  }, [bufferedUntilSeconds, isReady, isTerminal, isWaitingForData, playIntent]);

  return {
    audioRef,
    appendedChunksCount,
    bufferedUntilSeconds,
    currentTimeSeconds,
    isActuallyPlaying,
    isReady,
    isWaitingForData,
    lastPlayerError,
  };
}
