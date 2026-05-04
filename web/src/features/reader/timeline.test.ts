import { expect, test } from "vitest";

import { calculateChunkSeekTargetSeconds } from "./timeline";

test("calculates an exact seek target from the click position within a chunk", () => {
  expect(
    calculateChunkSeekTargetSeconds(100, { left: 0, width: 200 }, 0, 4),
  ).toBe(2);
  expect(
    calculateChunkSeekTargetSeconds(150, { left: 100, width: 200 }, 4, 8),
  ).toBe(6);
});

test("clamps chunk seek targets to the chunk bounds", () => {
  expect(
    calculateChunkSeekTargetSeconds(-50, { left: 0, width: 200 }, 4, 8),
  ).toBe(4);
  expect(
    calculateChunkSeekTargetSeconds(400, { left: 0, width: 200 }, 4, 8),
  ).toBe(12);
});
