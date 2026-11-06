import { useEffect, useRef, useState } from "react";

import type { LibraryFolder, LibraryJob } from "../../types/api";
import {
  progressPercent,
  readStateLabel,
  remainingLabel,
} from "./library-model";
import type { LibraryRowKind } from "./library-types";

type MenuAction =
  | "open"
  | "play"
  | "rename"
  | "move"
  | "mark-read"
  | "mark-unread"
  | "delete"
  | "delete-only";

interface LibraryRowProps {
  kind: LibraryRowKind;
  folder?: LibraryFolder;
  job?: LibraryJob;
  organize: boolean;
  selected: boolean;
  dragging: boolean;
  dropTarget: boolean;
  onToggleSelected: (event: { shiftKey: boolean; metaKey: boolean }) => void;
  onOpen: () => void;
  onPlay: () => void;
  onMenuAction: (action: MenuAction) => void;
  onDragStart: () => void;
  onDragEnd: () => void;
  onDragOver: () => void;
  onDrop: () => void;
}

function renderHint(job: LibraryJob): {
  label: string;
  className: string;
} | null {
  if (job.status === "rendering") {
    return {
      label: `rendering ${job.total_chunks_completed} of ${job.total_chunks_emitted}`,
      className: "bg-[var(--amber)]",
    };
  }
  if (job.status === "paused") {
    return { label: "paused", className: "bg-[var(--ink-secondary)]" };
  }
  if (job.status === "failed") {
    return { label: "failed", className: "bg-[var(--rose)]" };
  }
  return null;
}

function RowMenu({
  kind,
  onAction,
}: {
  kind: LibraryRowKind;
  onAction: (action: MenuAction) => void;
}) {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      if (!buttonRef.current?.parentElement?.contains(event.target as Node)) {
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

  const item = (action: MenuAction, label: string, danger = false) => (
    <button
      className={`block w-full rounded px-2.5 py-1.5 text-left text-sm transition hover:bg-[var(--hover-bg)] ${
        danger ? "text-[var(--rose)]" : "text-[var(--ink-primary)]"
      }`}
      key={action}
      onClick={() => {
        setOpen(false);
        onAction(action);
      }}
      type="button"
    >
      {label}
    </button>
  );

  return (
    <div className="relative shrink-0">
      <button
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label="Row actions"
        className="flex h-8 w-8 items-center justify-center rounded-full text-[var(--ink-secondary)] transition hover:bg-[var(--hover-bg)] hover:text-[var(--ink-primary)]"
        onClick={() => setOpen((value) => !value)}
        ref={buttonRef}
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
          className="absolute right-0 top-9 z-30 w-52 rounded-xl border border-[var(--line)] bg-[var(--surface)] p-1 shadow-xl"
          role="menu"
        >
          {kind === "job" ? (
            <>
              {item("open", "Open")}
              {item("play", "Play")}
              {item("rename", "Rename…")}
              {item("move", "Move to…")}
              {item("mark-read", "Mark read")}
              {item("mark-unread", "Mark unread")}
              <div className="my-1 border-t border-[var(--line)]" />
              {item("delete", "Move to trash", true)}
            </>
          ) : (
            <>
              {item("open", "Open")}
              {item("play", "Play folder")}
              {item("rename", "Rename…")}
              {item("move", "Move to…")}
              {item("mark-read", "Mark all read")}
              {item("mark-unread", "Mark all unread")}
              <div className="my-1 border-t border-[var(--line)]" />
              {item("delete-only", "Delete folder only")}
              {item("delete", "Delete folder and jobs", true)}
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}

export function LibraryRow({
  kind,
  folder,
  job,
  organize,
  selected,
  dragging,
  dropTarget,
  onToggleSelected,
  onOpen,
  onPlay,
  onMenuAction,
  onDragStart,
  onDragEnd,
  onDragOver,
  onDrop,
}: LibraryRowProps) {
  const title =
    kind === "folder" ? (folder?.name ?? "") : (job?.title ?? "Untitled job");
  const hint = job ? renderHint(job) : null;
  const percent = job
    ? progressPercent(job)
    : Math.round((folder?.progress_fraction ?? 0) * 100);

  return (
    <li
      className={`group relative rounded-lg border transition ${
        selected
          ? "border-[var(--amber)]/50 bg-[var(--amber-soft)]"
          : "border-[var(--line)] bg-[var(--surface)] hover:border-white/15 hover:bg-[var(--surface-raised)]"
      } ${dragging ? "opacity-50" : ""} ${
        dropTarget ? "ring-2 ring-[var(--amber)]/60" : ""
      }`}
      draggable={organize}
      onDragEnd={onDragEnd}
      onDragOver={(event) => {
        if (!organize) return;
        event.preventDefault();
        onDragOver();
      }}
      onDragStart={(event) => {
        if (!organize) return;
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", folder?.id ?? job?.id ?? "");
        onDragStart();
      }}
      onDrop={(event) => {
        if (!organize) return;
        event.preventDefault();
        onDrop();
      }}
    >
      <div className="flex items-center gap-2 px-3 py-2.5">
        {organize ? (
          <input
            aria-label={`Select ${title}`}
            checked={selected}
            className="h-4 w-4 shrink-0 accent-[var(--amber)]"
            onChange={() =>
              onToggleSelected({ shiftKey: false, metaKey: false })
            }
            type="checkbox"
          />
        ) : null}

        <button
          className="min-w-0 flex-1 text-left"
          onClick={(event) => {
            if (organize) {
              onToggleSelected(event);
              return;
            }
            if (kind === "folder") onOpen();
            else onOpen();
          }}
          type="button"
        >
          <div className="flex min-w-0 items-center gap-2">
            <span
              aria-hidden="true"
              className="shrink-0 text-[var(--ink-secondary)]"
            >
              {kind === "folder" ? (
                <svg
                  aria-hidden="true"
                  height="15"
                  viewBox="0 0 16 16"
                  width="15"
                >
                  <path
                    d="M1.5 4.5A1.5 1.5 0 0 1 3 3h3l1.5 1.5H13A1.5 1.5 0 0 1 14.5 6v6A1.5 1.5 0 0 1 13 13.5H3A1.5 1.5 0 0 1 1.5 12V4.5Z"
                    fill="currentColor"
                    opacity="0.5"
                  />
                </svg>
              ) : (
                <svg
                  aria-hidden="true"
                  height="15"
                  viewBox="0 0 16 16"
                  width="15"
                >
                  <rect
                    fill="currentColor"
                    height="12"
                    opacity="0.4"
                    rx="1"
                    width="9"
                    x="3.5"
                    y="2"
                  />
                  <rect
                    fill="currentColor"
                    height="1.2"
                    width="5"
                    x="5.5"
                    y="5"
                  />
                  <rect
                    fill="currentColor"
                    height="1.2"
                    width="5"
                    x="5.5"
                    y="7"
                  />
                  <rect
                    fill="currentColor"
                    height="1.2"
                    width="3.5"
                    x="5.5"
                    y="9"
                  />
                </svg>
              )}
            </span>
            <span
              className="truncate text-sm font-medium text-[var(--ink-primary)]"
              data-testid={
                kind === "job" ? "job-card-title" : "folder-row-name"
              }
              title={title}
            >
              {title}
            </span>
            {hint ? (
              <span
                aria-label={hint.label}
                className={`h-1.5 w-1.5 shrink-0 rounded-full ${hint.className} ${
                  job?.status === "rendering" ? "animate-pulse" : ""
                }`}
                role="img"
                title={hint.label}
              />
            ) : null}
          </div>
          <div className="mt-1 flex min-w-0 items-center gap-2 text-[11px] text-[var(--ink-secondary)]">
            <span
              aria-hidden="true"
              className="h-1 w-24 shrink-0 overflow-hidden rounded-full bg-[var(--hover-bg)]"
            >
              <span
                className="block h-full rounded-full bg-[var(--amber)]"
                style={{ width: `${percent}%` }}
              />
            </span>
            <span className="truncate tabular-nums">
              {kind === "folder"
                ? `${folder?.job_count ?? 0} jobs`
                : `${readStateLabel(job as LibraryJob)} · ${remainingLabel(
                    job as LibraryJob,
                  )}`}
            </span>
          </div>
        </button>

        <button
          aria-label={kind === "folder" ? "Play folder" : "Play"}
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-[var(--ink-secondary)] transition hover:bg-[var(--hover-bg)] hover:text-[var(--amber)]"
          onClick={onPlay}
          type="button"
        >
          <svg aria-hidden="true" height="14" viewBox="0 0 16 16" width="14">
            <path d="M4 2.5v11l9-5.5-9-5.5Z" fill="currentColor" />
          </svg>
        </button>

        <RowMenu kind={kind} onAction={onMenuAction} />
      </div>
    </li>
  );
}
