import { useEffect, useRef, useState } from "react";

interface ReaderReadMenuProps {
  activeChunkIndex: number | null;
  onMarkAll: (read: boolean) => void;
  onMarkFrom: (chunkIndex: number, read: boolean) => void;
}

/** Bulk listening-state actions for the whole document. */
export function ReaderReadMenu({
  activeChunkIndex,
  onMarkAll,
  onMarkFrom,
}: ReaderReadMenuProps) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const item = (label: string, action: () => void) => (
    <button
      className="block w-full rounded px-2.5 py-1.5 text-left text-sm text-[var(--ink-primary)] transition hover:bg-[var(--hover-bg)]"
      key={label}
      onClick={() => {
        setOpen(false);
        action();
      }}
      type="button"
    >
      {label}
    </button>
  );

  return (
    <div className="relative" ref={containerRef}>
      <button
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label="Listening state actions"
        className="flex h-8 w-8 items-center justify-center rounded-md text-[var(--ink-secondary)] transition hover:bg-[var(--hover-bg)] hover:text-[var(--ink-primary)]"
        onClick={() => setOpen((value) => !value)}
        type="button"
      >
        <svg aria-hidden="true" height="16" viewBox="0 0 16 16" width="16">
          <circle cx="8" cy="3" fill="currentColor" r="1.4" />
          <circle cx="8" cy="8" fill="currentColor" r="1.4" />
          <circle cx="8" cy="13" fill="currentColor" r="1.4" />
        </svg>
      </button>
      {open ? (
        <div
          className="absolute right-0 top-9 z-30 w-56 rounded-xl border border-[var(--line)] bg-[var(--surface)] p-1 shadow-xl"
          role="menu"
        >
          {item("Mark all read", () => onMarkAll(true))}
          {item("Mark all unread", () => onMarkAll(false))}
          {activeChunkIndex !== null ? (
            <>
              <div className="my-1 border-t border-[var(--line)]" />
              {item(`Mark from chunk ${activeChunkIndex + 1} read`, () =>
                onMarkFrom(activeChunkIndex, true),
              )}
              {item(`Mark from chunk ${activeChunkIndex + 1} unread`, () =>
                onMarkFrom(activeChunkIndex, false),
              )}
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
