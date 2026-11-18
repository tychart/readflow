import { render } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { useReaderFollow } from "./useReaderFollow";

const scrollTo = vi.fn();

function FollowHarness({
  enabled,
  onPause,
  activeChunkProgress = 0,
}: {
  enabled: boolean;
  onPause: () => void;
  activeChunkProgress?: number;
}) {
  const chunkRefs = useRef(new Map<number, HTMLDivElement>());
  const chromeRef = useRef<HTMLDivElement>(null);

  useReaderFollow({
    enabled,
    activeChunkIndex: 4,
    activeChunkProgress,
    chunkRefs,
    chromeRef,
    bottomInset: 24,
    motion: "animated",
    onPause,
  });

  return (
    <>
      <div
        ref={(element) => {
          chromeRef.current = element;
          if (element) {
            element.getBoundingClientRect = () => new DOMRect(0, 0, 1, 160);
          }
        }}
      />
      <div
        ref={(element) => {
          if (element) {
            element.getBoundingClientRect = () =>
              new DOMRect(0, 1_000 - window.scrollY, 400, 400);
            chunkRefs.current.set(4, element);
          } else {
            chunkRefs.current.delete(4);
          }
        }}
      />
    </>
  );
}

describe("useReaderFollow", () => {
  beforeEach(() => {
    scrollTo.mockReset();
    vi.stubGlobal("scrollTo", scrollTo);
    Object.defineProperty(window, "innerHeight", {
      configurable: true,
      value: 800,
    });
    Object.defineProperty(window, "scrollY", {
      configurable: true,
      value: 0,
    });
    Object.defineProperty(document.documentElement, "scrollHeight", {
      configurable: true,
      value: 5_000,
    });
  });

  afterEach(() => {
    delete (document.documentElement as { scrollHeight?: number }).scrollHeight;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  test("aligns the active chunk when smart follow starts", () => {
    render(<FollowHarness enabled onPause={vi.fn()} />);

    expect(scrollTo).toHaveBeenCalledWith({
      top: 605.92,
      behavior: "smooth",
    });
  });

  test("waits for native smooth scrolling to finish before choosing another target", () => {
    const { rerender } = render(<FollowHarness enabled onPause={vi.fn()} />);
    expect(scrollTo).toHaveBeenCalledTimes(1);

    // Playback may advance while a long initial mobile movement is still in
    // flight. It must not retarget that browser animation by elapsed time.
    rerender(
      <FollowHarness activeChunkProgress={1} enabled onPause={vi.fn()} />,
    );
    expect(scrollTo).toHaveBeenCalledTimes(1);

    Object.defineProperty(window, "scrollY", {
      configurable: true,
      value: 605.92,
    });
    window.dispatchEvent(new Event("scroll"));
    rerender(
      <FollowHarness activeChunkProgress={0.99} enabled onPause={vi.fn()} />,
    );
    expect(scrollTo).toHaveBeenCalledTimes(2);
  });

  test("immediately pauses for direct user scroll intent", () => {
    const onPause = vi.fn();
    render(<FollowHarness enabled onPause={onPause} />);

    window.dispatchEvent(new WheelEvent("wheel"));
    expect(onPause).toHaveBeenCalledOnce();
  });

  test("does not intercept reader navigation while paused", () => {
    const onPause = vi.fn();
    render(<FollowHarness enabled={false} onPause={onPause} />);

    window.dispatchEvent(new WheelEvent("wheel"));
    expect(onPause).not.toHaveBeenCalled();
  });
});
