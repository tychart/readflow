import { useEffect, useRef } from "react";

/**
 * Page-wide playback keyboard shortcuts.
 *
 * These are deliberately global rather than scoped to the playbar: the reader
 * re-renders ~20x/s during playback and a user should never have to click the
 * controls before the keys work.
 */

/** Step used by the visible −10s / +10s buttons and their shortcuts. */
export const SKIP_STEP_SECONDS = 10;
/** Fine nudge behind Shift+Arrow. */
export const FINE_SKIP_SECONDS = 5;
/** Coarse jump on the vertical arrows. */
export const COARSE_SKIP_SECONDS = 30;

export type PlaybackShortcut = { kind: "toggle" } | { kind: "skip"; deltaSeconds: number };

/** Rows for the shortcuts guide in the reader settings panel. */
export const PLAYBACK_SHORTCUT_GUIDE: ReadonlyArray<{ keys: string; action: string }> = [
  { keys: "Space or K", action: "Play or pause" },
  { keys: "← / →", action: `Back or forward ${SKIP_STEP_SECONDS}s` },
  { keys: "Shift + ← / →", action: `Back or forward ${FINE_SKIP_SECONDS}s` },
  { keys: "↑ / ↓", action: `Forward or back ${COARSE_SKIP_SECONDS}s` },
  { keys: "J / L", action: `Back or forward ${SKIP_STEP_SECONDS}s` },
];

export interface PlaybackShortcutKeyEvent {
  key: string;
  shiftKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
}

/**
 * True when a key event must stay native rather than drive playback: text
 * entry, form widgets, and anything inside an open dialog/popover layer (the
 * settings panel owns the keyboard while it is up).
 */
export function shouldIgnorePlaybackShortcut(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  if (!element || typeof element.tagName !== "string") return false;
  if (element.isContentEditable) return true;
  const tag = element.tagName.toUpperCase();
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || tag === "OPTION") {
    return true;
  }
  return typeof element.closest === "function" && element.closest('[role="dialog"]') !== null;
}

/**
 * Resolve a key event to a playback intent. Pure so the whole key map can be
 * tested without mounting anything.
 *
 * Modified keys are left alone so browser/OS shortcuts still work.
 */
export function resolvePlaybackShortcut(event: PlaybackShortcutKeyEvent): PlaybackShortcut | null {
  if (event.ctrlKey || event.metaKey || event.altKey) return null;

  switch (event.key) {
    case " ":
    case "Spacebar":
    case "k":
    case "K":
      return { kind: "toggle" };
    case "ArrowLeft":
      return { kind: "skip", deltaSeconds: -(event.shiftKey ? FINE_SKIP_SECONDS : SKIP_STEP_SECONDS) };
    case "ArrowRight":
      return { kind: "skip", deltaSeconds: event.shiftKey ? FINE_SKIP_SECONDS : SKIP_STEP_SECONDS };
    case "ArrowUp":
      return { kind: "skip", deltaSeconds: COARSE_SKIP_SECONDS };
    case "ArrowDown":
      return { kind: "skip", deltaSeconds: -COARSE_SKIP_SECONDS };
    case "j":
    case "J":
      return { kind: "skip", deltaSeconds: -SKIP_STEP_SECONDS };
    case "l":
    case "L":
      return { kind: "skip", deltaSeconds: SKIP_STEP_SECONDS };
    default:
      return null;
  }
}

export interface PlaybackShortcutHandlers {
  togglePlay: () => void;
  skipBy: (deltaSeconds: number) => void;
}

/**
 * Bind the shortcut map to the window.
 *
 * Handlers are held in a ref and the listener is attached once: the reader
 * re-renders on every playback tick, so resubscribing per render would add and
 * remove a window listener ~20x/s.
 */
export function usePlaybackShortcuts(handlers: PlaybackShortcutHandlers): void {
  const handlersRef = useRef(handlers);
  useEffect(() => {
    handlersRef.current = handlers;
  });

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (shouldIgnorePlaybackShortcut(event.target)) return;
      const shortcut = resolvePlaybackShortcut(event);
      if (!shortcut) return;

      event.preventDefault();
      // A held Space/K would otherwise toggle playback every repeat.
      if (shortcut.kind === "toggle") {
        if (!event.repeat) handlersRef.current.togglePlay();
        return;
      }
      handlersRef.current.skipBy(shortcut.deltaSeconds);
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);
}
