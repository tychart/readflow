import { useCallback, useEffect, useRef } from "react";

/** Scroll distance (px) over which the sticky bars collapse from expanded to compact. */
export const SCROLL_PROGRESS_RANGE_PX = 220;

/**
 * Map a raw scroll offset to the 0..1 progress the sticky bars interpolate on.
 *
 * Pure so the reader playbar and the app navbar cannot drift apart, and so the
 * clamping is testable without a DOM or a scroll event.
 */
export function scrollProgressFor(
  scrollY: number,
  rangePx: number = SCROLL_PROGRESS_RANGE_PX,
): number {
  if (!Number.isFinite(scrollY) || rangePx <= 0) return 0;
  return Math.min(1, Math.max(0, scrollY / rangePx));
}

export interface ScrollProgressVarOptions {
  /** Custom property to write on the element. */
  variable?: string;
  /** Scroll distance over which progress goes 0 → 1. */
  rangePx?: number;
  /**
   * Pin the progress instead of reading scroll. The navbar uses this to stay
   * compact on every route that is not the jobs page.
   */
  forced?: number;
}

/**
 * Write continuous scroll progress into a CSS custom property on an element.
 *
 * This deliberately does NOT go through React state. The value changes every
 * scroll frame, and routing it through `useState` re-rendered the whole page and
 * re-laid-out the collapsing bar's box at scroll-event rate — which is what made
 * the phone playbar stutter and flicker mid-shrink.
 *
 * Writing a custom property lets CSS `calc()` interpolate the geometry while
 * React renders zero times per scroll. Writes are rAF-coalesced, so a burst of
 * scroll events costs at most one style write per frame.
 *
 * Returns a callback ref (not an effect): the reader renders a loader before the
 * playbar exists, and a late-mounted element must still receive the current
 * value immediately.
 */
export function useScrollProgressVar<T extends HTMLElement = HTMLDivElement>({
  variable = "--scroll-progress",
  rangePx = SCROLL_PROGRESS_RANGE_PX,
  forced,
}: ScrollProgressVarOptions = {}) {
  const elementRef = useRef<T | null>(null);

  const write = useCallback(() => {
    const element = elementRef.current;
    if (!element) return;
    const progress = forced ?? scrollProgressFor(window.scrollY || 0, rangePx);
    element.style.setProperty(variable, progress.toFixed(3));
  }, [forced, rangePx, variable]);

  const attachRef = useCallback(
    (element: T | null) => {
      elementRef.current = element;
      write();
    },
    [write],
  );

  useEffect(() => {
    write();
    // A pinned value has no scroll dependency, so there is nothing to listen for.
    if (forced !== undefined) return undefined;

    let frameId = 0;
    const schedule = () => {
      if (frameId) return;
      frameId = window.requestAnimationFrame(() => {
        frameId = 0;
        write();
      });
    };

    window.addEventListener("scroll", schedule, { passive: true });
    // Orientation changes and the mobile URL bar collapsing resize the viewport
    // without necessarily producing a scroll event.
    window.addEventListener("resize", schedule);
    return () => {
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      if (frameId) window.cancelAnimationFrame(frameId);
    };
  }, [forced, write]);

  return attachRef;
}
