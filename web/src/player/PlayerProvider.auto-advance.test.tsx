import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import {
  invalidateReaderSettingsCache,
  resetReaderSettings,
  setReaderSettings,
} from "../state/reader-settings";
import { PlayerProvider } from "./PlayerProvider";
import {
  registerPlayerNavigate,
  resetPlayerStore,
  usePlayerStore,
} from "./player-store";

/**
 * `PlayerProvider` owns the auto-advance decision, but it can only be observed
 * through the media hook. Mocking that hook lets the test drive the one signal
 * the rule uses (`hasEnded`) instead of pretending jsdom decodes AAC — the
 * real hook's end detection is covered in `media-source.test.tsx`.
 */
const media = vi.hoisted(() => ({
  player: null as unknown as Record<string, unknown>,
}));

vi.mock("../lib/media-source", () => ({
  useMediaSourcePlayer: () => media.player,
}));

interface PlayerOverrides {
  hasEnded?: boolean;
  renderedDurationSeconds?: number;
  isActuallyPlaying?: boolean;
}

function makePlayer({
  hasEnded = false,
  renderedDurationSeconds = 30,
  isActuallyPlaying = false,
}: PlayerOverrides = {}): Record<string, unknown> {
  return {
    audioRef: { current: null },
    appendedChunksCount: 1,
    bufferedUntilSeconds: renderedDurationSeconds,
    currentTimeSeconds: renderedDurationSeconds,
    diagnostics: {
      paused: !isActuallyPlaying,
      readyState: 4,
      networkState: 1,
      playbackRate: 1,
    },
    hasEnded,
    isActuallyPlaying,
    isAutoplayBlocked: false,
    isLoadingAudio: false,
    isReady: true,
    isSecondsBehindRetainedAudio: () => false,
    isSecondsLoaded: () => true,
    isStreamPrimed: true,
    isWaitingForData: false,
    lastPlayerError: null,
    pausePlayback: vi.fn(),
    playerState: hasEnded ? "ended" : "ready_paused",
    playbackRate: 1,
    renderedDurationSeconds,
    requestUserGesturePlay: vi.fn(async () => true),
    seekToSeconds: vi.fn(),
    seekWithinBuffered: vi.fn(() => 0),
    setPlaybackRate: vi.fn(),
  };
}

function openTerminalJob(nextJobId: string | null = "job-2") {
  usePlayerStore.getState().openJob({
    id: "job-1",
    title: "First book",
    isTerminal: true,
    audioEpoch: 0,
    folderId: "books",
    nextJobId,
    previousJobId: null,
  });
  usePlayerStore.getState().setSource({
    manifest: null,
    anchorIndex: 0,
    anchorOffsetSeconds: 0,
    durationSeconds: 30,
  });
}

const navigate = vi.fn();

beforeEach(() => {
  resetReaderSettings();
  invalidateReaderSettingsCache();
  registerPlayerNavigate(navigate);
  media.player = makePlayer();
});

afterEach(() => {
  cleanup();
  resetPlayerStore();
  registerPlayerNavigate(null);
  navigate.mockReset();
  vi.clearAllMocks();
});

it("opens the next folder job when playback reaches the end", () => {
  openTerminalJob();
  const { rerender } = render(
    <PlayerProvider>
      <p>reader</p>
    </PlayerProvider>,
  );
  expect(navigate).not.toHaveBeenCalled();

  media.player = makePlayer({ hasEnded: true });
  act(() => {
    rerender(
      <PlayerProvider>
        <p>reader</p>
      </PlayerProvider>,
    );
  });

  expect(navigate).toHaveBeenCalledTimes(1);
  expect(navigate).toHaveBeenCalledWith("/jobs/job-2?play=1");
});

it("does not advance when continuous play is off", () => {
  setReaderSettings({ continuousPlay: false });
  openTerminalJob();
  const { rerender } = render(
    <PlayerProvider>
      <p>reader</p>
    </PlayerProvider>,
  );

  media.player = makePlayer({ hasEnded: true });
  act(() => {
    rerender(
      <PlayerProvider>
        <p>reader</p>
      </PlayerProvider>,
    );
  });

  expect(navigate).not.toHaveBeenCalled();
});

it("does not advance from the end of a job that has no next job", () => {
  openTerminalJob(null);
  const { rerender } = render(
    <PlayerProvider>
      <p>reader</p>
    </PlayerProvider>,
  );

  media.player = makePlayer({ hasEnded: true });
  act(() => {
    rerender(
      <PlayerProvider>
        <p>reader</p>
      </PlayerProvider>,
    );
  });

  expect(navigate).not.toHaveBeenCalled();
});

it("does not advance when a gap stopped the stream before the job's end", () => {
  openTerminalJob();
  const { rerender } = render(
    <PlayerProvider>
      <p>reader</p>
    </PlayerProvider>,
  );

  // The stream could only play 12s of a 30s job (a failed chunk behind it).
  media.player = makePlayer({ hasEnded: true, renderedDurationSeconds: 12 });
  act(() => {
    rerender(
      <PlayerProvider>
        <p>reader</p>
      </PlayerProvider>,
    );
  });

  expect(navigate).not.toHaveBeenCalled();
});
