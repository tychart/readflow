import { useSyncExternalStore } from "react";

export type Theme = "dark" | "light";

const STORAGE_KEY = "readflow-theme";

/* ── Resolution helpers ───────────────────────────────────── */

/**
 * Returns the stored theme preference from localStorage.
 * Returns null if no preference is saved.
 */
function getStoredTheme(): Theme | null {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === "dark" || stored === "light") {
      return stored;
    }
  } catch {
    // localStorage may be unavailable (private browsing, etc.)
  }
  return null;
}

/**
 * Returns the system's preferred color scheme.
 * Defaults to dark when matchMedia is unavailable (older browsers, jsdom).
 */
function getSystemTheme(): Theme {
  try {
    if (window.matchMedia("(prefers-color-scheme: light)").matches) {
      return "light";
    }
  } catch {
    // matchMedia is not available in every environment
  }
  return "dark";
}

/**
 * Resolves the effective theme from storage first, falling back to system preference.
 */
function resolveTheme(): Theme {
  return getStoredTheme() ?? getSystemTheme();
}

/* ── External store ───────────────────────────────────────── */

/**
 * Single source of truth for the current theme.
 *
 * The store keeps the resolved theme in memory and notifies subscribers on
 * every change. `getSnapshot` must NOT read localStorage directly: the
 * browser only fires `storage` events in *other* tabs, so the tab that
 * calls `localStorage.setItem` would never be told to re-read — the toggle
 * works once and then every click writes the same stale value. Keeping an
 * in-memory value plus an explicit notify keeps the DOM class, the stored
 * preference, and React state consistent on every change.
 */
let currentTheme: Theme = resolveTheme();

const listeners = new Set<() => void>();

function emit(): void {
  listeners.forEach((listener) => listener());
}

/**
 * Commits a new theme: updates the in-memory value, applies it to the
 * document, and notifies subscribers. No-op when the theme is unchanged.
 */
function commit(theme: Theme): void {
  if (theme === currentTheme) {
    return;
  }
  currentTheme = theme;
  applyTheme(theme);
  emit();
}

/**
 * Applies the given theme to the document.
 */
export function applyTheme(theme: Theme): void {
  if (theme === "dark") {
    document.documentElement.classList.remove("light");
    document.documentElement.classList.add("dark");
  } else {
    document.documentElement.classList.remove("dark");
    document.documentElement.classList.add("light");
  }
}

/**
 * Persists the theme to localStorage and commits it. Subscribers re-render
 * synchronously, so callers never operate on stale state.
 */
export function setTheme(next: Theme): void {
  if (next === currentTheme) {
    return;
  }
  try {
    localStorage.setItem(STORAGE_KEY, next);
  } catch {
    // Silently fail if localStorage is unavailable
  }
  commit(next);
}

/**
 * Toggles between dark and light. Reads the store directly rather than any
 * captured React state, so it can never toggle off a stale value.
 */
export function toggleTheme(): void {
  setTheme(currentTheme === "dark" ? "light" : "dark");
}

/**
 * Synchronously resolves and applies the saved (or system-detected) theme.
 * Safe to call during initial page load (no-flash initialization).
 */
export function initTheme(): Theme {
  currentTheme = resolveTheme();
  applyTheme(currentTheme);
  return currentTheme;
}

/* ── Ambient sources (cross-tab + OS preference) ─────────── */

let ambientSourcesWired = false;

function syncFromStorage(event: StorageEvent): void {
  // `key === null` covers localStorage.clear()/removeItem in other tabs.
  if (event.key !== null && event.key !== STORAGE_KEY) {
    return;
  }
  commit(resolveTheme());
}

function syncFromSystem(): void {
  // Only follow OS changes while the user hasn't stored a preference.
  if (getStoredTheme()) {
    return;
  }
  commit(getSystemTheme());
}

/**
 * Wires the ambient sources (cross-tab `storage` events and OS-level
 * preference changes) exactly once. Deferred until the first subscriber so
 * environments that stub `matchMedia` after import (tests) still work.
 */
function startWatchingAmbientSources(): void {
  if (ambientSourcesWired) {
    return;
  }
  ambientSourcesWired = true;
  window.addEventListener("storage", syncFromStorage);
  const darkMedia = window.matchMedia("(prefers-color-scheme: dark)");
  const lightMedia = window.matchMedia("(prefers-color-scheme: light)");
  darkMedia.addEventListener("change", syncFromSystem);
  lightMedia.addEventListener("change", syncFromSystem);
}

function subscribe(callback: () => void): () => void {
  startWatchingAmbientSources();
  listeners.add(callback);
  return () => {
    listeners.delete(callback);
  };
}

function getSnapshot(): Theme {
  return currentTheme;
}

/* ── Hook ─────────────────────────────────────────────────── */

/**
 * Hook for accessing and toggling the current theme.
 * Uses useSyncExternalStore for tear-free, concurrent-safe reads.
 * `toggleTheme`/`setTheme` are stable module-level functions.
 */
export function useTheme() {
  const theme = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  return { theme, toggleTheme, setTheme, isDark: theme === "dark" };
}

/**
 * Test-only helper: re-resolves the store from the environment's stored or
 * system preference and re-arms the ambient source listeners so the next
 * subscriber registers against the current `matchMedia` stub. Mirrors the
 * `resetForTests` convention used elsewhere for module-level singletons.
 */
export function resetThemeForTests(): void {
  currentTheme = resolveTheme();
  ambientSourcesWired = false;
}
