import { describe, expect, test } from "vitest";

import { followScrollTarget } from "./reader-follow";

const viewport = {
  scrollY: 1_000,
  viewportHeight: 800,
  topInset: 160,
  bottomInset: 24,
};

describe("followScrollTarget", () => {
  test("aligns a newly active chunk into the comfortable reading position", () => {
    expect(
      followScrollTarget({
        ...viewport,
        chunkTop: 2_000,
        chunkHeight: 300,
        progress: 0,
        forceAlign: true,
      }),
    ).toBe(1_605.92);
  });

  test("does not micro-scroll while the spoken point remains readable", () => {
    expect(
      followScrollTarget({
        ...viewport,
        chunkTop: 1_400,
        chunkHeight: 500,
        progress: 0.5,
        forceAlign: false,
      }),
    ).toBeNull();
  });

  test("moves a long chunk only after its spoken point leaves the safe band", () => {
    expect(
      followScrollTarget({
        ...viewport,
        chunkTop: 1_400,
        chunkHeight: 2_000,
        progress: 0.8,
        forceAlign: false,
      }),
    ).toBe(2_605.92);
  });

  test("declines an impossible readable viewport", () => {
    expect(
      followScrollTarget({
        ...viewport,
        chunkTop: 1_000,
        chunkHeight: 100,
        progress: 0,
        topInset: 900,
        forceAlign: true,
      }),
    ).toBeNull();
  });
});
