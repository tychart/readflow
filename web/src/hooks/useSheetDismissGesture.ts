import { type RefObject, useEffect, useRef, useState } from "react";

import { sheetDragOffset, shouldDismissSheet } from "../lib/sheet-gesture";

export interface UseSheetDismissGestureOptions {
  /** Only the mobile bottom sheet drags to dismiss; the desktop popover does not. */
  enabled: boolean;
  /** The scrolling sheet element the gesture is tracked on. */
  panelRef: RefObject<HTMLElement | null>;
  /** Called when the sheet has been swiped far/fast enough down. */
  onDismiss: () => void;
}

export interface SheetDismissGesture {
  /** Current downward offset in px (0 when at rest). */
  offsetPx: number;
  /** True while a finger is actively dragging the sheet. */
  isDragging: boolean;
}

interface DragState {
  startY: number;
  lastY: number;
  lastAt: number;
  /** Speed of the most recent move sample (px/ms, downward positive). */
  velocityPxPerMs: number;
}

/**
 * Swipe-down-to-close for the phone settings sheet.
 *
 * Implemented with touch events rather than pointer events on purpose: the sheet
 * is a scrollable panel, so a downward pan normally belongs to the browser (it
 * would scroll — and then chain to the page behind). A non-passive `touchmove`
 * that calls `preventDefault()` while the panel is scrolled to the top takes the
 * gesture back for the drag, which is the only reliable way to get both "the
 * panel scrolls" and "swiping down closes it".
 *
 * A gesture only arms when the panel is already at its top, so scrolling long
 * settings content is untouched; an upward move abandons the drag and hands the
 * rest of the gesture back to native scrolling.
 */
export function useSheetDismissGesture({
  enabled,
  panelRef,
  onDismiss,
}: UseSheetDismissGestureOptions): SheetDismissGesture {
  const [offsetPx, setOffsetPx] = useState(0);
  const [isDragging, setIsDragging] = useState(false);
  const dragRef = useRef<DragState | null>(null);

  useEffect(() => {
    if (!enabled) {
      dragRef.current = null;
      setOffsetPx(0);
      setIsDragging(false);
      return undefined;
    }

    const panel = panelRef.current;
    if (!panel) return undefined;

    const cancelDrag = () => {
      dragRef.current = null;
      setIsDragging(false);
      setOffsetPx(0);
    };

    const handleTouchStart = (event: TouchEvent) => {
      // A multi-finger gesture is a zoom or a scroll, not a dismissal.
      if (event.touches.length !== 1) {
        cancelDrag();
        return;
      }
      // Mid-list: the gesture belongs to the panel's own scrolling.
      if (panel.scrollTop > 0) {
        dragRef.current = null;
        return;
      }
      const touch = event.touches[0];
      dragRef.current = {
        startY: touch.clientY,
        lastY: touch.clientY,
        lastAt: event.timeStamp,
        velocityPxPerMs: 0,
      };
      setIsDragging(true);
    };

    const handleTouchMove = (event: TouchEvent) => {
      const drag = dragRef.current;
      const touch = event.touches[0];
      if (!drag || !touch) return;

      const deltaY = touch.clientY - drag.startY;
      if (deltaY <= 0) {
        // Upward: hand the gesture back to native scrolling.
        cancelDrag();
        return;
      }

      // Keep the page and the panel still; the sheet follows the finger instead.
      if (event.cancelable) event.preventDefault();
      // The *sample-to-sample* speed is what a flick is: by the time touchend
      // arrives the finger has not moved since the last touchmove.
      drag.velocityPxPerMs =
        (touch.clientY - drag.lastY) / Math.max(1, event.timeStamp - drag.lastAt);
      drag.lastY = touch.clientY;
      drag.lastAt = event.timeStamp;
      setOffsetPx(sheetDragOffset(deltaY));
    };

    const handleTouchEnd = (event: TouchEvent) => {
      const drag = dragRef.current;
      dragRef.current = null;
      setIsDragging(false);
      if (!drag) return;

      const touch = event.changedTouches[0];
      const endY = touch?.clientY ?? drag.lastY;

      setOffsetPx(0);
      if (
        shouldDismissSheet({
          deltaY: sheetDragOffset(endY - drag.startY),
          sheetHeightPx: panel.offsetHeight,
          velocityPxPerMs: drag.velocityPxPerMs,
        })
      ) {
        onDismiss();
      }
    };

    panel.addEventListener("touchstart", handleTouchStart, { passive: true });
    panel.addEventListener("touchmove", handleTouchMove, { passive: false });
    panel.addEventListener("touchend", handleTouchEnd, { passive: true });
    panel.addEventListener("touchcancel", cancelDrag, { passive: true });
    return () => {
      panel.removeEventListener("touchstart", handleTouchStart);
      panel.removeEventListener("touchmove", handleTouchMove);
      panel.removeEventListener("touchend", handleTouchEnd);
      panel.removeEventListener("touchcancel", cancelDrag);
    };
  }, [enabled, onDismiss, panelRef]);

  return { offsetPx, isDragging };
}
