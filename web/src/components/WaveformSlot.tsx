import type { CSSProperties, PointerEvent as ReactPointerEvent } from "react";

import { barFillFraction, isNonFillState, isSlotDimmed } from "../lib/waveform-timeline";
import type { TimelineSlotData } from "../types/timeline";

/* ── Tunable waveform style ─────────────────────────────────
 * All visual knobs for the static waveform live here so the look can be tuned
 * without touching rendering logic. Shared by every waveform surface: the main
 * playbar timeline and the reader's chunk conveyor. */

/** Bar thickness in px. */
export const BAR_WIDTH_PX = 3;
/** Gap between bars in px. */
export const BAR_GAP_PX = 2;
/** Corner radius in px (BAR_WIDTH_PX / 2 = fully rounded pill). */
export const BAR_RADIUS_PX = 2;
/** Minimum bar height as a fraction of the slot height. */
export const MIN_BAR_HEIGHT = 0.06;
/** Horizontal padding inside each slot (matches the px-1 = 4px each side). */
export const SLOT_H_PADDING_PX = 8;

/* ── Interaction ──────────────────────────────────────────── */

/**
 * Pointer/activation callbacks for a slot. The parent owns gesture state (drag
 * preview, commit-on-release) and receives the slot so it can resolve chunk
 * identity without the slot component knowing about seeking.
 */
export interface WaveformSlotInteraction {
  onPointerDown: (event: ReactPointerEvent<HTMLDivElement>, slot: TimelineSlotData) => void;
  onPointerMove: (event: ReactPointerEvent<HTMLDivElement>, slot: TimelineSlotData) => void;
  onPointerUp: (event: ReactPointerEvent<HTMLDivElement>, slot: TimelineSlotData) => void;
  onPointerCancel: (event: ReactPointerEvent<HTMLDivElement>, slot: TimelineSlotData) => void;
  /** Click / Enter / Space activation, as opposed to a drag-scrub. */
  onActivate: (slot: TimelineSlotData) => void;
}

/* ── Props ────────────────────────────────────────────────── */

export interface WaveformSlotProps {
  slot: TimelineSlotData;
  /** Peaks already pooled down to `barCount` bars. */
  bars: Float32Array;
  /** Number of bars to render. */
  barCount: number;
  /** Start of this slot in job-timeline coordinates. */
  slotStartSeconds: number;
  /** Playhead in the same coordinates as `slotStartSeconds`. */
  playheadSeconds: number;
  /** End of the playable range; bars past it stay muted. */
  renderedDurationSeconds: number;
  /** Drops labels/separators in the compact (scrolled) playbar. */
  compact: boolean;
  /** Renders the vertical separator after this slot. */
  showSeparator: boolean;
  /**
   * When false the slot is decorative: no ARIA role, no tab stop and no pointer
   * input. Used by the conveyor, which handles gestures at the strip level and
   * would otherwise nest sliders inside a slider.
   */
  interactive?: boolean;
  /** Layout is owned by the parent (flex share or fixed px width). */
  style?: CSSProperties;
  interaction: WaveformSlotInteraction;
}

/* ── Component ────────────────────────────────────────────── */

/**
 * One chunk slot of a static waveform: background tint, bars, amber playback
 * fill, chunk label and separator. Purely presentational apart from delegating
 * pointer input to the parent's interaction callbacks.
 */
export function WaveformSlot({
  slot,
  bars,
  barCount,
  slotStartSeconds,
  playheadSeconds,
  renderedDurationSeconds,
  compact,
  showSeparator,
  interactive = true,
  style,
  interaction,
}: WaveformSlotProps) {
  const nonFill = isNonFillState(slot.state);
  const isGap = slot.state === "ready_after_gap";
  const dimmed = isSlotDimmed(slot, slotStartSeconds, playheadSeconds);

  return (
    <div
      aria-hidden={interactive ? undefined : true}
      aria-label={interactive ? `Chunk ${slot.chunkIndex + 1}: ${slot.state}` : undefined}
      className={`relative flex h-full items-end overflow-hidden transition-colors ${
        interactive ? "cursor-pointer" : ""
      } ${dimmed ? "opacity-40" : ""}`}
      data-slot-state={slot.state}
      data-waveform-slot={slot.chunkIndex}
      onClick={interactive ? () => interaction.onActivate(slot) : undefined}
      onKeyDown={
        interactive
          ? (event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                interaction.onActivate(slot);
              }
            }
          : undefined
      }
      onPointerCancel={interactive ? (event) => interaction.onPointerCancel(event, slot) : undefined}
      onPointerDown={interactive ? (event) => interaction.onPointerDown(event, slot) : undefined}
      onPointerMove={interactive ? (event) => interaction.onPointerMove(event, slot) : undefined}
      onPointerUp={interactive ? (event) => interaction.onPointerUp(event, slot) : undefined}
      role={interactive ? "slider" : undefined}
      style={style}
      tabIndex={interactive ? 0 : undefined}
    >
      {/* Background tint based on state */}
      <div
        className={`absolute inset-0 ${
          slot.state === "failed"
            ? "bg-rose-900/30"
            : slot.state === "missing_expected"
              ? "bg-rose-900/15"
              : slot.state === "playing"
                ? "bg-[var(--amber-soft)]"
                : "bg-[var(--waveform-bar-muted)]"
        }`}
      />

      {/* Active chunk amber glow */}
      {slot.state === "playing" ? (
        <div
          className="pointer-events-none absolute inset-0"
          style={{ boxShadow: "inset 0 0 20px rgba(245,158,11,0.15)" }}
        />
      ) : null}

      {/* Missing chunk broken/diagonal pattern */}
      {slot.state === "missing_expected" ? (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 opacity-20"
          style={{
            backgroundImage:
              "repeating-linear-gradient(-45deg, rgba(239,68,68,0.5) 0px, rgba(239,68,68,0.5) 2px, transparent 2px, transparent 6px)",
          }}
        />
      ) : null}

      {/* Waveform bars — static shape, amber fill sweeps left-to-right with playhead */}
      <div
        className="relative z-10 flex h-[calc(100%-8px)] w-full items-end overflow-hidden px-1"
        style={{ gap: BAR_GAP_PX }}
      >
        {Array.from({ length: barCount }, (_, i) => {
          const amplitude = Math.max(MIN_BAR_HEIGHT, bars[i] ?? MIN_BAR_HEIGHT);

          // Horizontal (left-to-right) fill of this bar:
          // playhead fully right of it → 1, fully left → 0, inside → proportional.
          const barStartTime = slotStartSeconds + (i / barCount) * slot.durationSeconds;
          const barEndTime = slotStartSeconds + ((i + 1) / barCount) * slot.durationSeconds;
          const fillFraction = nonFill
            ? 0
            : barFillFraction(playheadSeconds, barStartTime, barEndTime, renderedDurationSeconds);

          return (
            <div
              className="relative shrink-0"
              data-wave-bar
              key={i}
              style={{ width: BAR_WIDTH_PX, height: `${amplitude * 100}%` }}
            >
              {nonFill ? (
                <div
                  className={`absolute inset-0 w-full ${
                    slot.state === "failed" ? "bg-rose-500/60" : "bg-[var(--waveform-bar-muted)]"
                  }`}
                  style={{ borderRadius: BAR_RADIUS_PX }}
                />
              ) : (
                <>
                  {/* Muted background — full bar height & width */}
                  <div
                    className={`absolute inset-0 w-full ${
                      isGap ? "bg-[var(--waveform-bar-dim)]/50" : "bg-[var(--waveform-bar-dim)]"
                    }`}
                    style={{ borderRadius: BAR_RADIUS_PX }}
                  />
                  {/* Amber foreground — fills left-to-right with playhead */}
                  {fillFraction > 0 ? (
                    <div
                      className={`absolute inset-y-0 left-0 ${
                        isGap ? "bg-[var(--amber)]/70" : "bg-[var(--amber)]"
                      }`}
                      data-wave-fill
                      style={{
                        width: `${fillFraction * 100}%`,
                        minWidth: "1px",
                        borderRadius: BAR_RADIUS_PX,
                      }}
                    />
                  ) : null}
                </>
              )}
            </div>
          );
        })}
      </div>

      {/* Chunk index label — hidden in compact mode */}
      {!compact && (
        <div
          aria-hidden="true"
          className="absolute bottom-1 left-1/2 z-20 -translate-x-1/2 text-[9px] font-semibold tracking-wider text-white/40"
        >
          {slot.chunkIndex + 1}
        </div>
      )}

      {/* Separator line — hidden in compact mode */}
      {!compact && showSeparator ? (
        <div
          aria-hidden="true"
          className="absolute inset-y-2 right-0 z-20 w-px bg-[var(--waveform-sep)]"
        />
      ) : null}
    </div>
  );
}
