/** Shared visual geometry for the overview's DOM bars and the conveyor canvas. */
export const BAR_WIDTH_PX = 3;
/**
 * Fractional spacing staggers edge coverage across bars. An integer 5px period
 * makes every thin bar darken together between pixels (sRGB antialiasing),
 * visibly pulsing during slow motion. Staggering coverage reduces that effect;
 * it does not promise constant luminance during native image interpolation.
 */
export const BAR_GAP_PX = 2.125;
export const BAR_RADIUS_PX = 2;
export const MIN_BAR_HEIGHT = 0.06;
/** Total horizontal inset: 4px on each side. */
export const SLOT_H_PADDING_PX = 8;
