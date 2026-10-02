import { beforeEach, describe, expect, test, vi } from "vitest";

import {
  DEFAULT_READER_SETTINGS,
  getReaderSettings,
  invalidateReaderSettingsCache,
  READER_SETTINGS_STORAGE_KEY,
  resetReaderSettings,
  resolveAnimatedMotion,
  sanitizeReaderSettings,
  setReaderSettings,
  subscribeReaderSettings,
} from "./reader-settings";

beforeEach(() => {
  localStorage.clear();
  invalidateReaderSettingsCache();
});

describe("sanitizeReaderSettings", () => {
  test("returns defaults for anything that is not an object", () => {
    expect(sanitizeReaderSettings(null)).toEqual(DEFAULT_READER_SETTINGS);
    expect(sanitizeReaderSettings("nope")).toEqual(DEFAULT_READER_SETTINGS);
    expect(sanitizeReaderSettings(42)).toEqual(DEFAULT_READER_SETTINGS);
  });

  test("falls back per field so one bad value cannot reset the rest", () => {
    const settings = sanitizeReaderSettings({
      motionMode: "warp",
      showChunkJumpButtons: false,
      conveyorWindowSize: 9,
    });
    expect(settings.motionMode).toBe(DEFAULT_READER_SETTINGS.motionMode);
    expect(settings.showChunkJumpButtons).toBe(false);
    expect(settings.conveyorWindowSize).toBe(DEFAULT_READER_SETTINGS.conveyorWindowSize);
  });

  test("accepts every valid value", () => {
    expect(
      sanitizeReaderSettings({
        motionMode: "always",
        showConveyor: false,
        showChunkJumpButtons: true,
        conveyorWindowSize: 5,
      }),
    ).toEqual({
      motionMode: "always",
      showConveyor: false,
      showChunkJumpButtons: true,
      conveyorWindowSize: 5,
    });
    expect(sanitizeReaderSettings({ conveyorWindowSize: 3 }).conveyorWindowSize).toBe(3);
    expect(sanitizeReaderSettings({ motionMode: "reduced" }).motionMode).toBe("reduced");
  });
});

describe("resolveAnimatedMotion", () => {
  test("explicit modes override the OS preference", () => {
    expect(resolveAnimatedMotion("reduced", false)).toBe("reduced");
    expect(resolveAnimatedMotion("always", true)).toBe("animated");
  });

  test("auto follows the OS preference", () => {
    expect(resolveAnimatedMotion("auto", true)).toBe("reduced");
    expect(resolveAnimatedMotion("auto", false)).toBe("animated");
  });
});

describe("reader settings store", () => {
  test("starts from defaults with empty storage", () => {
    expect(getReaderSettings()).toEqual(DEFAULT_READER_SETTINGS);
  });

  test("persists changes to localStorage and reloads them", () => {
    setReaderSettings({ showChunkJumpButtons: false, conveyorWindowSize: 4 });
    expect(JSON.parse(localStorage.getItem(READER_SETTINGS_STORAGE_KEY) ?? "{}")).toMatchObject({
      showChunkJumpButtons: false,
      conveyorWindowSize: 4,
    });

    invalidateReaderSettingsCache();
    expect(getReaderSettings().showChunkJumpButtons).toBe(false);
    expect(getReaderSettings().conveyorWindowSize).toBe(4);
  });

  test("merges patches without dropping untouched fields", () => {
    setReaderSettings({ showConveyor: false });
    setReaderSettings({ motionMode: "reduced" });
    expect(getReaderSettings()).toEqual({
      ...DEFAULT_READER_SETTINGS,
      showConveyor: false,
      motionMode: "reduced",
    });
  });

  test("ignores corrupt stored JSON", () => {
    localStorage.setItem(READER_SETTINGS_STORAGE_KEY, "{not json");
    invalidateReaderSettingsCache();
    expect(getReaderSettings()).toEqual(DEFAULT_READER_SETTINGS);
  });

  test("sanitizes stored values on load", () => {
    localStorage.setItem(
      READER_SETTINGS_STORAGE_KEY,
      JSON.stringify({ motionMode: "nonsense", showChunkJumpButtons: false }),
    );
    invalidateReaderSettingsCache();
    expect(getReaderSettings()).toEqual({
      ...DEFAULT_READER_SETTINGS,
      showChunkJumpButtons: false,
    });
  });

  test("notifies subscribers on change and stops after unsubscribe", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeReaderSettings(listener);

    setReaderSettings({ showConveyor: false });
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    setReaderSettings({ showConveyor: true });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  test("keeps a stable snapshot reference between changes", () => {
    const before = getReaderSettings();
    expect(getReaderSettings()).toBe(before);
    setReaderSettings({ motionMode: "always" });
    expect(getReaderSettings()).not.toBe(before);
  });

  test("reset restores and persists the defaults", () => {
    setReaderSettings({ showChunkJumpButtons: false, motionMode: "always" });
    resetReaderSettings();
    expect(getReaderSettings()).toEqual(DEFAULT_READER_SETTINGS);
    invalidateReaderSettingsCache();
    expect(getReaderSettings()).toEqual(DEFAULT_READER_SETTINGS);
  });
});
