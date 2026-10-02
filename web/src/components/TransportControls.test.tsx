import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";

import { TransportControls } from "./TransportControls";

afterEach(cleanup);

function buildProps(overrides: Partial<Parameters<typeof TransportControls>[0]> = {}) {
  return {
    playLabel: "Play",
    showSpinner: false,
    showPauseIcon: false,
    playButtonSizePx: 48,
    playIconSizePx: 16,
    skipButtonSizePx: 36,
    skipIconSizePx: 14,
    gapPx: 8,
    onPlay: vi.fn(),
    onPause: vi.fn(),
    onSkip: vi.fn(),
    ...overrides,
  };
}

describe("TransportControls", () => {
  test("renders back, play and forward", () => {
    render(<TransportControls {...buildProps()} />);

    expect(screen.getByRole("button", { name: "Play" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Back 10 seconds" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Forward 10 seconds" })).toBeInTheDocument();
  });

  test("skips by a signed 10 seconds", () => {
    const onSkip = vi.fn();
    render(<TransportControls {...buildProps({ onSkip })} />);

    fireEvent.click(screen.getByRole("button", { name: "Back 10 seconds" }));
    fireEvent.click(screen.getByRole("button", { name: "Forward 10 seconds" }));

    expect(onSkip).toHaveBeenNthCalledWith(1, -10);
    expect(onSkip).toHaveBeenNthCalledWith(2, 10);
  });

  test("calls onPlay while the control reads Play", () => {
    const onPlay = vi.fn();
    render(<TransportControls {...buildProps({ onPlay })} />);

    fireEvent.click(screen.getByRole("button", { name: "Play" }));
    expect(onPlay).toHaveBeenCalledTimes(1);
  });

  test("calls onPause while the control reads Pause, even before audio starts", () => {
    // A pending play (buffering) shows the pause icon and label; clicking must
    // cancel it rather than firing another activate request.
    const onPause = vi.fn();
    const onPlay = vi.fn();
    render(
      <TransportControls
        {...buildProps({ onPause, onPlay, playLabel: "Pause", showPauseIcon: true, showSpinner: true })}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    expect(onPause).toHaveBeenCalledTimes(1);
    expect(onPlay).not.toHaveBeenCalled();
  });

  test("advertises the keyboard shortcut in the tooltip", () => {
    render(<TransportControls {...buildProps()} />);
    expect(screen.getByRole("button", { name: "Play" })).toHaveAttribute(
      "title",
      "Play (Space or K)",
    );
    expect(screen.getByRole("button", { name: "Back 10 seconds" })).toHaveAttribute(
      "title",
      "Back 10 seconds (←)",
    );
  });

  test("shows a spinner instead of an icon while it spins", () => {
    const { container } = render(<TransportControls {...buildProps({ showSpinner: true })} />);
    expect(container.querySelector(".animate-spin")).not.toBeNull();
  });
});
