import { type RefObject, useEffect } from "react";

/**
 * What a browser would let Tab land on inside a container, minus anything the
 * UI has explicitly hidden. `[tabindex="-1"]` is excluded because those nodes
 * are programmatically focusable only (dialogs use it for their own container).
 */
const FOCUSABLE_SELECTOR = [
  "a[href]",
  "area[href]",
  "button:not([disabled])",
  "input:not([disabled]):not([type='hidden'])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "summary",
  "audio[controls]",
  "video[controls]",
  "[contenteditable='true']",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

/** Ordered, visible focus targets inside `root`. */
export function focusableWithin(root: HTMLElement): HTMLElement[] {
  return Array.from(
    root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
  ).filter(
    (element) =>
      !element.hasAttribute("hidden") &&
      element.getAttribute("aria-hidden") !== "true" &&
      element.closest('[aria-hidden="true"]') === null,
  );
}

/**
 * Where Tab (or Shift+Tab) should land inside a trapped container.
 *
 * Returns null when the browser's own move is already correct — the trap only
 * intervenes at the two edges, so ordinary in-panel tabbing stays native.
 */
export function nextFocusTarget(
  focusables: readonly HTMLElement[],
  active: Element | null,
  backwards: boolean,
): HTMLElement | null {
  if (focusables.length === 0) {
    return null;
  }
  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  const index = active instanceof HTMLElement ? focusables.indexOf(active) : -1;
  // Focus escaped (or never entered) the panel: pull it back to an edge.
  if (index === -1) {
    return backwards ? last : first;
  }
  if (backwards && index === 0) {
    return last;
  }
  if (!backwards && index === focusables.length - 1) {
    return first;
  }
  return null;
}

/**
 * Keep Tab inside a modal panel while it is open.
 *
 * Only the phone settings sheet is modal (backdrop, scroll lock, portalled above
 * the dock), so only it opts in; the desktop popover is a non-modal popover and
 * must keep letting focus leave. The document-level listener is deliberate: if
 * focus somehow starts outside the panel, the first Tab pulls it back in instead
 * of walking through the page behind the backdrop.
 */
export function useModalFocusTrap(
  active: boolean,
  panelRef: RefObject<HTMLElement | null>,
): void {
  useEffect(() => {
    if (!active) {
      return undefined;
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Tab") {
        return;
      }
      const panel = panelRef.current;
      if (!panel) {
        return;
      }
      const target = nextFocusTarget(
        focusableWithin(panel),
        document.activeElement,
        event.shiftKey,
      );
      if (!target) {
        return;
      }
      event.preventDefault();
      target.focus();
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [active, panelRef]);
}
