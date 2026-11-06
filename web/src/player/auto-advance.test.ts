import { expect, it } from "vitest";

import { isAtJobEnd, resolveAutoAdvance } from "./auto-advance";
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

const ended = {
  hasEnded: true,
  streamEndSeconds: 30,
  durationSeconds: 30,
  continuousPlay: true,
};

it("advances when playback really ended at the end of a folder job", () => {
  expect(resolveAutoAdvance({ ...ended, job: job() })).toBe("b");
});

it("does not advance before the end of the job", () => {
  expect(
    resolveAutoAdvance({ ...ended, job: job(), streamEndSeconds: 20 }),
  ).toBeNull();
});

it("does not advance when a gap stopped playback before the job's real end", () => {
  // Chunks after a failed one exist, so the anchored stream ends early even
  // though the media element did reach the end of what it could play.
  expect(
    resolveAutoAdvance({ ...ended, job: job(), streamEndSeconds: 12 }),
  ).toBeNull();
});

it("does not advance when the media did not actually end", () => {
  // Paused, seeking, or restored at the end: the position is there but nothing
  // finished playing.
  expect(
    resolveAutoAdvance({ ...ended, job: job(), hasEnded: false }),
  ).toBeNull();
});

it("respects continuous play, the last job, root jobs and non-terminal jobs", () => {
  expect(
    resolveAutoAdvance({ ...ended, job: job(), continuousPlay: false }),
  ).toBeNull();
  expect(
    resolveAutoAdvance({ ...ended, job: job({ nextJobId: null }) }),
  ).toBeNull();
  expect(
    resolveAutoAdvance({
      ...ended,
      job: job({ folderId: null, nextJobId: null }),
    }),
  ).toBeNull();
  expect(
    resolveAutoAdvance({ ...ended, job: job({ isTerminal: false }) }),
  ).toBeNull();
  expect(
    resolveAutoAdvance({ ...ended, job: job(), durationSeconds: 0 }),
  ).toBeNull();
});

it("treats the end within the shared tolerance, and not before it", () => {
  expect(isAtJobEnd(30, 30)).toBe(true);
  expect(isAtJobEnd(29.6, 30)).toBe(true);
  expect(isAtJobEnd(29.4, 30)).toBe(false);
  // An empty document is never "at the end" (nothing has been played).
  expect(isAtJobEnd(0, 0)).toBe(false);
});
