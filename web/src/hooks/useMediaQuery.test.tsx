import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";

import { useMediaQuery } from "./useMediaQuery";

type Listener = (event: MediaQueryListEvent) => void;

function stubMatchMedia() {
  const listeners = new Map<string, Set<Listener>>();
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: (_type: string, listener: Listener) => {
      const set = listeners.get(query) ?? new Set<Listener>();
      set.add(listener);
      listeners.set(query, set);
    },
    removeEventListener: (_type: string, listener: Listener) => {
      listeners.get(query)?.delete(listener);
    },
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
  return {
    emit(query: string, matches: boolean) {
      for (const listener of listeners.get(query) ?? []) {
        listener({ matches } as MediaQueryListEvent);
      }
    },
    listenerCount(query: string) {
      return listeners.get(query)?.size ?? 0;
    },
  };
}

const QUERY = "(max-width: 767px)";

function Probe({ initiallyMatches }: { initiallyMatches: boolean }) {
  const matches = useMediaQuery(QUERY, initiallyMatches);
  return <span data-testid="matches">{String(matches)}</span>;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("useMediaQuery", () => {
  test("uses the supplied initial value for the first render", () => {
    stubMatchMedia();
    render(<Probe initiallyMatches />);
    expect(screen.getByTestId("matches")).toHaveTextContent("true");
  });

  test("starts false when the initial value says so", () => {
    stubMatchMedia();
    render(<Probe initiallyMatches={false} />);
    expect(screen.getByTestId("matches")).toHaveTextContent("false");
  });

  test("follows query changes while mounted", () => {
    const media = stubMatchMedia();
    render(<Probe initiallyMatches={false} />);

    act(() => media.emit(QUERY, true));
    expect(screen.getByTestId("matches")).toHaveTextContent("true");

    act(() => media.emit(QUERY, false));
    expect(screen.getByTestId("matches")).toHaveTextContent("false");
  });

  test("unsubscribes on unmount", () => {
    const media = stubMatchMedia();
    const { unmount } = render(<Probe initiallyMatches={false} />);
    expect(media.listenerCount(QUERY)).toBe(1);

    unmount();
    expect(media.listenerCount(QUERY)).toBe(0);
  });
});
