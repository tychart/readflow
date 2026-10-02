import { useEffect, useState } from "react";

/**
 * Track a CSS media query.
 *
 * `initiallyMatches` is passed in rather than read from `matchMedia` because
 * jsdom reports every query as non-matching; deriving the first render from
 * `window.innerWidth` keeps the initial layout agreeing with the CSS
 * breakpoints in tests as well as browsers. After mount the real query is the
 * source of truth.
 */
export function useMediaQuery(query: string, initiallyMatches: boolean): boolean {
  const [matches, setMatches] = useState(initiallyMatches);

  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const list = window.matchMedia(query);
    const handleChange = (event: MediaQueryListEvent) => setMatches(event.matches);
    list.addEventListener("change", handleChange);
    return () => list.removeEventListener("change", handleChange);
  }, [query]);

  return matches;
}
