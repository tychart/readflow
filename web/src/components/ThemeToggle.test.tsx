import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { ThemeToggle } from "./ThemeToggle";
import { initTheme, resetThemeForTests } from "../hooks/useTheme";

const STORAGE_KEY = "readflow-theme";

/**
 * Handlers registered via matchMedia(...).addEventListener("change", h).
 * Kept across stub replacements so tests can fire the handlers that were
 * registered when the component mounted.
 */
let mediaChangeHandlers: Array<() => void> = [];

function stubMatchMedia(prefersLight: boolean) {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: query.includes("light") ? prefersLight : !prefersLight,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: (_type: string, handler: () => void) => {
        mediaChangeHandlers.push(handler);
      },
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}

function htmlClassList() {
  return document.documentElement.classList;
}

describe("ThemeToggle", () => {
  beforeEach(() => {
    mediaChangeHandlers = [];
    stubMatchMedia(false); // OS prefers dark
    localStorage.clear();
    resetThemeForTests();
    // Simulate app startup (main.tsx calls initTheme() before render):
    // resolves the theme and applies it to <html>.
    initTheme();
  });

  afterEach(() => {
    cleanup();
  });

  it("renders with the resolved theme (dark by default)", () => {
    render(<ThemeToggle />);

    expect(htmlClassList()).toContain("dark");
    expect(htmlClassList()).not.toContain("light");
    expect(screen.getByRole("button", { name: "Switch to light mode" })).toBeInTheDocument();
  });

  it("toggles dark → light → dark → light on repeated clicks", async () => {
    const user = userEvent.setup();
    render(<ThemeToggle />);

    // First click: dark → light
    await user.click(screen.getByRole("button"));
    expect(htmlClassList()).toContain("light");
    expect(htmlClassList()).not.toContain("dark");
    expect(localStorage.getItem(STORAGE_KEY)).toBe("light");
    expect(screen.getByRole("button", { name: "Switch to dark mode" })).toBeInTheDocument();

    // Second click: light → dark
    // Regression: before the fix, the store was never notified after a
    // write, so the button re-toggled "light" again and appeared stuck.
    await user.click(screen.getByRole("button"));
    expect(htmlClassList()).toContain("dark");
    expect(htmlClassList()).not.toContain("light");
    expect(localStorage.getItem(STORAGE_KEY)).toBe("dark");
    expect(screen.getByRole("button", { name: "Switch to light mode" })).toBeInTheDocument();

    // Third click: dark → light again
    await user.click(screen.getByRole("button"));
    expect(htmlClassList()).toContain("light");
    expect(localStorage.getItem(STORAGE_KEY)).toBe("light");
  });

  it("prefers the stored preference over the system preference", () => {
    localStorage.setItem(STORAGE_KEY, "light");
    initTheme();

    render(<ThemeToggle />);

    expect(htmlClassList()).toContain("light");
    expect(screen.getByRole("button", { name: "Switch to dark mode" })).toBeInTheDocument();
  });

  it("follows the OS preference while no stored preference exists", () => {
    render(<ThemeToggle />);
    expect(htmlClassList()).toContain("dark");

    // OS flips to light; fire the change handlers registered on the media queries.
    stubMatchMedia(true);
    act(() => {
      mediaChangeHandlers.forEach((handler) => handler());
    });

    expect(htmlClassList()).toContain("light");
    expect(screen.getByRole("button", { name: "Switch to dark mode" })).toBeInTheDocument();
  });

  it("ignores OS changes once the user has stored a preference", () => {
    localStorage.setItem(STORAGE_KEY, "dark");
    initTheme();
    render(<ThemeToggle />);
    expect(htmlClassList()).toContain("dark");

    stubMatchMedia(true);
    act(() => {
      mediaChangeHandlers.forEach((handler) => handler());
    });

    expect(htmlClassList()).toContain("dark");
    expect(localStorage.getItem(STORAGE_KEY)).toBe("dark");
  });

  it("syncs theme changes from other tabs via storage events", () => {
    render(<ThemeToggle />);
    expect(htmlClassList()).toContain("dark");

    // Another tab persists "light", which fires a `storage` event here.
    localStorage.setItem(STORAGE_KEY, "light");
    act(() => {
      window.dispatchEvent(new StorageEvent("storage", { key: STORAGE_KEY, newValue: "light" }));
    });

    expect(htmlClassList()).toContain("light");
    expect(screen.getByRole("button", { name: "Switch to dark mode" })).toBeInTheDocument();
  });
});
