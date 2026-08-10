import { act, cleanup, render, screen } from "@testing-library/react";

import { BrandHero } from "./BrandHero";
import { resetThemeForTests, setTheme } from "../../hooks/useTheme";

/**
 * jsdom has no matchMedia; the theme hook needs it to resolve the
 * system preference (stub returns "dark" by default).
 */
function stubMatchMedia() {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}

/** jsdom does not implement window.scrollY; provide it as a plain value. */
function setScrollY(value: number) {
  Object.defineProperty(window, "scrollY", {
    configurable: true,
    value,
    writable: true,
  });
}

describe("BrandHero", () => {
  beforeEach(() => {
    localStorage.clear();
    stubMatchMedia();
    resetThemeForTests();
    setScrollY(0);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("renders the full dark lockup with the tagline at the top of the page", () => {
    render(<BrandHero />);

    const lockup = screen.getByAltText(/turn your reading into listening/i);
    expect(lockup).toBeInTheDocument();
    expect(lockup.getAttribute("src")).toContain("readflow-lockup-dark.svg");
    // Full state: lockup is announced, compact row is hidden.
    expect(lockup).toHaveAttribute("aria-hidden", "false");
  });

  it("swaps to the light lockup when the light theme is active", () => {
    setTheme("light");
    render(<BrandHero />);

    const lockup = screen.getByAltText(/turn your reading into listening/i);
    expect(lockup.getAttribute("src")).toContain("readflow-lockup-light.svg");
  });

  it("collapses to just the icon + wordmark once the page is scrolled", () => {
    render(<BrandHero />);
    expect(
      screen.getByAltText(/turn your reading into listening/i),
    ).toHaveAttribute("aria-hidden", "false");

    setScrollY(200);
    act(() => {
      window.dispatchEvent(new Event("scroll"));
    });

    // Compact state: the lockup (with tagline) is hidden from assistive tech
    // and the compact icon + wordmark row is announced instead.
    const lockup = screen.getByAltText(/turn your reading into listening/i);
    expect(lockup).toHaveAttribute("aria-hidden", "true");
    expect(screen.getByText("ReadFlow")).toBeInTheDocument();
  });
});
