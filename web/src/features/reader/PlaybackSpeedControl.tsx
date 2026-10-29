import {
  type ChangeEvent,
  type FocusEvent,
  type KeyboardEvent,
  useCallback,
  useRef,
  useState,
} from "react";

import { formatSpeed } from "../../lib/format";
import { PLAYBACK_RATE_MAX, PLAYBACK_RATE_MIN } from "../../state/reader-settings";

const SLIDER_MIN = 0.5;
const SLIDER_MAX = 3.0;
const SLIDER_STEP = 0.05;

/**
 * One-tap speeds. Ordered slow → fast and kept short on purpose: this is the
 * whole reason the control moved off the playbar, and on a phone these have to
 * be thumb-sized. Anything outside this list stays reachable with the slider or
 * the numeric input.
 */
export const PLAYBACK_SPEED_PRESETS = [0.75, 1, 1.25, 1.5, 1.75, 2] as const;

interface PlaybackSpeedControlProps {
  value: number;
  onChange: (value: number) => void;
}

/**
 * Playback speed editor: preset chips for the common rates, plus a slider
 * (0.5–3.0, step 0.05) and a text input that accepts any supported float.
 *
 * Lives inside the reader settings panel (not the playbar): speed is a
 * set-and-forget preference, so it costs the playbar no horizontal space. The
 * slider caps at its bounds when the typed value is outside, while the input
 * displays the actual value.
 */
export function PlaybackSpeedControl({ value, onChange }: PlaybackSpeedControlProps) {
  const [inputText, setInputText] = useState(formatSpeed(value));
  const prevValueRef = useRef(value);

  // Keep input in sync when value changes externally
  if (value !== prevValueRef.current) {
    prevValueRef.current = value;
    setInputText(formatSpeed(value));
  }

  const commitSpeed = useCallback(
    (raw: string) => {
      const parsed = parseFloat(raw);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        // Revert to current value
        setInputText(formatSpeed(value));
        return;
      }
      onChange(Math.min(PLAYBACK_RATE_MAX, Math.max(PLAYBACK_RATE_MIN, parsed)));
    },
    [onChange, value],
  );

  const handleSliderChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const next = Number(event.target.value);
      onChange(next);
      setInputText(formatSpeed(next));
    },
    [onChange],
  );

  const handleInputChange = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    setInputText(event.target.value);
  }, []);

  const handleInputBlur = useCallback(
    (event: FocusEvent<HTMLInputElement>) => {
      commitSpeed(event.target.value);
    },
    [commitSpeed],
  );

  const handleInputKeyDown = useCallback(
    (event: KeyboardEvent<HTMLInputElement>) => {
      if (event.key === "Enter") {
        commitSpeed((event.target as HTMLInputElement).value);
      }
    },
    [commitSpeed],
  );

  // Clamp slider position to the slider range even if the actual speed is outside
  const sliderValue = Math.min(SLIDER_MAX, Math.max(SLIDER_MIN, value));

  return (
    <div className="space-y-2.5">
      {/* Preset chips — the mobile path: one tap, no dragging. A 3-column grid
          keeps six thumb-sized targets readable on both the phone sheet and the
          desktop popover, where wrapping the same chips left an unbalanced row. */}
      <div className="grid grid-cols-3 gap-1.5" data-testid="speed-presets">
        {PLAYBACK_SPEED_PRESETS.map((preset) => {
          const isActive = Math.abs(value - preset) < 0.001;
          return (
            <button
              aria-pressed={isActive}
              className={`rounded-lg border py-1.5 text-xs font-semibold tabular-nums transition-colors ${
                isActive
                  ? "border-[var(--amber)] bg-[var(--amber-soft)] text-[var(--amber)]"
                  : "border-[var(--line)] text-[var(--ink-secondary)] hover:border-[var(--amber)] hover:text-[var(--amber)]"
              }`}
              key={preset}
              onClick={() => onChange(preset)}
              type="button"
            >
              {formatSpeed(preset)}×
            </button>
          );
        })}
      </div>

      <div className="flex items-center gap-2">
        <input
          aria-label="Playback speed slider"
          className="h-1.5 min-w-0 flex-1 cursor-pointer appearance-none rounded-full accent-[var(--amber)]"
          max={SLIDER_MAX}
          min={SLIDER_MIN}
          onChange={handleSliderChange}
          step={SLIDER_STEP}
          style={{
            background: `linear-gradient(to right, var(--amber) ${
              ((sliderValue - SLIDER_MIN) / (SLIDER_MAX - SLIDER_MIN)) * 100
            }%, var(--track) ${((sliderValue - SLIDER_MIN) / (SLIDER_MAX - SLIDER_MIN)) * 100}%)`,
          }}
          type="range"
          value={sliderValue}
        />
        <div className="flex shrink-0 items-center gap-1">
          <input
            aria-label="Playback speed value"
            className="w-12 rounded-lg border border-[var(--line)] bg-[var(--surface-raised)] px-1.5 py-1 text-center text-xs font-semibold tabular-nums text-[var(--ink-primary)] focus:border-[var(--amber)] focus:outline-none"
            onBlur={handleInputBlur}
            onChange={handleInputChange}
            onKeyDown={handleInputKeyDown}
            type="text"
            value={inputText}
          />
          <span className="text-xs text-[var(--ink-secondary)]">×</span>
        </div>
      </div>
    </div>
  );
}
