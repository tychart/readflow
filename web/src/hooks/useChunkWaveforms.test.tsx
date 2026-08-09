import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Chunk } from "../types/api";
import { parsePeaks, useChunkWaveforms } from "./useChunkWaveforms";

function makeChunk(index: number, version = 0, peaksUrl: string | null = null): Chunk {
  return {
    index,
    status: "written",
    duration_seconds: 4,
    start_seconds: 0,
    plan_version: 1,
    version,
    voice_id: "suzy",
    segment_url: null,
    peaks_url: peaksUrl,
    deprecated: false,
    reprocessing: false,
    char_start: 0,
    char_end: 4,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("useChunkWaveforms", () => {
  it("fetches peaks for written chunks and exposes them by index", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ bins: 2, peaks: [0.2, 0.8] }),
      })),
    );
    const { result, rerender } = renderHook(
      ({ chunks }: { chunks: Chunk[] }) => useChunkWaveforms(chunks),
      { initialProps: { chunks: [makeChunk(0, 0, "/peaks/0")] } },
    );
    await waitFor(() => expect(result.current.size).toBe(1));
    rerender({ chunks: [makeChunk(0, 0, "/peaks/0")] });
    const peaks = result.current.get(0) ?? new Float32Array();
    expect(peaks[0]).toBeCloseTo(0.2, 5);
    expect(peaks[1]).toBeCloseTo(0.8, 5);
  });

  it("re-fetches when a chunk version changes (reprocessing)", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ bins: 1, peaks: [0.5] }),
    }));
    vi.stubGlobal("fetch", fetchMock);
    const { result, rerender } = renderHook(
      ({ chunks }: { chunks: Chunk[] }) => useChunkWaveforms(chunks),
      { initialProps: { chunks: [makeChunk(0, 0, "/peaks/0")] } },
    );
    await waitFor(() => expect(result.current.size).toBe(1));
    expect(fetchMock).toHaveBeenCalledTimes(1);

    rerender({ chunks: [makeChunk(0, 1, "/peaks/0")] });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });

  it("does not fetch when no peaks_url is present", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useChunkWaveforms([makeChunk(0)]));
    expect(result.current.size).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not fetch twice for the same chunk version", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ bins: 1, peaks: [0.5] }),
    }));
    vi.stubGlobal("fetch", fetchMock);
    const { rerender } = renderHook(
      ({ chunks }: { chunks: Chunk[] }) => useChunkWaveforms(chunks),
      { initialProps: { chunks: [makeChunk(0, 0, "/peaks/0")] } },
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    rerender({ chunks: [makeChunk(0, 0, "/peaks/0")] });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  });

  it("handles failed fetches gracefully (placeholder fallback)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        json: async () => ({ peaks: [] }),
      })),
    );
    const { result } = renderHook(() => useChunkWaveforms([makeChunk(0, 0, "/peaks/0")]));
    expect(result.current.size).toBe(0);
  });
});

describe("parsePeaks", () => {
  it("parses a valid payload", () => {
    const peaks = parsePeaks({ bins: 2, peaks: [0.1, 0.9] });
    expect(peaks).not.toBeNull();
    expect(peaks![0]).toBeCloseTo(0.1, 5);
    expect(peaks![1]).toBeCloseTo(0.9, 5);
  });

  it("returns null for malformed payloads", () => {
    expect(parsePeaks(null)).toBeNull();
    expect(parsePeaks({})).toBeNull();
    expect(parsePeaks({ peaks: [] })).toBeNull();
    expect(parsePeaks({ peaks: "nope" })).toBeNull();
    expect(parsePeaks({ peaks: [0.1, Number.NaN] })).toBeNull();
    expect(parsePeaks({ peaks: ["x"] })).toBeNull();
  });
});
