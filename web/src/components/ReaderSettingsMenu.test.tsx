import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, test, vi } from "vitest";
import { focusableWithin } from "../hooks/useModalFocusTrap";
import {
  DEFAULT_READER_SETTINGS,
  type ReaderSettings,
} from "../state/reader-settings";
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

type MenuProps = Parameters<typeof ReaderSettingsMenu>[0];

function buildProps({
  settings,
  ...overrides
}: Partial<Omit<MenuProps, "settings">> & {
  settings?: Partial<ReaderSettings>;
} = {}): MenuProps {
  return {
    onChange: vi.fn(),
    onReset: vi.fn(),
    playbackRate: 1,
    onPlaybackRateChange: vi.fn(),
    isOverlay: false,
    showConveyorControls: false,
    ...overrides,
    settings: { ...DEFAULT_READER_SETTINGS, ...settings },
  };
}

/**
 * jsdom has no `TouchEvent`, so dispatch a touch event with the fields the sheet
 * gesture reads (`touches` / `changedTouches` / `timeStamp`).
 */
function dispatchTouch(
  target: Element,
  type: "touchstart" | "touchmove" | "touchend",
  clientY: number,
  at: number,
) {
  const touch = { clientX: 0, clientY, identifier: 0, target };
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "touches", {
    value: type === "touchend" ? [] : [touch],
  });
  Object.defineProperty(event, "changedTouches", { value: [touch] });
  Object.defineProperty(event, "timeStamp", { value: at });
  // The gesture handler is a native listener, so flush React's work per event.
  act(() => {
    target.dispatchEvent(event);
  });
  return event;
}

/**
 * Drag the sheet header from `startY` to `endY` in two samples `stepMs` apart, so
 * the release velocity is (endY - startY) / (2 * stepMs).
 */
function swipeSheet(panel: Element, startY: number, endY: number, stepMs = 16) {
  const midY = startY + (endY - startY) / 2;
  dispatchTouch(panel, "touchstart", startY, 0);
  dispatchTouch(panel, "touchmove", midY, stepMs);
  dispatchTouch(panel, "touchmove", endY, stepMs * 2);
  dispatchTouch(panel, "touchend", endY, stepMs * 2);
}

/** The panel links to the library and trash, so it needs router context. */
function renderMenu(ui: React.ReactElement) {
  return render(<MemoryRouter>{ui}</MemoryRouter>);
}

function openMenu(props: ReturnType<typeof buildProps>) {
  renderMenu(<ReaderSettingsMenu {...props} />);
  fireEvent.click(screen.getByRole("button", { name: "Reader settings" }));
}

describe("ReaderSettingsMenu", () => {
  test("is closed until the gear is pressed, and reports its expanded state", () => {
    renderMenu(<ReaderSettingsMenu {...buildProps()} />);
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

    expect(props.onChange).toHaveBeenCalledWith({
      showChunkJumpButtons: false,
    });
  });

  test("reflects the stored value of each control", () => {
    openMenu(buildProps({ settings: { showChunkJumpButtons: false } }));
    expect(screen.getByLabelText("Show chunk jump buttons")).not.toBeChecked();
  });

  test("hides conveyor controls until that feature is available", () => {
    openMenu(buildProps({ showConveyorControls: false }));
    expect(
      screen.queryByLabelText("Show chunk conveyor"),
    ).not.toBeInTheDocument();
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
    openMenu(
      buildProps({
        showConveyorControls: true,
        settings: { showConveyor: false },
      }),
    );
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

  test("edits playback speed in the panel, including the one-tap presets", () => {
    const props = buildProps({ playbackRate: 1.5 });
    openMenu(props);

    // The rate is player state passed in, not part of the persisted settings patch.
    expect(screen.getByRole("button", { name: "1.5×" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(
      screen.getByRole("textbox", { name: /playback speed value/i }),
    ).toHaveValue("1.5");

    fireEvent.click(screen.getByRole("button", { name: "2×" }));
    expect(props.onPlaybackRateChange).toHaveBeenCalledWith(2);
    expect(props.onChange).not.toHaveBeenCalled();
  });

  test("resetting settings does not silently change the live speed", () => {
    const props = buildProps({ playbackRate: 1.75 });
    openMenu(props);

    fireEvent.click(screen.getByRole("button", { name: "Reset to defaults" }));

    // The reader re-applies the stored default through the settings subscription;
    // the menu itself only reports the reset.
    expect(props.onReset).toHaveBeenCalled();
    expect(props.onPlaybackRateChange).not.toHaveBeenCalled();
  });
});

describe("ReaderSettingsMenu phone sheet", () => {
  function openSheet() {
    openMenu(buildProps({ isOverlay: true }));
    return screen.getByRole("dialog", { name: "Reader settings" });
  }

  test("locks the page behind the sheet and restores it on close", () => {
    openSheet();
    expect(document.body.style.overflow).toBe("hidden");

    fireEvent.click(screen.getByRole("button", { name: "Close settings" }));
    expect(document.body.style.overflow).toBe("");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  test("the desktop popover leaves the page scrollable", () => {
    openMenu(buildProps({ isOverlay: false }));
    expect(document.body.style.overflow).toBe("");
  });

  test("portals the sheet out of the playbar's stacking context", () => {
    const panel = openSheet();

    // Inline, the sheet inherited the sticky playbar's `z-30` context, so the
    // phone dock (z-40) painted over it and cut off its bottom controls.
    expect(panel.parentElement).toBe(document.body);
    // The popover is anchored to its trigger, so it must stay put.
    cleanup();
    openMenu(buildProps({ isOverlay: false }));
    expect(screen.getByRole("dialog").parentElement).not.toBe(document.body);
  });

  test("reserves the phone safe area and a dynamic viewport height", () => {
    const panel = openSheet();

    expect(panel.style.paddingBottom).toContain("safe-area-inset-bottom");
    expect(panel.style.maxHeight).toBe("70dvh");
  });

  test("dragging down moves the sheet with the finger", () => {
    const panel = openSheet();

    dispatchTouch(panel, "touchstart", 400, 0);
    dispatchTouch(panel, "touchmove", 460, 16);

    expect(panel.style.transform).toBe("translateY(60px)");
  });

  test("a long downward swipe closes the sheet without touching the close button", () => {
    const panel = openSheet();

    swipeSheet(panel, 400, 520, 120);

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  test("a short slow nudge springs back and keeps the sheet open", () => {
    const panel = openSheet();

    // 30px over ~320ms is neither far nor fast enough.
    swipeSheet(panel, 400, 430, 160);

    expect(panel.style.transform).toBe("");
    expect(
      screen.getByRole("dialog", { name: "Reader settings" }),
    ).toBeInTheDocument();
  });

  test("a short fast flick closes the sheet", () => {
    const panel = openSheet();

    // 48px in ~32ms: under the distance threshold, but thrown.
    swipeSheet(panel, 400, 448, 16);

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  test("the sheet's own scrolling is untouched when it is not at the top", () => {
    const panel = openSheet();
    panel.scrollTop = 40;

    dispatchTouch(panel, "touchstart", 400, 0);
    dispatchTouch(panel, "touchmove", 520, 16);
    dispatchTouch(panel, "touchend", 520, 32);

    expect(panel.style.transform).toBe("");
    expect(
      screen.getByRole("dialog", { name: "Reader settings" }),
    ).toBeInTheDocument();
  });

  test("declares itself modal only when it renders as the phone sheet", () => {
    openSheet();
    expect(screen.getByRole("dialog")).toHaveAttribute("aria-modal", "true");

    cleanup();
    openMenu(buildProps({ isOverlay: false }));
    expect(screen.getByRole("dialog")).not.toHaveAttribute("aria-modal");
  });

  test("keeps Tab inside the sheet, wrapping at both ends", () => {
    const panel = openSheet();
    const focusables = focusableWithin(panel);
    expect(focusables.length).toBeGreaterThan(1);

    const last = focusables[focusables.length - 1];
    last.focus();
    const forward = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "Tab",
    });
    document.dispatchEvent(forward);

    expect(forward.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(focusables[0]);

    const backwards = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "Tab",
      shiftKey: true,
    });
    document.dispatchEvent(backwards);

    expect(backwards.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(last);
  });

  test("leaves in-panel tabbing to the browser", () => {
    const panel = openSheet();
    const focusables = focusableWithin(panel);
    focusables[0].focus();

    const event = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "Tab",
    });
    document.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(focusables[0]);
  });

  test("dismissing with the backdrop returns focus to the gear", () => {
    openSheet();
    const gear = screen.getByRole("button", { name: "Reader settings" });

    fireEvent.click(screen.getByTestId("reader-settings-backdrop"));

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(document.activeElement).toBe(gear);
  });

  test("swiping the sheet away returns focus to the gear", () => {
    const panel = openSheet();
    const gear = screen.getByRole("button", { name: "Reader settings" });

    swipeSheet(panel, 400, 520, 120);

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(document.activeElement).toBe(gear);
  });

  test("an upward drag is left to the panel instead of dismissing", () => {
    const panel = openSheet();

    dispatchTouch(panel, "touchstart", 400, 0);
    dispatchTouch(panel, "touchmove", 340, 16);
    dispatchTouch(panel, "touchmove", 300, 32);
    dispatchTouch(panel, "touchend", 300, 32);

    expect(panel.style.transform).toBe("");
    expect(
      screen.getByRole("dialog", { name: "Reader settings" }),
    ).toBeInTheDocument();
  });
});

test("offers continuous play and links into the library", () => {
  const props = buildProps({ settings: { continuousPlay: false } });
  openMenu(props);

  const continuous = screen.getByLabelText("Continuous play");
  expect(continuous).not.toBeChecked();
  fireEvent.click(continuous);
  expect(props.onChange).toHaveBeenCalledWith({ continuousPlay: true });

  expect(screen.getByRole("link", { name: "Open library" })).toHaveAttribute(
    "href",
    "/",
  );
  expect(screen.getByRole("link", { name: "Trash" })).toHaveAttribute(
    "href",
    "/trash",
  );
});
