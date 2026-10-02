import { useEffect, useState, useSyncExternalStore } from "react";

import {
  getReaderSettings,
  resolveAnimatedMotion,
  subscribeReaderSettings,
  type ReaderSettings,
} from "../state/reader-settings";

/** Reader preferences, shared across every component on the page. */
export function useReaderSettings(): ReaderSettings {
  return useSyncExternalStore(subscribeReaderSettings, getReaderSettings, getReaderSettings);
}

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

function currentPrefersReducedMotion(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  return window.matchMedia(REDUCED_MOTION_QUERY).matches;
}

/** Live `prefers-reduced-motion` state, following OS changes. */
export function usePrefersReducedMotion(): boolean {
  const [prefersReduced, setPrefersReduced] = useState(currentPrefersReducedMotion);

  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const query = window.matchMedia(REDUCED_MOTION_QUERY);
    const handleChange = (event: MediaQueryListEvent) => setPrefersReduced(event.matches);
    query.addEventListener("change", handleChange);
    setPrefersReduced(query.matches);
    return () => query.removeEventListener("change", handleChange);
  }, []);

  return prefersReduced;
}

/**
 * Whether playback visuals should animate, after combining the reader setting
 * with the OS preference. This is the single decision point the reader uses, so
 * "Auto" and an explicit override cannot drift apart.
 */
export function useReaderMotion(): "animated" | "reduced" {
  const { motionMode } = useReaderSettings();
  return resolveAnimatedMotion(motionMode, usePrefersReducedMotion());
}
