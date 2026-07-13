import { render } from "@testing-library/react";
import { createRef } from "react";
import { describe, expect, test, vi } from "vitest";

import { SpeedSyncedAudio } from "./SpeedSyncedAudio";

beforeEach(() => {
  Object.defineProperty(HTMLMediaElement.prototype, "playbackRate", {
    configurable: true,
    value: 1,
    writable: true,
  });
  Object.defineProperty(HTMLMediaElement.prototype, "defaultPlaybackRate", {
    configurable: true,
    value: 1,
    writable: true,
  });
});

describe("SpeedSyncedAudio", () => {
  test("renders an audio element and sets the ref", () => {
    const ref = createRef<HTMLAudioElement | null>();
    const { container } = render(
      <SpeedSyncedAudio audioRef={ref} playbackRate={1.0} />,
    );

    const audio = container.querySelector("audio");
    expect(audio).toBeInTheDocument();
    expect(ref.current).toBe(audio);
  });

  test("applies playbackRate and defaultPlaybackRate on mount", () => {
    const ref = createRef<HTMLAudioElement | null>();
    render(
      <SpeedSyncedAudio audioRef={ref} playbackRate={2.0} />,
    );

    expect(ref.current!.playbackRate).toBe(2.0);
    expect(ref.current!.defaultPlaybackRate).toBe(2.0);
  });

  test("updates playbackRate when prop changes", () => {
    const ref = createRef<HTMLAudioElement | null>();
    const { rerender } = render(
      <SpeedSyncedAudio audioRef={ref} playbackRate={1.0} />,
    );

    expect(ref.current!.playbackRate).toBe(1.0);

    rerender(<SpeedSyncedAudio audioRef={ref} playbackRate={1.5} />);

    // The inline callback ref runs on every render, so playbackRate
    // should be updated immediately
    expect(ref.current!.playbackRate).toBe(1.5);
    expect(ref.current!.defaultPlaybackRate).toBe(1.5);
  });

  test("forwards standard audio props to the native element", () => {
    const ref = createRef<HTMLAudioElement | null>();
    const { container } = render(
      <SpeedSyncedAudio
        aria-hidden="true"
        audioRef={ref}
        className="hidden"
        id="test-audio"
        playbackRate={1.0}
      />,
    );

    const audio = container.querySelector("audio");
    expect(audio).toHaveAttribute("aria-hidden", "true");
    expect(audio).toHaveClass("hidden");
    expect(audio).toHaveAttribute("id", "test-audio");
  });

  test("applies the latest playbackRate even with rapid mounting", () => {
    const ref = createRef<HTMLAudioElement | null>();

    // Simulate the parent re-rendering many times
    for (let i = 0; i < 5; i++) {
      render(
        <SpeedSyncedAudio audioRef={ref} playbackRate={i + 1} />,
      );
      // Each render creates a new SpeedSyncedAudio instance because
      // we're rendering to a fresh container
    }

    // The last render should have the last playbackRate
    // (Each render creates a separate container so this tests
    // individual instance behavior, not re-render.)
    expect(ref.current!.playbackRate).toBe(5);
    expect(ref.current!.defaultPlaybackRate).toBe(5);
  });
});
