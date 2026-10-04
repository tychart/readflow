import { describe, expect, test } from "vitest";

import {
  isRenderingStalled,
  resolvePlayButtonLabel,
  resolvePlayerStateLabel,
  resolveShowSpinner,
  type PlayerStateInput,
} from "./transport";

const IDLE = {
  isAutoplayBlocked: false,
  isJobTerminal: false,
  isPlaying: false,
  isWaitingForData: false,
  playIntent: false,
};

describe("resolvePlayButtonLabel", () => {
  test("play, pause and resume", () => {
    expect(resolvePlayButtonLabel(IDLE)).toBe("Play");
    expect(resolvePlayButtonLabel({ ...IDLE, playIntent: true })).toBe("Pause");
    expect(resolvePlayButtonLabel({ ...IDLE, isAutoplayBlocked: true })).toBe("Resume");
  });

  test("a blocked autoplay prompt wins over a pending play", () => {
    expect(
      resolvePlayButtonLabel({ ...IDLE, isAutoplayBlocked: true, playIntent: true }),
    ).toBe("Resume");
  });
});

describe("resolveShowSpinner", () => {
  test("spins while a play request has not produced audio yet", () => {
    expect(resolveShowSpinner({ ...IDLE, playIntent: true })).toBe(true);
  });

  test("spins while buffering even with no pending play", () => {
    expect(resolveShowSpinner({ ...IDLE, isWaitingForData: true })).toBe(true);
  });

  test("does not spin when idle, playing, or blocked", () => {
    expect(resolveShowSpinner(IDLE)).toBe(false);
    expect(resolveShowSpinner({ ...IDLE, isPlaying: true })).toBe(false);
    expect(resolveShowSpinner({ ...IDLE, isAutoplayBlocked: true, playIntent: true })).toBe(false);
  });
});

describe("resolvePlayerStateLabel", () => {
  const base: PlayerStateInput = {
    ...IDLE,
    displayTimeSeconds: 0,
    displayDurationSeconds: 120,
    renderedDurationSeconds: 0,
  };

  test("blocked autoplay is reported first", () => {
    expect(
      resolvePlayerStateLabel({ ...base, isAutoplayBlocked: true, playIntent: true }),
    ).toBe("Playback blocked by browser");
  });

  test("a finished terminal job reads as complete", () => {
    expect(
      resolvePlayerStateLabel({
        ...base,
        displayDurationSeconds: 120,
        displayTimeSeconds: 120,
        isJobTerminal: true,
        renderedDurationSeconds: 120,
      }),
    ).toBe("Playback complete");
  });

  test("playing", () => {
    expect(resolvePlayerStateLabel({ ...base, isPlaying: true })).toBe("Playing");
  });

  test("buffering once a stream exists", () => {
    expect(
      resolvePlayerStateLabel({
        ...base,
        isWaitingForData: true,
        playIntent: true,
        renderedDurationSeconds: 30,
      }),
    ).toBe("Buffering…");
  });

  test("preparing before any audio is rendered, then starting", () => {
    expect(resolvePlayerStateLabel({ ...base, playIntent: true })).toBe("Preparing stream…");
    expect(resolvePlayerStateLabel({ ...base, playIntent: true, renderedDurationSeconds: 30 })).toBe(
      "Starting…",
    );
  });

  test("idle", () => {
    expect(resolvePlayerStateLabel(base)).toBe("Ready");
  });
});

describe("isRenderingStalled", () => {
  const waiting = {
    isJobTerminal: false,
    playIntent: true,
    isWaitingForData: true,
  };

  test("stalls only once the threshold is crossed while starved", () => {
    expect(isRenderingStalled(waiting, 24.9)).toBe(false);
    expect(isRenderingStalled(waiting, 25)).toBe(true);
    expect(isRenderingStalled(waiting, 600)).toBe(true);
  });

  test("a terminal job never reports a stall", () => {
    expect(isRenderingStalled({ ...waiting, isJobTerminal: true }, 600)).toBe(false);
  });

  test("not stalled when the user is not trying to play", () => {
    expect(isRenderingStalled({ ...waiting, playIntent: false }, 600)).toBe(false);
  });

  test("not stalled while audio is actually flowing", () => {
    expect(isRenderingStalled({ ...waiting, isWaitingForData: false }, 600)).toBe(false);
  });

  test("no chunk yet (null) is not a stall", () => {
    expect(isRenderingStalled(waiting, null)).toBe(false);
  });
});
