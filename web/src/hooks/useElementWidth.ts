import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Measure an element's rendered content width.
 *
 * Waveform surfaces size their bar count to the space they actually occupy, so
 * both the main timeline and the reader conveyor need this.
 *
 * The observer is attached from a *callback ref* rather than an effect with
 * `[]` deps. An effect-based version silently stops measuring whenever the
 * measured element is not mounted on the first commit (the reader renders an
 * empty timeline until its first chunk is planned), because the effect never
 * re-runs once the element finally appears.
 *
 * `jsdom` has no `ResizeObserver`; in that environment we take a single
 * measurement at attach time so layout math still has a real width.
 */
export function useElementWidth<T extends HTMLElement = HTMLDivElement>() {
  const elementRef = useRef<T | null>(null);
  const observerRef = useRef<ResizeObserver | null>(null);
  const [width, setWidth] = useState(0);

  const attachRef = useCallback((element: T | null) => {
    observerRef.current?.disconnect();
    observerRef.current = null;
    elementRef.current = element;
    if (!element) return;

    if (typeof ResizeObserver === "undefined") {
      setWidth(Math.round(element.getBoundingClientRect().width));
      return;
    }

    const observer = new ResizeObserver((entries) => {
      const next = entries[0]?.contentRect.width;
      if (next) setWidth(Math.round(next));
    });
    observer.observe(element);
    observerRef.current = observer;
  }, []);

  useEffect(() => () => observerRef.current?.disconnect(), []);

  return { attachRef, elementRef, width };
}
