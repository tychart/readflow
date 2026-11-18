import { type RefObject, useEffect, useRef } from "react";

import { followScrollTarget } from "./reader-follow";

interface UseReaderFollowOptions {
  enabled: boolean;
  activeChunkIndex: number | null;
  /** Position within the active chunk, normalized to 0–1. */
  activeChunkProgress: number;
  chunkRefs: RefObject<Map<number, HTMLDivElement>>;
  chromeRef: RefObject<HTMLDivElement | null>;
  bottomInset: number;
  motion: "animated" | "reduced";
  onPause: () => void;
}

const MIN_SCROLL_INTERVAL_MS = 250;
const SCROLL_KEYS = new Set([
  "ArrowDown",
  "ArrowUp",
  "End",
  "Home",
  "PageDown",
  "PageUp",
  " ",
]);

function isReaderControl(event: KeyboardEvent): boolean {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return false;
  return Boolean(
    target.closest(
      "input, select, textarea, [contenteditable=true], [role=dialog]",
    ),
  );
}

/**
 * Keep the current spoken point in a comfortable viewport band while follow is
 * enabled. Direct user scroll intent always pauses the mode; listening never
 * has to compete with reading ahead.
 */
export function useReaderFollow({
  enabled,
  activeChunkIndex,
  activeChunkProgress,
  chunkRefs,
  chromeRef,
  bottomInset,
  motion,
  onPause,
}: UseReaderFollowOptions): void {
  const previousActiveChunkRef = useRef<number | null>(null);
  const lastScrollAtRef = useRef(0);

  useEffect(() => {
    if (!enabled || activeChunkIndex === null) {
      previousActiveChunkRef.current = null;
      return;
    }

    const chunk = chunkRefs.current.get(activeChunkIndex);
    if (!chunk) return;

    const now = performance.now();
    const forceAlign = previousActiveChunkRef.current !== activeChunkIndex;
    if (!forceAlign && now - lastScrollAtRef.current < MIN_SCROLL_INTERVAL_MS) {
      return;
    }
    previousActiveChunkRef.current = activeChunkIndex;

    const chunkRect = chunk.getBoundingClientRect();
    const chromeBottom = chromeRef.current?.getBoundingClientRect().bottom ?? 0;
    const target = followScrollTarget({
      chunkTop: chunkRect.top + window.scrollY,
      chunkHeight: chunkRect.height,
      progress: activeChunkProgress,
      scrollY: window.scrollY,
      viewportHeight: window.innerHeight,
      topInset: Math.max(0, chromeBottom),
      bottomInset,
      forceAlign,
    });
    if (target === null) return;

    lastScrollAtRef.current = now;
    window.scrollTo({
      top: target,
      behavior: motion === "reduced" ? "auto" : "smooth",
    });
  }, [
    activeChunkIndex,
    activeChunkProgress,
    bottomInset,
    chromeRef,
    chunkRefs,
    enabled,
    motion,
  ]);

  useEffect(() => {
    if (!enabled) return;

    // Programmatic scrolls do not create wheel/touch/key input events. Listening
    // here (instead of `scroll`) means our own smooth scroll never deactivates
    // following, while user input stops it before the page can fight back. A
    // moving touch, rather than a touch start, leaves ordinary button taps alone.
    const pauseForManualNavigation = () => onPause();
    const pauseForKeyNavigation = (event: KeyboardEvent) => {
      if (!isReaderControl(event) && SCROLL_KEYS.has(event.key)) onPause();
    };

    window.addEventListener("wheel", pauseForManualNavigation, {
      passive: true,
    });
    window.addEventListener("touchmove", pauseForManualNavigation, {
      passive: true,
    });
    window.addEventListener("keydown", pauseForKeyNavigation);
    return () => {
      window.removeEventListener("wheel", pauseForManualNavigation);
      window.removeEventListener("touchmove", pauseForManualNavigation);
      window.removeEventListener("keydown", pauseForKeyNavigation);
    };
  }, [enabled, onPause]);
}
