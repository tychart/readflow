import { render } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { useReaderFollow } from "./useReaderFollow";

const scrollTo = vi.fn();

function FollowHarness({
  enabled,
  onPause,
}: {
  enabled: boolean;
  onPause: () => void;
}) {
  const chunkRefs = useRef(new Map<number, HTMLDivElement>());
  const chromeRef = useRef<HTMLDivElement>(null);

  useReaderFollow({
    enabled,
    activeChunkIndex: 4,
    activeChunkProgress: 0,
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
              new DOMRect(0, 1_000, 400, 400);
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
  });

  afterEach(() => vi.unstubAllGlobals());

  test("aligns the active chunk when smart follow starts", () => {
    render(<FollowHarness enabled onPause={vi.fn()} />);

    expect(scrollTo).toHaveBeenCalledWith({
      top: 605.92,
      behavior: "smooth",
    });
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
