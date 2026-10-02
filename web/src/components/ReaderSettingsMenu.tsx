import { useCallback, useEffect, useId, useRef, useState } from "react";

import { PLAYBACK_SHORTCUT_GUIDE } from "../hooks/usePlaybackShortcuts";
import type { ConveyorWindowSize, MotionMode, ReaderSettings } from "../state/reader-settings";

/* ── Types ────────────────────────────────────────────────── */

export interface ReaderSettingsMenuProps {
  settings: ReaderSettings;
  onChange: (patch: Partial<ReaderSettings>) => void;
  onReset: () => void;
  /** Phone widths get a bottom sheet; wider screens get an anchored popover. */
  isOverlay: boolean;
  /**
   * Only render controls whose feature exists. Keeps the panel from offering a
   * switch that does nothing while a feature is still landing.
   */
  showConveyorControls: boolean;
}

/* ── Small building blocks ────────────────────────────────── */

interface ToggleRowProps {
  id: string;
  label: string;
  description?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}

function ToggleRow({ id, label, description, checked, onChange }: ToggleRowProps) {
  const descriptionId = `${id}-description`;
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <label className="block text-xs font-medium text-[var(--ink-primary)]" htmlFor={id}>
          {label}
        </label>
        {description ? (
          <p
            className="mt-0.5 text-[11px] leading-snug text-[var(--ink-secondary)]"
            id={descriptionId}
          >
            {description}
          </p>
        ) : null}
      </div>
      <input
        aria-describedby={description ? descriptionId : undefined}
        checked={checked}
        className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--amber)]"
        id={id}
        onChange={(event) => onChange(event.target.checked)}
        type="checkbox"
      />
    </div>
  );
}

interface RadioGroupProps<T extends string | number> {
  legend: string;
  name: string;
  value: T;
  options: ReadonlyArray<{ value: T; label: string }>;
  onChange: (value: T) => void;
}

function RadioGroup<T extends string | number>({
  legend,
  name,
  value,
  options,
  onChange,
}: RadioGroupProps<T>) {
  return (
    <fieldset>
      <legend className="text-[10px] font-semibold uppercase tracking-wider text-[var(--ink-secondary)]">
        {legend}
      </legend>
      <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1.5">
        {options.map((option) => (
          <label
            className="flex cursor-pointer items-center gap-1.5 text-xs text-[var(--ink-primary)]"
            key={String(option.value)}
          >
            <input
              checked={value === option.value}
              className="h-3.5 w-3.5 accent-[var(--amber)]"
              name={name}
              onChange={() => onChange(option.value)}
              type="radio"
              value={String(option.value)}
            />
            {option.label}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

/* ── Component ────────────────────────────────────────────── */

/**
 * Reader settings.
 *
 * A gear trigger plus a settings body that renders either as an anchored
 * popover (desktop) or a bottom sheet (phones). Both shells share one body so
 * the controls, labels and persistence cannot diverge.
 *
 * Controls are native `input`s on purpose: the page-wide playback shortcuts
 * leave form widgets alone, so a radio or checkbox keeps its own keyboard
 * behaviour without any custom ARIA.
 */
export function ReaderSettingsMenu({
  settings,
  onChange,
  onReset,
  isOverlay,
  showConveyorControls,
}: ReaderSettingsMenuProps) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const panelId = useId();

  const close = useCallback((restoreFocus: boolean) => {
    setOpen(false);
    if (restoreFocus) triggerRef.current?.focus();
  }, []);

  // Escape closes from anywhere; the trigger keeps focus so the user is not
  // dumped back at the top of the document.
  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") close(true);
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [close, open]);

  // An anchored popover dismisses on an outside press. The sheet instead uses
  // its backdrop, because it covers the viewport.
  useEffect(() => {
    if (!open || isOverlay) return;
    const handlePointerDown = (event: PointerEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, [isOverlay, open]);

  // Move focus into the panel so the controls are reachable without a click.
  useEffect(() => {
    if (open) panelRef.current?.focus();
  }, [open]);

  const body = (
    <div className="space-y-4">
      {showConveyorControls ? (
        <section className="space-y-3">
          <RadioGroup<MotionMode>
            legend="Playback motion"
            name={`${panelId}-motion`}
            onChange={(motionMode) => onChange({ motionMode })}
            options={[
              { value: "auto", label: "Match system" },
              { value: "reduced", label: "Reduced" },
              { value: "always", label: "Always animate" },
            ]}
            value={settings.motionMode}
          />
          <ToggleRow
            checked={settings.showConveyor}
            description="The scrolling chunk strip under the main playbar."
            id={`${panelId}-conveyor`}
            label="Show chunk conveyor"
            onChange={(showConveyor) => onChange({ showConveyor })}
          />
          {settings.showConveyor ? (
            <RadioGroup<ConveyorWindowSize>
              legend="Chunks in view"
              name={`${panelId}-window`}
              onChange={(conveyorWindowSize) => onChange({ conveyorWindowSize })}
              options={[
                { value: "auto", label: "Auto" },
                { value: 3, label: "3" },
                { value: 4, label: "4" },
                { value: 5, label: "5" },
              ]}
              value={settings.conveyorWindowSize}
            />
          ) : null}
        </section>
      ) : null}

      <section>
        <ToggleRow
          checked={settings.showChunkJumpButtons}
          description="A jump control on every chunk block in the text."
          id={`${panelId}-jump`}
          label="Show chunk jump buttons"
          onChange={(showChunkJumpButtons) => onChange({ showChunkJumpButtons })}
        />
      </section>

      <section>
        <p className="text-[10px] font-semibold uppercase tracking-wider text-[var(--ink-secondary)]">
          Keyboard shortcuts
        </p>
        <dl className="mt-1.5 space-y-1" data-testid="shortcut-guide">
          {PLAYBACK_SHORTCUT_GUIDE.map((entry) => (
            <div className="flex items-baseline justify-between gap-3" key={entry.keys}>
              <dt className="font-mono text-[11px] text-[var(--ink-primary)]">{entry.keys}</dt>
              <dd className="text-right text-[11px] text-[var(--ink-secondary)]">{entry.action}</dd>
            </div>
          ))}
        </dl>
      </section>

      <button
        className="w-full rounded-lg border border-[var(--line)] px-3 py-1.5 text-[11px] font-semibold text-[var(--ink-secondary)] transition-colors hover:border-[var(--amber)] hover:text-[var(--amber)]"
        onClick={onReset}
        type="button"
      >
        Reset to defaults
      </button>
    </div>
  );

  return (
    <div className="relative" ref={containerRef}>
      <button
        aria-controls={panelId}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label="Reader settings"
        className="flex h-8 w-8 items-center justify-center rounded-full text-[var(--ink-secondary)] transition-colors hover:bg-[var(--hover-bg)] hover:text-[var(--ink-primary)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--amber)]"
        onClick={() => setOpen((previous) => !previous)}
        ref={triggerRef}
        title="Reader settings"
        type="button"
      >
        {/* Gear icon */}
        <svg
          aria-hidden="true"
          className="h-4 w-4"
          fill="none"
          stroke="currentColor"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="1.8"
          viewBox="0 0 24 24"
        >
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-2.9 1.2v.2a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.6 1.7 1.7 0 0 0-1.9.4l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0-1.2-2.9H3a2 2 0 1 1 0-4h.1A1.7 1.7 0 0 0 4.8 8.4l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3H9.6a1.7 1.7 0 0 0 1-1.5V4a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.4l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9v.1a1.7 1.7 0 0 0 1.5 1H22a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
        </svg>
      </button>

      {open && isOverlay ? (
        <div
          className="fixed inset-0 z-40 bg-black/50"
          data-testid="reader-settings-backdrop"
          onClick={() => close(false)}
        />
      ) : null}

      {open ? (
        <div
          aria-label="Reader settings"
          className={
            isOverlay
              ? "fixed inset-x-0 bottom-0 z-50 max-h-[70vh] overflow-y-auto rounded-t-2xl border border-[var(--line)] bg-[var(--surface)] p-4 shadow-2xl"
              : "absolute right-0 top-full z-50 mt-2 w-72 rounded-xl border border-[var(--line)] bg-[var(--surface)] p-4 shadow-2xl"
          }
          id={panelId}
          ref={panelRef}
          role="dialog"
          tabIndex={-1}
        >
          <div className="mb-3 flex items-start justify-between gap-2">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-[var(--ink-secondary)]">
              Reader settings
            </h3>
            <button
              aria-label="Close settings"
              className="-mr-1 -mt-1 flex h-6 w-6 items-center justify-center rounded text-[var(--ink-secondary)] transition-colors hover:bg-[var(--hover-bg)] hover:text-[var(--ink-primary)]"
              onClick={() => close(true)}
              type="button"
            >
              <svg
                aria-hidden="true"
                className="h-3.5 w-3.5"
                fill="none"
                stroke="currentColor"
                strokeLinecap="round"
                strokeWidth="2"
                viewBox="0 0 24 24"
              >
                <line x1="6" x2="18" y1="6" y2="18" />
                <line x1="6" x2="18" y1="18" y2="6" />
              </svg>
            </button>
          </div>
          {body}
        </div>
      ) : null}
    </div>
  );
}
