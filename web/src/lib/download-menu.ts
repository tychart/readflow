/**
 * Placement of the download-format panel.
 *
 * The panel is portalled to `<body>` because the playbar's metadata row — where
 * the download control lives — sets `overflow: hidden` so it can collapse on
 * scroll; an inline popover was clipped to a few pixels of its first row.
 *
 * Position only needs the trigger's bottom/right edges and the viewport width:
 * the panel drops below the trigger (the bar is pinned to the top of the page,
 * so there is always room beneath it) and is right-aligned to the button. It
 * never needs to measure itself, which keeps the component free of a
 * render-measure-render cycle.
 */

export const DOWNLOAD_MENU_WIDTH_PX = 288;
const EDGE_MARGIN_PX = 8;
const TRIGGER_GAP_PX = 6;

export interface DownloadMenuPlacement {
  top: number;
  left: number;
  width: number;
}

export interface DownloadMenuTrigger {
  bottom: number;
  right: number;
}

/** Fixed-position coordinates for the panel, clamped inside the viewport. */
export function downloadMenuPlacement(
  trigger: DownloadMenuTrigger,
  viewportWidth: number,
): DownloadMenuPlacement {
  // A phone narrower than the panel plus margins gets a full-width panel.
  const width = Math.min(
    DOWNLOAD_MENU_WIDTH_PX,
    Math.max(0, viewportWidth - EDGE_MARGIN_PX * 2),
  );
  const rightmostLeft = viewportWidth - width - EDGE_MARGIN_PX;
  const left = Math.min(
    Math.max(trigger.right - width, EDGE_MARGIN_PX),
    Math.max(EDGE_MARGIN_PX, rightmostLeft),
  );
  return { top: trigger.bottom + TRIGGER_GAP_PX, left, width };
}
