import { expect, it } from "vitest";

import type { Chunk } from "../types/api";
import { collectHeardChunkIndexes } from "./heard";

function chunk(overrides: Partial<Chunk> & { index: number }): Chunk {
  return {
    status: "written",
    duration_seconds: 10,
    start_seconds: overrides.index * 10,
    plan_version: 1,
    version: 0,
    voice_id: "suzy",
    segment_url: null,
    peaks_url: null,
    deprecated: false,
    reprocessing: false,
    char_start: 0,
    char_end: 0,
    ...overrides,
  };
}

it("marks a chunk only after ~90% of real playback", () => {
  const chunks = [chunk({ index: 0 }), chunk({ index: 1 })];
  const heard = new Set<number>();
  collectHeardChunkIndexes(chunks, 8.9, heard);
  expect(heard).toEqual(new Set());
  collectHeardChunkIndexes(chunks, 9, heard);
  expect(heard).toEqual(new Set([0]));
  collectHeardChunkIndexes(chunks, 19.5, heard);
  expect(heard).toEqual(new Set([0, 1]));
});

it("ignores chunks without playable audio", () => {
  const chunks = [
    chunk({ index: 0, status: "planned", duration_seconds: 0 }),
    chunk({ index: 1, status: "failed", duration_seconds: 0 }),
    chunk({ index: 2, duration_seconds: 4, start_seconds: 0 }),
  ];
  const heard = new Set<number>();
  collectHeardChunkIndexes(chunks, 100, heard);
  expect(heard).toEqual(new Set([2]));
});

it("is additive, so earlier marks survive later reports", () => {
  const chunks = [chunk({ index: 0 }), chunk({ index: 1 })];
  const heard = new Set([0]);
  collectHeardChunkIndexes(chunks, 19, heard);
  expect(heard).toEqual(new Set([0, 1]));
});
