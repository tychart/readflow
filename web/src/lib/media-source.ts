import { useEffect, useRef, useState } from "react";

import type { JobManifest } from "../types/api";

async function fetchBuffer(url: string): Promise<ArrayBuffer> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch media segment: ${response.status}`);
  }
  return response.arrayBuffer();
}

export function useMediaSourcePlayer(manifest: JobManifest | null) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [bufferedUntilSeconds, setBufferedUntilSeconds] = useState(0);
  const [isReady, setIsReady] = useState(false);
  const sourceBufferRef = useRef<SourceBuffer | null>(null);
  const mediaSourceRef = useRef<MediaSource | null>(null);
  const appendQueueRef = useRef<ArrayBuffer[]>([]);
  const appendedChunksRef = useRef<Set<number>>(new Set());

  useEffect(() => {
    if (!manifest || !audioRef.current) {
      return;
    }
    if (!("MediaSource" in window)) {
      return;
    }
    const mediaSource = new MediaSource();
    const cleanupChunks = appendedChunksRef.current;
    mediaSourceRef.current = mediaSource;
    audioRef.current.src = URL.createObjectURL(mediaSource);

    const handleSourceOpen = async () => {
      const sourceBuffer = mediaSource.addSourceBuffer(manifest.mime_type);
      sourceBufferRef.current = sourceBuffer;
      sourceBuffer.addEventListener("updateend", () => {
        if (appendQueueRef.current.length > 0 && !sourceBuffer.updating) {
          const next = appendQueueRef.current.shift();
          if (next) {
            sourceBuffer.appendBuffer(next);
          }
        }
      });
      if (manifest.init_segment_url) {
        const initBuffer = await fetchBuffer(manifest.init_segment_url);
        sourceBuffer.appendBuffer(initBuffer);
      }
      setIsReady(true);
    };

    mediaSource.addEventListener("sourceopen", () => void handleSourceOpen());

    return () => {
      setIsReady(false);
      sourceBufferRef.current = null;
      mediaSourceRef.current = null;
      appendQueueRef.current = [];
      cleanupChunks.clear();
    };
  }, [manifest]);

  useEffect(() => {
    if (!manifest || !sourceBufferRef.current || !isReady) {
      return;
    }
    const sourceBuffer = sourceBufferRef.current;
    const appendedChunks = appendedChunksRef.current;
    const nextChunks = manifest.chunks.filter(
      (chunk) => chunk.status === "written" && chunk.segment_url && !appendedChunks.has(chunk.index),
    );
    if (nextChunks.length === 0) {
      return;
    }

    void (async () => {
      for (const chunk of nextChunks) {
        if (!chunk.segment_url) {
          continue;
        }
        const payload = await fetchBuffer(chunk.segment_url);
        appendedChunks.add(chunk.index);
        if (sourceBuffer.updating || appendQueueRef.current.length > 0) {
          appendQueueRef.current.push(payload);
        } else {
          sourceBuffer.appendBuffer(payload);
        }
      }
    })();
  }, [isReady, manifest, manifest?.chunks]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) {
      return;
    }
    const updateBuffered = () => {
      const ranges = audio.buffered;
      if (ranges.length > 0) {
        setBufferedUntilSeconds(ranges.end(ranges.length - 1));
      }
    };
    audio.addEventListener("progress", updateBuffered);
    audio.addEventListener("timeupdate", updateBuffered);
    return () => {
      audio.removeEventListener("progress", updateBuffered);
      audio.removeEventListener("timeupdate", updateBuffered);
    };
  }, []);

  return {
    audioRef,
    isReady,
    bufferedUntilSeconds,
  };
}
