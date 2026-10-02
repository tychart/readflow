import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  COARSE_SKIP_SECONDS,
  FINE_SKIP_SECONDS,
  PLAYBACK_SHORTCUT_GUIDE,
  resolvePlaybackShortcut,
  shouldIgnorePlaybackShortcut,
  SKIP_STEP_SECONDS,
  usePlaybackShortcuts,
} from "./usePlaybackShortcuts";

afterEach(cleanup);

/* ── Pure key resolution ──────────────────────────────────── */

function keyEvent(key: string, modifiers: Partial<Record<"shiftKey" | "ctrlKey" | "metaKey" | "altKey", boolean>> = {}) {
  return {
    key,
    shiftKey: false,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    ...modifiers,
  };
}

describe("resolvePlaybackShortcut", () => {
  test("Space and K toggle playback", () => {
    expect(resolvePlaybackShortcut(keyEvent(" "))).toEqual({ kind: "toggle" });
    expect(resolvePlaybackShortcut(keyEvent("k"))).toEqual({ kind: "toggle" });
    expect(resolvePlaybackShortcut(keyEvent("K"))).toEqual({ kind: "toggle" });
  });

  test("horizontal arrows skip by the visible 10s step", () => {
    expect(resolvePlaybackShortcut(keyEvent("ArrowLeft"))).toEqual({
      kind: "skip",
      deltaSeconds: -SKIP_STEP_SECONDS,
    });
    expect(resolvePlaybackShortcut(keyEvent("ArrowRight"))).toEqual({
      kind: "skip",
      deltaSeconds: SKIP_STEP_SECONDS,
    });
  });

  test("Shift turns the horizontal arrows into a 5s nudge", () => {
    expect(resolvePlaybackShortcut(keyEvent("ArrowRight", { shiftKey: true }))).toEqual({
      kind: "skip",
      deltaSeconds: FINE_SKIP_SECONDS,
    });
    expect(resolvePlaybackShortcut(keyEvent("ArrowLeft", { shiftKey: true }))).toEqual({
      kind: "skip",
      deltaSeconds: -FINE_SKIP_SECONDS,
    });
  });

  test("vertical arrows jump a coarse 30s", () => {
    expect(resolvePlaybackShortcut(keyEvent("ArrowUp"))).toEqual({
      kind: "skip",
      deltaSeconds: COARSE_SKIP_SECONDS,
    });
    expect(resolvePlaybackShortcut(keyEvent("ArrowDown"))).toEqual({
      kind: "skip",
      deltaSeconds: -COARSE_SKIP_SECONDS,
    });
  });

  test("J and L mirror the 10s skip", () => {
    expect(resolvePlaybackShortcut(keyEvent("j"))).toEqual({
      kind: "skip",
      deltaSeconds: -SKIP_STEP_SECONDS,
    });
    expect(resolvePlaybackShortcut(keyEvent("L"))).toEqual({
      kind: "skip",
      deltaSeconds: SKIP_STEP_SECONDS,
    });
  });

  test("leaves modified chords and unrelated keys alone", () => {
    expect(resolvePlaybackShortcut(keyEvent(" ", { metaKey: true }))).toBeNull();
    expect(resolvePlaybackShortcut(keyEvent("ArrowRight", { ctrlKey: true }))).toBeNull();
    expect(resolvePlaybackShortcut(keyEvent("ArrowUp", { altKey: true }))).toBeNull();
    expect(resolvePlaybackShortcut(keyEvent("a"))).toBeNull();
    expect(resolvePlaybackShortcut(keyEvent("Enter"))).toBeNull();
  });

  test("documents the same numbers the guide advertises", () => {
    expect(PLAYBACK_SHORTCUT_GUIDE.map((entry) => entry.keys)).toEqual([
      "Space or K",
      "← / →",
      "Shift + ← / →",
      "↑ / ↓",
      "J / L",
    ]);
    expect(PLAYBACK_SHORTCUT_GUIDE.some((entry) => entry.action.includes("10s"))).toBe(true);
  });
});

describe("shouldIgnorePlaybackShortcut", () => {
  test("ignores text entry and form widgets", () => {
    const input = document.createElement("input");
    const textarea = document.createElement("textarea");
    const select = document.createElement("select");
    const editable = document.createElement("div");
    Object.defineProperty(editable, "isContentEditable", { value: true });

    expect(shouldIgnorePlaybackShortcut(input)).toBe(true);
    expect(shouldIgnorePlaybackShortcut(textarea)).toBe(true);
    expect(shouldIgnorePlaybackShortcut(select)).toBe(true);
    expect(shouldIgnorePlaybackShortcut(editable)).toBe(true);
  });

  test("ignores anything inside an open dialog layer", () => {
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    const button = document.createElement("button");
    dialog.appendChild(button);
    document.body.appendChild(dialog);

    expect(shouldIgnorePlaybackShortcut(button)).toBe(true);
    dialog.remove();
  });

  test("allows the document, plain elements and window", () => {
    expect(shouldIgnorePlaybackShortcut(document.body)).toBe(false);
    expect(shouldIgnorePlaybackShortcut(document.createElement("div"))).toBe(false);
    expect(shouldIgnorePlaybackShortcut(window)).toBe(false);
    expect(shouldIgnorePlaybackShortcut(null)).toBe(false);
  });
});

/* ── Window binding ───────────────────────────────────────── */

function Probe({ onToggle, onSkip }: { onToggle: () => void; onSkip: (delta: number) => void }) {
  usePlaybackShortcuts({ togglePlay: onToggle, skipBy: onSkip });
  return (
    <div>
      <input data-testid="field" />
      <div role="dialog">
        <button data-testid="dialog-button" type="button">
          in dialog
        </button>
      </div>
    </div>
  );
}

describe("usePlaybackShortcuts", () => {
  let onToggle: ReturnType<typeof vi.fn>;
  let onSkip: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    onToggle = vi.fn();
    onSkip = vi.fn();
    render(<Probe onSkip={onSkip} onToggle={onToggle} />);
  });

  test("works with nothing focused, without needing the controls clicked", () => {
    fireEvent.keyDown(window, { key: " " });
    expect(onToggle).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(onSkip).toHaveBeenCalledWith(SKIP_STEP_SECONDS);
  });

  test("prevents the browser default for handled keys", () => {
    expect(fireEvent.keyDown(window, { key: "ArrowRight" })).toBe(false);
    expect(fireEvent.keyDown(window, { key: "a" })).toBe(true);
  });

  test("does not fire while typing in a field", () => {
    fireEvent.keyDown(screen.getByTestId("field"), { key: " " });
    fireEvent.keyDown(screen.getByTestId("field"), { key: "ArrowRight" });
    expect(onToggle).not.toHaveBeenCalled();
    expect(onSkip).not.toHaveBeenCalled();
  });

  test("does not fire from inside an open settings dialog", () => {
    fireEvent.keyDown(screen.getByTestId("dialog-button"), { key: " " });
    expect(onToggle).not.toHaveBeenCalled();
  });

  test("ignores auto-repeat for the play/pause toggle but not for seeking", () => {
    fireEvent.keyDown(window, { key: " ", repeat: true });
    expect(onToggle).not.toHaveBeenCalled();

    fireEvent.keyDown(window, { key: "ArrowRight", repeat: true });
    expect(onSkip).toHaveBeenCalledWith(SKIP_STEP_SECONDS);
  });

  test("detaches the window listener on unmount", () => {
    cleanup();
    fireEvent.keyDown(window, { key: " " });
    expect(onToggle).not.toHaveBeenCalled();
  });
});
