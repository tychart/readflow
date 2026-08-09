import { useCallback, useEffect, useRef, useState } from "react";

import type { Chunk } from "../types/api";

/**
 * Parses a server peaks payload (`{ bins, peaks: number[] }`) into a
 * Float32Array. Returns null when the payload is malformed so callers can
 * fall back to a placeholder waveform.
 */
export function parsePeaks(data: unknown): Float32Array | null {
  if (typeof data !== "object" || data === null) return null;
  const raw = (data as { peaks?: unknown }).peaks;
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const peaks = new Float32Array(raw.length);
  for (let i = 0; i < raw.length; i++) {
    const value = raw[i];
    if (typeof value !== "number" || !Number.isFinite(value)) return null;
    peaks[i] = value;
  }
  return peaks;
}

/**
 * useChunkWaveforms — fetches and caches per-chunk waveform peaks for the
 * static reader playbar.
 *
 * The hook owns the whole analysis pipeline:
 * - watches written chunks for `peaks_url`
 * - fetches peaks JSON once per (chunk index, version)
 * - re-fetches when a chunk is reprocessed (version bump); the stale peaks
 *   are dropped immediately so the chunk renders as a placeholder until the
 *   fresh fetch completes
 * - sequential FIFO processing keeps server load predictable
 * - aborts in-flight fetches on unmount
 *
 * Returns a Map<chunkIndex, Float32Array> of analyzed peaks for the chunks
 * passed in. Chunks without peaks yet are simply absent from the map; the
 * timeline renders dim placeholders for them until the fetch completes.
 */
export function useChunkWaveforms(chunks: Chunk[]): Map<number, Float32Array> {
  const versionsRef = useRef(new Map<number, number>());
  const inflightRef = useRef(new Set<number>());
  const queueRef = useRef<number[]>([]);
  const controllersRef = useRef(new Map<number, AbortController>());
  const processingRef = useRef(false);
  const [waveforms, setWaveforms] = useState<Map<number, Float32Array>>(() => new Map());

  const chunksRef = useRef(chunks);
  chunksRef.current = chunks;

  const processQueue = useCallback(async () => {
    while (queueRef.current.length > 0) {
      const index = queueRef.current.shift() as number;
      inflightRef.current.add(index);
      try {
        const chunk = chunksRef.current.find((c) => c.index === index);
        if (!chunk?.peaks_url) continue;
        const controller = new AbortController();
        controllersRef.current.set(index, controller);
        try {
          const response = await fetch(chunk.peaks_url, { signal: controller.signal });
          if (!response.ok) continue;
          const peaks = parsePeaks(await response.json());
          if (peaks) {
            versionsRef.current.set(index, chunk.version);
            setWaveforms((prev) => {
              const next = new Map(prev);
              next.set(index, peaks);
              return next;
            });
          }
        } finally {
          controllersRef.current.delete(index);
        }
      } catch {
        // Network/parse failures fall back to the placeholder waveform.
      } finally {
        inflightRef.current.delete(index);
      }
    }
    processingRef.current = false;
  }, []);

  const enqueue = useCallback(() => {
    for (const chunk of chunksRef.current) {
      if (!chunk.peaks_url) continue;
      if (versionsRef.current.get(chunk.index) === chunk.version) continue;
      if (inflightRef.current.has(chunk.index)) continue;
      if (!queueRef.current.includes(chunk.index)) queueRef.current.push(chunk.index);
    }
    if (!processingRef.current && queueRef.current.length > 0) {
      processingRef.current = true;
      void processQueue();
    }
  }, [processQueue]);

  // Reconcile the exposed map with the current chunk list: drop peaks for
  // chunks that disappeared or whose version changed (they re-render as
  // placeholders until the fresh fetch completes), then enqueue work.
  useEffect(() => {
    const active = new Map<number, number>();
    for (const chunk of chunks) {
      if (chunk.peaks_url) active.set(chunk.index, chunk.version);
    }
    setWaveforms((prev) => {
      const next = new Map<number, Float32Array>();
      for (const [index, version] of active) {
        if (versionsRef.current.get(index) === version) {
          const peaks = prev.get(index);
          if (peaks) next.set(index, peaks);
        }
      }
      // Bail out when nothing changed so callers that pass a fresh array
      // identity on every render (e.g. inline literals) don't re-render.
      if (next.size === prev.size) {
        let same = true;
        for (const [index, peaks] of next) {
          if (prev.get(index) !== peaks) {
            same = false;
            break;
          }
        }
        if (same) return prev;
      }
      return next;
    });
    enqueue();
  }, [chunks, enqueue]);

  useEffect(() => {
    const controllers = controllersRef.current;
    return () => {
      for (const controller of controllers.values()) controller.abort();
      controllers.clear();
    };
  }, []);

  return waveforms;
}
