import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";

import { DEFAULT_READER_SETTINGS, type ReaderSettings } from "../state/reader-settings";
import { ReaderSettingsMenu } from "./ReaderSettingsMenu";

/* jsdom has no PointerEvent; the popover dismisses on a pointer press. */
class TestPointerEvent extends MouseEvent {
  readonly pointerId: number;

  constructor(type: string, init: PointerEventInit = {}) {
    super(type, init);
    this.pointerId = init.pointerId ?? 1;
  }
}

Object.defineProperty(window, "PointerEvent", {
  configurable: true,
  value: TestPointerEvent,
});

afterEach(cleanup);

function buildProps(overrides: Partial<Parameters<typeof ReaderSettingsMenu>[0]> = {}) {
  const settings: ReaderSettings = { ...DEFAULT_READER_SETTINGS, ...overrides.settings };
  return {
    settings,
    onChange: vi.fn(),
    onReset: vi.fn(),
    isOverlay: false,
    showConveyorControls: false,
    ...overrides,
  };
}

function openMenu(props: ReturnType<typeof buildProps>) {
  render(<ReaderSettingsMenu {...props} />);
  fireEvent.click(screen.getByRole("button", { name: "Reader settings" }));
}

describe("ReaderSettingsMenu", () => {
  test("is closed until the gear is pressed, and reports its expanded state", () => {
    render(<ReaderSettingsMenu {...buildProps()} />);
    const gear = screen.getByRole("button", { name: "Reader settings" });

    expect(gear).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    fireEvent.click(gear);
    expect(gear).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  test("lists the playback keyboard shortcuts", () => {
    openMenu(buildProps());
    const guide = screen.getByTestId("shortcut-guide");
    expect(guide).toHaveTextContent("Space or K");
    expect(guide).toHaveTextContent("Play or pause");
    expect(guide).toHaveTextContent("Shift + ← / →");
  });

  test("toggles chunk jump buttons", () => {
    const props = buildProps();
    openMenu(props);

    fireEvent.click(screen.getByLabelText("Show chunk jump buttons"));

    expect(props.onChange).toHaveBeenCalledWith({ showChunkJumpButtons: false });
  });

  test("reflects the stored value of each control", () => {
    openMenu(buildProps({ settings: { showChunkJumpButtons: false } }));
    expect(screen.getByLabelText("Show chunk jump buttons")).not.toBeChecked();
  });

  test("hides conveyor controls until that feature is available", () => {
    openMenu(buildProps({ showConveyorControls: false }));
    expect(screen.queryByLabelText("Show chunk conveyor")).not.toBeInTheDocument();
    expect(screen.queryByText("Playback motion")).not.toBeInTheDocument();
  });

  test("offers conveyor controls, and window sizes only while the conveyor is on", () => {
    const props = buildProps({ showConveyorControls: true });
    openMenu(props);

    fireEvent.click(screen.getByLabelText("Reduced"));
    expect(props.onChange).toHaveBeenCalledWith({ motionMode: "reduced" });

    fireEvent.click(screen.getByLabelText("Always animate"));
    expect(props.onChange).toHaveBeenCalledWith({ motionMode: "always" });

    expect(screen.getByText("Chunks in view")).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("4"));
    expect(props.onChange).toHaveBeenCalledWith({ conveyorWindowSize: 4 });

    cleanup();
    openMenu(buildProps({ showConveyorControls: true, settings: { showConveyor: false } }));
    expect(screen.queryByText("Chunks in view")).not.toBeInTheDocument();
  });

  test("closes on Escape and returns focus to the gear", () => {
    openMenu(buildProps());
    const gear = screen.getByRole("button", { name: "Reader settings" });

    fireEvent.keyDown(document, { key: "Escape" });

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(gear).toHaveFocus();
    expect(gear).toHaveAttribute("aria-expanded", "false");
  });

  test("closes when the close button is pressed", () => {
    openMenu(buildProps());
    fireEvent.click(screen.getByRole("button", { name: "Close settings" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  test("dismisses an anchored popover on an outside press", () => {
    openMenu(buildProps());
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  test("keeps the popover open for a press inside it", () => {
    openMenu(buildProps());
    fireEvent.pointerDown(screen.getByRole("dialog"));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  test("renders the overlay variant as a sheet with a dismissable backdrop", () => {
    const props = buildProps({ isOverlay: true });
    openMenu(props);

    const dialog = screen.getByRole("dialog");
    expect(dialog.className).toContain("bottom-0");

    fireEvent.click(screen.getByTestId("reader-settings-backdrop"));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  test("resets settings on request", () => {
    const props = buildProps();
    openMenu(props);

    fireEvent.click(screen.getByRole("button", { name: "Reset to defaults" }));
    expect(props.onReset).toHaveBeenCalledTimes(1);
  });
});
