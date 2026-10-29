import { describe, expect, test } from "vitest";

import {
  SHEET_DISMISS_FRACTION,
  SHEET_DISMISS_MIN_PX,
  sheetBackdropOpacity,
  sheetDragOffset,
  shouldDismissSheet,
} from "./sheet-gesture";

describe("sheetDragOffset", () => {
  test("follows downward travel only", () => {
    expect(sheetDragOffset(0)).toBe(0);
    expect(sheetDragOffset(42)).toBe(42);
    // Dragging up never lifts the sheet off the bottom edge.
    expect(sheetDragOffset(-42)).toBe(0);
  });

  test("ignores a non-finite delta", () => {
    expect(sheetDragOffset(Number.NaN)).toBe(0);
    expect(sheetDragOffset(Number.POSITIVE_INFINITY)).toBe(0);
  });
});

describe("shouldDismissSheet", () => {
  const idle = { velocityPxPerMs: 0 };

  test("a slow drag dismisses once it passes the minimum distance", () => {
    expect(
      shouldDismissSheet({ ...idle, deltaY: SHEET_DISMISS_MIN_PX - 1, sheetHeightPx: 200 }),
    ).toBe(false);
    expect(
      shouldDismissSheet({ ...idle, deltaY: SHEET_DISMISS_MIN_PX, sheetHeightPx: 200 }),
    ).toBe(true);
  });

  test("a tall sheet needs a proportionally longer drag", () => {
    const tallSheet = 600;
    const proportional = tallSheet * SHEET_DISMISS_FRACTION;
    expect(proportional).toBeGreaterThan(SHEET_DISMISS_MIN_PX);

    expect(
      shouldDismissSheet({ ...idle, deltaY: proportional - 1, sheetHeightPx: tallSheet }),
    ).toBe(false);
    expect(
      shouldDismissSheet({ ...idle, deltaY: proportional, sheetHeightPx: tallSheet }),
    ).toBe(true);
  });

  test("a short fast flick dismisses once it has actually travelled", () => {
    // 48px is well under the distance threshold, but it was thrown downward.
    expect(
      shouldDismissSheet({ deltaY: 48, sheetHeightPx: 600, velocityPxPerMs: 1.4 }),
    ).toBe(true);
    // A fast twitch with almost no travel must not close the panel...
    expect(
      shouldDismissSheet({ deltaY: 20, sheetHeightPx: 600, velocityPxPerMs: 1.4 }),
    ).toBe(false);
    // ...nor does a slow drag of the same distance.
    expect(
      shouldDismissSheet({ deltaY: 48, sheetHeightPx: 600, velocityPxPerMs: 0.2 }),
    ).toBe(false);
  });

  test("nothing dismisses while moving upward or not at all", () => {
    expect(
      shouldDismissSheet({ deltaY: 0, sheetHeightPx: 400, velocityPxPerMs: 3 }),
    ).toBe(false);
    expect(
      shouldDismissSheet({ deltaY: -20, sheetHeightPx: 400, velocityPxPerMs: 3 }),
    ).toBe(false);
  });
});

describe("sheetBackdropOpacity", () => {
  test("is fully opaque at rest", () => {
    expect(sheetBackdropOpacity(0)).toBe(1);
  });

  test("fades as the sheet is dragged down, and never disappears completely", () => {
    const halfway = sheetBackdropOpacity(140);
    expect(halfway).toBeLessThan(1);
    expect(halfway).toBeGreaterThan(0.15);
    expect(sheetBackdropOpacity(5000)).toBeCloseTo(0.15);
  });
});
