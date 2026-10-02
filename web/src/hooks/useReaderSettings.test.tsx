import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  DEFAULT_READER_SETTINGS,
  invalidateReaderSettingsCache,
  resetReaderSettings,
  setReaderSettings,
} from "../state/reader-settings";
import { usePrefersReducedMotion, useReaderMotion, useReaderSettings } from "./useReaderSettings";

/* ── matchMedia stub ──────────────────────────────────────── */

type MediaListener = (event: MediaQueryListEvent) => void;

function stubMatchMedia(matches: (query: string) => boolean) {
  const listeners = new Map<string, Set<MediaListener>>();
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: matches(query),
    media: query,
    onchange: null,
    addEventListener: (_type: string, listener: MediaListener) => {
      const set = listeners.get(query) ?? new Set<MediaListener>();
      set.add(listener);
      listeners.set(query, set);
    },
    removeEventListener: (_type: string, listener: MediaListener) => {
      listeners.get(query)?.delete(listener);
    },
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
  return {
    emit(query: string, event: MediaQueryListEvent) {
      for (const listener of listeners.get(query) ?? []) listener(event);
    },
  };
}

const REDUCED = "(prefers-reduced-motion: reduce)";

function SettingsProbe() {
  const settings = useReaderSettings();
  const prefersReduced = usePrefersReducedMotion();
  const motion = useReaderMotion();
  return (
    <div>
      <span data-testid="jump">{String(settings.showChunkJumpButtons)}</span>
      <span data-testid="mode">{settings.motionMode}</span>
      <span data-testid="prefers">{String(prefersReduced)}</span>
      <span data-testid="motion">{motion}</span>
    </div>
  );
}

beforeEach(() => {
  localStorage.clear();
  invalidateReaderSettingsCache();
  resetReaderSettings();
  stubMatchMedia(() => false);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("useReaderSettings", () => {
  test("reads the store and updates every subscriber on change", () => {
    render(<SettingsProbe />);
    expect(screen.getByTestId("jump")).toHaveTextContent("true");

    act(() => setReaderSettings({ showChunkJumpButtons: false }));

    expect(screen.getByTestId("jump")).toHaveTextContent("false");
    expect(DEFAULT_READER_SETTINGS.showChunkJumpButtons).toBe(true);
  });
});

describe("usePrefersReducedMotion", () => {
  test("reads the initial media state", () => {
    stubMatchMedia((query) => query === REDUCED);
    render(<SettingsProbe />);
    expect(screen.getByTestId("prefers")).toHaveTextContent("true");
  });

  test("follows OS changes while mounted", () => {
    const media = stubMatchMedia(() => false);
    render(<SettingsProbe />);
    expect(screen.getByTestId("prefers")).toHaveTextContent("false");

    act(() => media.emit(REDUCED, { matches: true } as MediaQueryListEvent));
    expect(screen.getByTestId("prefers")).toHaveTextContent("true");
  });
});

describe("useReaderMotion", () => {
  test("auto follows the OS preference", () => {
    stubMatchMedia((query) => query === REDUCED);
    render(<SettingsProbe />);
    expect(screen.getByTestId("mode")).toHaveTextContent("auto");
    expect(screen.getByTestId("motion")).toHaveTextContent("reduced");
  });

  test("an explicit mode overrides the OS preference", () => {
    stubMatchMedia((query) => query === REDUCED);
    render(<SettingsProbe />);

    act(() => setReaderSettings({ motionMode: "always" }));
    expect(screen.getByTestId("motion")).toHaveTextContent("animated");
  });

  test("explicit reduced animates nothing even when the OS is fine with motion", () => {
    stubMatchMedia(() => false);
    render(<SettingsProbe />);
    expect(screen.getByTestId("motion")).toHaveTextContent("animated");

    act(() => setReaderSettings({ motionMode: "reduced" }));
    expect(screen.getByTestId("motion")).toHaveTextContent("reduced");
  });
});
