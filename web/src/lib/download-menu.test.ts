import { describe, expect, test } from "vitest";

import { DOWNLOAD_MENU_WIDTH_PX, downloadMenuPlacement } from "./download-menu";

describe("downloadMenuPlacement", () => {
  test("drops below the button and right-aligns to it on a desktop viewport", () => {
    expect(downloadMenuPlacement({ bottom: 120, right: 900 }, 1024)).toEqual({
      top: 126,
      left: 900 - DOWNLOAD_MENU_WIDTH_PX,
      width: DOWNLOAD_MENU_WIDTH_PX,
    });
  });

  test("keeps a phone-width panel inside the viewport", () => {
    const placement = downloadMenuPlacement({ bottom: 100, right: 366 }, 390);
    expect(placement.width).toBe(DOWNLOAD_MENU_WIDTH_PX);
    expect(placement.left).toBeGreaterThanOrEqual(8);
    expect(placement.left + placement.width).toBeLessThanOrEqual(390 - 8);
  });

  test("clamps a button pressed against the right edge", () => {
    const placement = downloadMenuPlacement({ bottom: 100, right: 388 }, 390);
    expect(placement.left).toBe(390 - DOWNLOAD_MENU_WIDTH_PX - 8);
  });

  test("shrinks to the viewport when it is narrower than the panel", () => {
    const placement = downloadMenuPlacement({ bottom: 100, right: 270 }, 280);
    expect(placement.width).toBe(280 - 16);
    expect(placement.left).toBe(8);
    expect(placement.left + placement.width).toBeLessThanOrEqual(280);
  });
});
