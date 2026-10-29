/**
 * Drag-to-dismiss math for the reader settings sheet.
 *
 * Pure so the thresholds are describable and testable without a DOM: the mobile
 * sheet only needs "how far has it moved", "does releasing here close it" and
 * "how faded should the backdrop be".
 */

/** Downward travel (px) that always dismisses, even for a slow drag. */
export const SHEET_DISMISS_MIN_PX = 80;

/** Share of the sheet's own height that also counts as "far enough". */
export const SHEET_DISMISS_FRACTION = 0.25;

/** Downward release speed (px/ms) at which a shorter flick still dismisses. */
export const SHEET_DISMISS_VELOCITY_PX_PER_MS = 0.5;

/** Travel over which the backdrop fades from fully dark to its dimmest. */
export const SHEET_BACKDROP_FADE_PX = 280;

/** How transparent the backdrop may get while the sheet is being dragged. */
const SHEET_BACKDROP_MIN_OPACITY = 0.15;

/**
 * Downward translation for the sheet. Dragging *up* never lifts it, so a
 * downward drag from the top of the panel reads as "put it back".
 */
export function sheetDragOffset(deltaY: number): number {
  return Number.isFinite(deltaY) ? Math.max(0, deltaY) : 0;
}

export interface SheetRelease {
  /** Downward travel at the moment the finger lifted. */
  deltaY: number;
  /** Rendered height of the sheet, used to scale the distance threshold. */
  sheetHeightPx: number;
  /** Downward velocity at release in px/ms (negative when moving upward). */
  velocityPxPerMs: number;
}

/**
 * Whether releasing the sheet at this position should close it.
 *
 * Distance OR speed: a long slow drag and a short fast flick both feel like
 * "dismiss" to a thumb, while a small nudge snaps back.
 */
export function shouldDismissSheet({
  deltaY,
  sheetHeightPx,
  velocityPxPerMs,
}: SheetRelease): boolean {
  if (deltaY <= 0) return false;

  const distanceThreshold = Math.max(
    SHEET_DISMISS_MIN_PX,
    sheetHeightPx * SHEET_DISMISS_FRACTION,
  );
  if (deltaY >= distanceThreshold) return true;

  // Speed alone is not enough: a 20px twitch during a fast scroll would close
  // the panel, so a flick must also have actually travelled.
  const flicked = velocityPxPerMs >= SHEET_DISMISS_VELOCITY_PX_PER_MS;
  return flicked && deltaY >= SHEET_DISMISS_MIN_PX / 2;
}

/** Backdrop opacity for the current drag offset (fades as the sheet moves down). */
export function sheetBackdropOpacity(deltaY: number): number {
  const progress = Math.min(1, sheetDragOffset(deltaY) / SHEET_BACKDROP_FADE_PX);
  return Math.max(SHEET_BACKDROP_MIN_OPACITY, 1 - progress * (1 - SHEET_BACKDROP_MIN_OPACITY));
}
