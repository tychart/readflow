import { ReactNode, useEffect, useRef } from "react";

interface ConfirmDialogProps {
  title: string;
  description: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
  children?: ReactNode;
}

/**
 * Small accessible confirmation modal.
 *
 * Focus moves to the confirm button on open and Escape cancels; the reader's
 * page-wide shortcuts already ignore keys inside `[role="dialog"]`, so this can
 * live inside the reader/jobs pages without stealing Space or arrow keys.
 */
export function ConfirmDialog({
  title,
  description,
  confirmLabel,
  cancelLabel = "Cancel",
  onConfirm,
  onCancel,
  children,
}: ConfirmDialogProps) {
  const confirmRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    confirmRef.current?.focus();
  }, []);

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [onCancel]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onMouseDown={onCancel}
    >
      <div
        aria-labelledby="confirm-dialog-title"
        aria-modal="true"
        className="w-full max-w-md rounded-xl border border-[var(--line)] bg-[var(--surface)] p-5 shadow-xl"
        onMouseDown={(event) => event.stopPropagation()}
        role="dialog"
      >
        <h2
          className="text-base font-semibold text-[var(--ink-primary)]"
          id="confirm-dialog-title"
        >
          {title}
        </h2>
        <div className="mt-2 text-sm text-[var(--ink-secondary)]">{description}</div>
        {children}
        <div className="mt-5 flex justify-end gap-2">
          <button
            className="rounded-lg border border-[var(--line)] px-4 py-2 text-sm font-semibold text-[var(--ink-secondary)] transition hover:text-[var(--ink-primary)]"
            onClick={onCancel}
            type="button"
          >
            {cancelLabel}
          </button>
          <button
            className="rounded-lg bg-[var(--amber)] px-4 py-2 text-sm font-semibold text-white transition hover:brightness-110"
            onClick={onConfirm}
            ref={confirmRef}
            type="button"
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
