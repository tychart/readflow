import {
  type ChangeEvent,
  type FocusEvent,
  type KeyboardEvent,
  useCallback,
  useId,
  useRef,
  useState,
} from "react";

const SLIDER_MIN = 0.5;
const SLIDER_MAX = 3.0;
const SLIDER_STEP = 0.05;

interface PlaybackSpeedControlProps {
  value: number;
  onChange: (value: number) => void;
}

/**
 * Playback speed control with a slider (0.5–3.0, step 0.05) and a text
 * input that accepts any positive float. The slider caps at its bounds
 * when the typed value is outside, while the input displays the actual
 * value.
 */
export function PlaybackSpeedControl({ value, onChange }: PlaybackSpeedControlProps) {
  const inputId = useId();
  const sliderId = useId();
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
      onChange(parsed);
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

  const handleInputChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      setInputText(event.target.value);
    },
    [],
  );

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
    <div className="flex items-center gap-2">
      <label
        className="hidden whitespace-nowrap text-[10px] font-semibold uppercase tracking-[0.15em] text-[var(--ink-secondary)] sm:block"
        htmlFor={sliderId}
      >
        Speed
      </label>
      <input
        aria-label="Playback speed slider"
        className="h-1.5 w-20 cursor-pointer appearance-none rounded-full accent-[var(--amber)] md:w-28"
        id={sliderId}
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
      <div className="flex items-center gap-1">
        <input
          aria-label="Playback speed value"
          className="w-12 rounded-lg border border-[var(--line)] bg-[var(--surface-raised)] px-1.5 py-1 text-center text-xs font-semibold tabular-nums text-[var(--ink-primary)] focus:border-[var(--amber)] focus:outline-none"
          id={inputId}
          onBlur={handleInputBlur}
          onChange={handleInputChange}
          onKeyDown={handleInputKeyDown}
          type="text"
          value={inputText}
        />
        <span className="text-xs text-[var(--ink-secondary)]">×</span>
      </div>
    </div>
  );
}

/**
 * Formats a speed value for display, stripping unnecessary trailing zeros.
 */
function formatSpeed(value: number): string {
  return parseFloat(value.toFixed(3)).toString();
}
