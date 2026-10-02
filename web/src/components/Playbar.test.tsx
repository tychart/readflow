import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";

import type { TimelineSlotData } from "../types/timeline";
import { Playbar, type PlaybarProps } from "./Playbar";

afterEach(cleanup);

const SLOTS: TimelineSlotData[] = [
  { chunkIndex: 0, state: "played", durationSeconds: 4 },
  { chunkIndex: 1, state: "playing", durationSeconds: 4 },
  { chunkIndex: 2, state: "ready", durationSeconds: 4 },
];

function buildProps(overrides: Partial<PlaybarProps> = {}): PlaybarProps {
  return {
    slots: SLOTS,
    waveforms: new Map(),
    renderedDurationSeconds: 12,
    displayTimeSeconds: 5,
    displayDurationSeconds: 12,
    displayRenderedDurationSeconds: 12,
    isPlaying: false,
    playIntent: false,
    isAutoplayBlocked: false,
    isJobTerminal: false,
    isWaitingForData: false,
    canDownload: true,
    isDownloadComplete: false,
    onPlay: vi.fn(),
    onPause: vi.fn(),
    onSkip: vi.fn(),
    onSeekToChunk: vi.fn(),
    onDownload: vi.fn(),
    totalChunks: 3,
    writtenChunks: 3,
    scrollProgress: 0,
    ...overrides,
  };
}

describe("Playbar transport", () => {
  test("renders −10s and +10s buttons with shortcut tooltips", () => {
    render(<Playbar {...buildProps()} />);

    const back = screen.getByRole("button", { name: "Back 10 seconds" });
    const forward = screen.getByRole("button", { name: "Forward 10 seconds" });

    expect(back).toHaveAttribute("title", "Back 10 seconds (←)");
    expect(forward).toHaveAttribute("title", "Forward 10 seconds (→)");
  });

  test("skip buttons report a signed relative offset", () => {
    const onSkip = vi.fn();
    render(<Playbar {...buildProps({ onSkip })} />);

    fireEvent.click(screen.getByRole("button", { name: "Back 10 seconds" }));
    expect(onSkip).toHaveBeenCalledWith(-10);

    fireEvent.click(screen.getByRole("button", { name: "Forward 10 seconds" }));
    expect(onSkip).toHaveBeenCalledWith(10);
  });

  test("play button advertises the keyboard shortcut", () => {
    render(<Playbar {...buildProps()} />);
    expect(screen.getByRole("button", { name: "Play" })).toHaveAttribute(
      "title",
      "Play (Space or K)",
    );
  });

  test("play calls onPlay and a playing bar calls onPause", () => {
    const onPlay = vi.fn();
    const { unmount } = render(<Playbar {...buildProps({ onPlay })} />);
    fireEvent.click(screen.getByRole("button", { name: "Play" }));
    expect(onPlay).toHaveBeenCalledTimes(1);

    unmount();
    const onPause = vi.fn();
    render(<Playbar {...buildProps({ isPlaying: true, playIntent: true, onPause })} />);
    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    expect(onPause).toHaveBeenCalledTimes(1);
  });

  test("offers Resume when autoplay is blocked", () => {
    render(<Playbar {...buildProps({ isAutoplayBlocked: true })} />);
    expect(screen.getByRole("button", { name: "Resume" })).toBeInTheDocument();
  });

  test("shows a spinner instead of an icon while playback is starting", () => {
    const { container } = render(
      <Playbar {...buildProps({ playIntent: true, isWaitingForData: true })} />,
    );
    expect(container.querySelector(".animate-spin")).not.toBeNull();
  });
});

describe("Playbar timeline and metadata", () => {
  test("clicking a chunk seeks to its start in timeline coordinates", () => {
    const onSeekToChunk = vi.fn();
    const { container } = render(<Playbar {...buildProps({ onSeekToChunk })} />);

    const slots = container.querySelectorAll("[data-slot-state]");
    expect(slots).toHaveLength(3);
    fireEvent.click(slots[1]!);

    // Chunk 1 starts after one 4s chunk.
    expect(onSeekToChunk).toHaveBeenCalledWith(1, 4);
  });

  test("shows the clock, chunk counter and download control", () => {
    render(<Playbar {...buildProps()} />);
    expect(screen.getByText("0:05")).toBeInTheDocument();
    expect(screen.getByText("0:12")).toBeInTheDocument();
    expect(screen.getByText("chunks").parentElement).toHaveTextContent("3/3 chunks");
    expect(screen.getByRole("button", { name: /download/i })).toBeInTheDocument();
  });

  test("renders the settings slot so it survives the compact fade", () => {
    render(
      <Playbar
        {...buildProps({
          scrollProgress: 1,
          settingsSlot: <span data-testid="settings-control">gear</span>,
        })}
      />,
    );
    expect(screen.getByTestId("settings-control")).toBeInTheDocument();
  });
});
