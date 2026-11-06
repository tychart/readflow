import { expect, it } from "vitest";

import { resolveAutoAdvance } from "./auto-advance";
import type { PlayerJob } from "./player-store";

const job = (overrides: Partial<PlayerJob> = {}): PlayerJob => ({
  id: "a",
  title: "A",
  isTerminal: true,
  audioEpoch: 0,
  folderId: "f",
  nextJobId: "b",
  previousJobId: null,
  ...overrides,
});

it("advances from the end of a terminal job in a folder", () => {
  expect(
    resolveAutoAdvance({
      job: job(),
      currentTimeSeconds: 30,
      renderedDurationSeconds: 30,
      continuousPlay: true,
    }),
  ).toBe("b");
});

it("does not advance before the end", () => {
  expect(
    resolveAutoAdvance({
      job: job(),
      currentTimeSeconds: 20,
      renderedDurationSeconds: 30,
      continuousPlay: true,
    }),
  ).toBeNull();
});

it("respects continuous play, the last job, root jobs and non-terminal jobs", () => {
  const base = {
    currentTimeSeconds: 30,
    renderedDurationSeconds: 30,
    continuousPlay: true,
  };
  expect(
    resolveAutoAdvance({ ...base, job: job(), continuousPlay: false }),
  ).toBeNull();
  expect(
    resolveAutoAdvance({ ...base, job: job({ nextJobId: null }) }),
  ).toBeNull();
  expect(
    resolveAutoAdvance({
      ...base,
      job: job({ folderId: null, nextJobId: null }),
    }),
  ).toBeNull();
  expect(
    resolveAutoAdvance({ ...base, job: job({ isTerminal: false }) }),
  ).toBeNull();
  expect(
    resolveAutoAdvance({ ...base, job: job(), renderedDurationSeconds: 0 }),
  ).toBeNull();
});
