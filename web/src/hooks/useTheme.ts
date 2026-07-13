import { useCallback, useSyncExternalStore } from "react";

type Theme = "dark" | "light";

const STORAGE_KEY = "readflow-theme";

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
 */
function getSystemTheme(): Theme {
  if (typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: light)").matches) {
    return "light";
  }
  return "dark";
}

/**
 * Resolves the effective theme from storage first, falling back to system preference.
 */
function resolveTheme(): Theme {
  return getStoredTheme() ?? getSystemTheme();
}

function getSnapshot(): Theme {
  return resolveTheme();
}

function subscribe(callback: () => void): () => void {
  // Listen for storage changes from other tabs
  const handleStorage = (event: StorageEvent) => {
    if (event.key === STORAGE_KEY) {
      callback();
    }
  };
  window.addEventListener("storage", handleStorage);

  // Also listen for system preference changes when no stored preference
  const darkMedia = window.matchMedia("(prefers-color-scheme: dark)");
  const lightMedia = window.matchMedia("(prefers-color-scheme: light)");

  const handleChange = () => {
    // Only react to system changes if user hasn't stored a preference
    if (!getStoredTheme()) {
      callback();
    }
  };

  darkMedia.addEventListener("change", handleChange);
  lightMedia.addEventListener("change", handleChange);

  return () => {
    window.removeEventListener("storage", handleStorage);
    darkMedia.removeEventListener("change", handleChange);
    lightMedia.removeEventListener("change", handleChange);
  };
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
 * Synchronously persists the theme to localStorage and applies it.
 * Safe to call during initial page load (no-flash initialization).
 */
export function initTheme(): Theme {
  const theme = resolveTheme();
  applyTheme(theme);
  return theme;
}

/**
 * Hook for accessing and toggling the current theme.
 * Uses useSyncExternalStore for tear-free, concurrent-safe reads.
 */
export function useTheme() {
  const theme = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  const toggleTheme = useCallback(() => {
    const next: Theme = theme === "dark" ? "light" : "dark";
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Silently fail if localStorage is unavailable
    }
    applyTheme(next);
  }, [theme]);

  const setTheme = useCallback((next: Theme) => {
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Silently fail if localStorage is unavailable
    }
    applyTheme(next);
  }, []);

  return { theme, toggleTheme, setTheme, isDark: theme === "dark" };
}
