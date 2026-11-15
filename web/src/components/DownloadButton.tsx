import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import {
  DEFAULT_DOWNLOAD_FORMAT,
  DOWNLOAD_FORMAT_OPTIONS,
} from "../lib/download-formats";
import { downloadMenuPlacement } from "../lib/download-menu";
import type { DownloadFormatName } from "../types/api";

interface DownloadButtonProps {
  /** False while there is no contiguous rendered audio to export. */
  canDownload: boolean;
  /** True while the server is building the export. */
  isDownloading: boolean;
  /** True when the whole job is rendered (changes the label only). */
  isComplete: boolean;
  /** Called with the chosen encoding; the plain button asks for the default. */
  onDownload: (format: DownloadFormatName) => void;
}

interface PanelPosition {
  top: number;
  left: number;
  width: number;
}

/**
 * Download control: the default export plus a "Download as…" panel.
 *
 * The panel is a portal, not an inline popover. The control sits in the
 * playbar's metadata row, which clips its own content (`overflow: hidden`) so
 * it can collapse on scroll — an inline popover was cut down to its first row.
 * It is a disclosure (not an ARIA menu): every entry is an ordinary button, so
 * it needs no roving tabindex or arrow-key handling.
 */
export function DownloadButton({
  canDownload,
  isDownloading,
  isComplete,
  onDownload,
}: DownloadButtonProps) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<PanelPosition | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const panelId = useId();
  const isDisabled = !canDownload || isDownloading;

  const close = useCallback(() => setOpen(false), []);

  // Measure on open and paint in the same frame, so the panel never flashes at
  // a stale position (or at 0,0) before it is placed.
  useLayoutEffect(() => {
    if (!open) {
      setPosition(null);
      return;
    }
    const trigger = triggerRef.current;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    setPosition(
      downloadMenuPlacement(
        { bottom: rect.bottom, right: rect.right },
        window.innerWidth,
      ),
    );
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (panelRef.current?.contains(target)) return;
      if (triggerRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    // The bar is sticky and collapses as the page scrolls, so a panel anchored
    // to it would drift away from its trigger. Close instead of chasing it.
    window.addEventListener("scroll", close, { passive: true });
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("scroll", close);
      window.removeEventListener("resize", close);
    };
  }, [open, close]);

  const pickFormat = (format: DownloadFormatName) => {
    setOpen(false);
    onDownload(format);
  };

  const baseButton =
    "flex items-center gap-1.5 border text-[11px] font-semibold transition";
  const enabledColor =
    "border-[var(--line)] text-[var(--ink-secondary)] hover:border-[var(--amber)] hover:text-[var(--amber)]";
  const disabledColor =
    "cursor-not-allowed border-[var(--line)] text-[var(--slate)] opacity-50";

  return (
    <>
      <div className="flex items-stretch">
        <button
          aria-label={
            isComplete
              ? "Download full audio"
              : canDownload
                ? "Download rendered audio"
                : "Download not available"
          }
          className={`${baseButton} rounded-l-lg px-3 py-1.5 ${
            isDisabled && !isDownloading ? disabledColor : enabledColor
          }`}
          disabled={isDisabled}
          onClick={() => onDownload(DEFAULT_DOWNLOAD_FORMAT)}
          title={
            isComplete
              ? "Download complete audio file"
              : canDownload
                ? "Download rendered audio so far"
                : "No audio data available yet"
          }
          type="button"
        >
          {isDownloading ? (
            <>
              <span className="inline-block h-3 w-3 animate-spin rounded-full border border-current border-t-transparent" />
              Preparing…
            </>
          ) : (
            <>
              {/* Download icon */}
              <svg
                aria-hidden="true"
                className="h-3 w-3"
                fill="none"
                stroke="currentColor"
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth="2"
                viewBox="0 0 24 24"
              >
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="7 10 12 15 17 10" />
                <line x1="12" x2="12" y1="15" y2="3" />
              </svg>
              {isComplete ? "Full audio" : "Download"}
            </>
          )}
        </button>
        <button
          aria-controls={panelId}
          aria-expanded={open}
          aria-label="Choose download format"
          className={`${baseButton} -ml-px rounded-r-lg border-l-0 px-1.5 py-1.5 ${
            isDisabled ? disabledColor : enabledColor
          }`}
          disabled={isDisabled}
          onClick={() => setOpen((value) => !value)}
          ref={triggerRef}
          title="Choose download format"
          type="button"
        >
          <svg
            aria-hidden="true"
            className="h-3 w-3"
            fill="none"
            stroke="currentColor"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="2.5"
            viewBox="0 0 24 24"
          >
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </button>
      </div>
      {open && position
        ? createPortal(
            <div
              className="fixed z-[60] rounded-xl border border-[var(--line)] bg-[var(--surface)] p-1 shadow-xl"
              data-testid="download-format-panel"
              id={panelId}
              ref={panelRef}
              style={{
                top: position.top,
                left: position.left,
                width: position.width,
              }}
            >
              <p className="px-2.5 pt-1.5 pb-1 text-[10px] font-semibold tracking-wide text-[var(--slate)] uppercase">
                Download as
              </p>
              {DOWNLOAD_FORMAT_OPTIONS.map((option) => (
                <button
                  className="block w-full rounded-lg px-2.5 py-1.5 text-left transition hover:bg-[var(--hover-bg)]"
                  key={option.value}
                  onClick={() => pickFormat(option.value)}
                  type="button"
                >
                  <span className="block text-sm font-medium text-[var(--ink-primary)]">
                    {option.label}
                  </span>
                  <span className="block text-[11px] text-[var(--slate)]">
                    {option.hint}
                  </span>
                </button>
              ))}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
