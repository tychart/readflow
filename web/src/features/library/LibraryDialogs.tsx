import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";
import type { LibraryFolder } from "../../types/api";
import { JobCreateForm } from "../jobs/JobCreateForm";
import { folderPath } from "./library-model";

interface PromptDialogProps {
  title: string;
  label: string;
  initialValue?: string;
  confirmLabel: string;
  onSubmit: (value: string) => Promise<void> | void;
  onCancel: () => void;
}

export function PromptDialog({
  title,
  label,
  initialValue = "",
  confirmLabel,
  onSubmit,
  onCancel,
}: PromptDialogProps) {
  const [value, setValue] = useState(initialValue);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const clean = value.trim();
    if (!clean || busy) return;
    setBusy(true);
    try {
      await onSubmit(clean);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      {/* biome-ignore lint/a11y/noStaticElementInteractions: Escape and the explicit buttons are the keyboard path. */}
      <div className="absolute inset-0" onMouseDown={onCancel} />
      <form
        aria-labelledby="prompt-dialog-title"
        aria-modal="true"
        className="relative w-full max-w-md rounded-xl border border-[var(--line)] bg-[var(--surface)] p-5 shadow-xl"
        onSubmit={(event) => void submit(event)}
        role="dialog"
      >
        <h2
          className="text-base font-semibold text-[var(--ink-primary)]"
          id="prompt-dialog-title"
        >
          {title}
        </h2>
        <label
          className="mt-4 block text-xs font-medium uppercase tracking-wider text-[var(--ink-secondary)]"
          htmlFor="prompt-dialog-input"
        >
          {label}
        </label>
        <input
          className="mt-1.5 w-full rounded-lg border border-[var(--line)] bg-[var(--surface-raised)] px-3 py-2 text-sm text-[var(--ink-primary)] focus:border-[var(--amber)] focus:outline-none"
          id="prompt-dialog-input"
          maxLength={200}
          onChange={(event) => setValue(event.target.value)}
          ref={inputRef}
          value={value}
        />
        <div className="mt-5 flex justify-end gap-2">
          <button
            className="rounded-lg px-3 py-2 text-sm text-[var(--ink-secondary)] transition hover:bg-[var(--hover-bg)]"
            onClick={onCancel}
            type="button"
          >
            Cancel
          </button>
          <button
            className="rounded-lg bg-[var(--amber)] px-3 py-2 text-sm font-medium text-[var(--canvas)] transition hover:brightness-110 disabled:opacity-50"
            disabled={!value.trim() || busy}
            type="submit"
          >
            {confirmLabel}
          </button>
        </div>
      </form>
    </div>
  );
}

interface MoveDialogProps {
  folders: LibraryFolder[];
  /** Folders that cannot be a destination (the moved folder and its subtree). */
  excludedFolderIds: ReadonlySet<string>;
  onMove: (folderId: string | null) => void;
  onCancel: () => void;
}

export function MoveDialog({
  folders,
  excludedFolderIds,
  onMove,
  onCancel,
}: MoveDialogProps) {
  const destinations = useMemo(
    () =>
      folders
        .filter((folder) => !excludedFolderIds.has(folder.id))
        .map((folder) => ({
          folder,
          depth: folderPath(folders, folder.id).length - 1,
        }))
        .sort((left, right) => {
          const leftPath = folderPath(folders, left.folder.id)
            .map((item) => item.name)
            .join("/");
          const rightPath = folderPath(folders, right.folder.id)
            .map((item) => item.name)
            .join("/");
          return leftPath.localeCompare(rightPath);
        }),
    [excludedFolderIds, folders],
  );

  const [target, setTarget] = useState<string>("root");

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      {/* biome-ignore lint/a11y/noStaticElementInteractions: Escape and the explicit buttons are the keyboard path. */}
      <div className="absolute inset-0" onMouseDown={onCancel} />
      <div
        aria-labelledby="move-dialog-title"
        aria-modal="true"
        className="relative w-full max-w-md rounded-xl border border-[var(--line)] bg-[var(--surface)] p-5 shadow-xl"
        role="dialog"
      >
        <h2
          className="text-base font-semibold text-[var(--ink-primary)]"
          id="move-dialog-title"
        >
          Move to folder
        </h2>
        <label
          className="mt-4 block text-xs font-medium uppercase tracking-wider text-[var(--ink-secondary)]"
          htmlFor="move-dialog-destination"
        >
          Destination
        </label>
        <select
          className="mt-1.5 w-full rounded-lg border border-[var(--line)] bg-[var(--surface-raised)] px-3 py-2 text-sm text-[var(--ink-primary)] focus:border-[var(--amber)] focus:outline-none"
          id="move-dialog-destination"
          onChange={(event) => setTarget(event.target.value)}
          value={target}
        >
          <option value="root">Library (root)</option>
          {destinations.map(({ folder, depth }) => (
            <option key={folder.id} value={folder.id}>
              {`${"\u00a0\u00a0".repeat(depth)}${folder.name}`}
            </option>
          ))}
        </select>
        <div className="mt-5 flex justify-end gap-2">
          <button
            className="rounded-lg px-3 py-2 text-sm text-[var(--ink-secondary)] transition hover:bg-[var(--hover-bg)]"
            onClick={onCancel}
            type="button"
          >
            Cancel
          </button>
          <button
            className="rounded-lg bg-[var(--amber)] px-3 py-2 text-sm font-medium text-[var(--canvas)] transition hover:brightness-110"
            onClick={() => onMove(target === "root" ? null : target)}
            type="button"
          >
            Move here
          </button>
        </div>
      </div>
    </div>
  );
}

interface NewJobDialogProps {
  folderId: string | null;
  onSubmit: (formData: FormData) => Promise<void>;
  onCancel: () => void;
}

export function NewJobDialog({
  folderId,
  onSubmit,
  onCancel,
}: NewJobDialogProps) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/50 p-4 sm:items-center">
      {/* biome-ignore lint/a11y/noStaticElementInteractions: Escape and the form's cancel action are the keyboard path. */}
      <div className="absolute inset-0" onMouseDown={onCancel} />
      <div
        aria-labelledby="new-job-dialog-title"
        aria-modal="true"
        className="relative my-6 w-full max-w-2xl rounded-xl border border-[var(--line)] bg-[var(--surface)] p-5 shadow-xl"
        role="dialog"
      >
        <div className="mb-3 flex items-center justify-between">
          <h2
            className="text-base font-semibold text-[var(--ink-primary)]"
            id="new-job-dialog-title"
          >
            New job
          </h2>
          <button
            aria-label="Close"
            className="flex h-8 w-8 items-center justify-center rounded-full text-[var(--ink-secondary)] hover:bg-[var(--hover-bg)]"
            onClick={onCancel}
            type="button"
          >
            ×
          </button>
        </div>
        <JobCreateForm folderId={folderId} onSubmit={onSubmit} />
      </div>
    </div>
  );
}
