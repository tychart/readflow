import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  invalidateReaderSettingsCache,
  resetReaderSettings,
  setReaderSettings,
} from "../state/reader-settings";
import { NavbarJobTitle } from "./NavbarJobTitle";

const originalMatchMedia = window.matchMedia;

/** jsdom has no matchMedia; reduced-motion is the one query this reads. */
function stubMatchMedia(reduceMotion: boolean) {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      matches: reduceMotion && query.includes("prefers-reduced-motion"),
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  });
}

beforeEach(() => {
  // Reader preferences persist to localStorage; a test that flips one must not
  // leak it into the next (the reduced-motion case below sets one).
  resetReaderSettings();
  invalidateReaderSettingsCache();
  stubMatchMedia(false);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: originalMatchMedia,
  });
});

describe("NavbarJobTitle", () => {
  it("renders nothing when no reader is open", () => {
    render(<NavbarJobTitle title={null} />);

    expect(screen.queryByTestId("navbar-job-title")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("shows the open job's title with the full name on hover", () => {
    render(<NavbarJobTitle title="Chapter 4 — The Long Dark" />);

    const button = screen.getByRole("button", {
      name: /Chapter 4 — The Long Dark/,
    });
    expect(button).toHaveAttribute("title", "Chapter 4 — The Long Dark");
    // The visible label already names the job; the hidden suffix explains what
    // pressing it does.
    expect(button).toHaveAccessibleName(/back to the top/);
  });

  it("fades in on the reader's scroll progress and reveals itself on focus", () => {
    render(<NavbarJobTitle title="Chapter 4" />);

    const button = screen.getByRole("button");
    // Continuous fade, not a threshold toggle: the resolved value is a calc on
    // the reader playbar's progress (mirrored onto <html>). The end-to-end test
    // asserts the number the browser actually computes.
    expect(button.className).toMatch(
      /opacity-\[calc\(var\(--scroll-progress,0\)\*1\.5\)\]/,
    );
    // Keyboard focus must reveal the control instead of landing on invisible
    // text, which is why the fade is a class and not an inline style.
    expect(button.className).toContain("focus-visible:opacity-100");
  });

  it("scrolls back to the top of the document when clicked", async () => {
    const user = userEvent.setup();
    const scrollTo = vi.spyOn(window, "scrollTo").mockImplementation(() => {});
    render(<NavbarJobTitle title="Chapter 4" />);

    await user.click(screen.getByRole("button"));

    expect(scrollTo).toHaveBeenCalledWith({ top: 0, behavior: "smooth" });
  });

  it("jumps instead of gliding when the OS asks for reduced motion", async () => {
    stubMatchMedia(true);
    const user = userEvent.setup();
    const scrollTo = vi.spyOn(window, "scrollTo").mockImplementation(() => {});
    render(<NavbarJobTitle title="Chapter 4" />);

    await user.click(screen.getByRole("button"));

    expect(scrollTo).toHaveBeenCalledWith({ top: 0, behavior: "auto" });
  });

  it("follows the reader's motion setting even when the OS allows motion", async () => {
    setReaderSettings({ motionMode: "reduced" });
    const user = userEvent.setup();
    const scrollTo = vi.spyOn(window, "scrollTo").mockImplementation(() => {});
    render(<NavbarJobTitle title="Chapter 4" />);

    await user.click(screen.getByRole("button"));

    // One decision point (`useReaderMotion`), not a second OS-only derivation.
    expect(scrollTo).toHaveBeenCalledWith({ top: 0, behavior: "auto" });
  });
});
