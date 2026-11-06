import { useMemo, useState } from "react";
import type {
  LibraryFolder,
  LibraryJob,
  LibrarySnapshot,
} from "../../types/api";
import { LibraryRow } from "./LibraryRow";
import type { LibraryFilter as Filter } from "./library-model";
import {
  folderPath as buildPath,
  filterLibrary,
  folderContents,
  reorderIds,
} from "./library-model";
import type { LibraryRowActions, LibraryRowKind } from "./library-types";

interface LibraryPaneProps {
  snapshot: LibrarySnapshot;
  folderId: string | null;
  filter: Filter;
  organize: boolean;
  selection: ReadonlySet<string>;
  actions: LibraryRowActions;
  onFilterChange: (filter: Filter) => void;
  onToggleOrganize: () => void;
  onToggleSelected: (
    id: string,
    event: { shiftKey: boolean; metaKey: boolean },
  ) => void;
  onSelectAll: () => void;
  onBulkMove: () => void;
  onBulkRead: (read: boolean) => void;
  onBulkDelete: () => void;
  onCreateFolder: () => void;
  onCreateJob: () => void;
  onOpenFolder: (folderId: string | null) => void;
  onOpenJob: (jobId: string, play: boolean) => void;
  onPlayFolder: (folderId: string | null) => void;
}

const STATE_FILTERS: Array<{ value: Filter["state"]; label: string }> = [
  { value: "all", label: "All" },
  { value: "unread", label: "Unread" },
  { value: "in_progress", label: "In progress" },
  { value: "read", label: "Read" },
];

export function LibraryPane({
  snapshot,
  folderId,
  filter,
  organize,
  selection,
  actions,
  onFilterChange,
  onToggleOrganize,
  onToggleSelected,
  onSelectAll,
  onBulkMove,
  onBulkRead,
  onBulkDelete,
  onCreateFolder,
  onCreateJob,
  onOpenFolder,
  onOpenJob,
  onPlayFolder,
}: LibraryPaneProps) {
  const path = useMemo(
    () => buildPath(snapshot.folders, folderId),
    [folderId, snapshot.folders],
  );
  const contents = useMemo(
    () => folderContents(snapshot, folderId),
    [folderId, snapshot],
  );
  const filtered = useMemo(
    () => filterLibrary(snapshot, filter),
    [filter, snapshot],
  );
  const [dragging, setDragging] = useState<{
    id: string;
    kind: LibraryRowKind;
  } | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);

  const visibleFolders = filtered.searching
    ? filtered.folders
    : contents.folders;
  const visibleJobs = filtered.searching ? filtered.jobs : contents.jobs;
  const totalRows = visibleFolders.length + visibleJobs.length;

  /**
   * Drop one row onto another of the **same kind**. Folders and jobs have
   * separate position sequences (the UI always shows folders first), so a
   * cross-kind drop has no meaning: it used to insert a folder id into the job
   * order, which the server correctly rejected as a stale child set.
   */
  const reorder = (
    kind: LibraryRowKind,
    dragged: { id: string; kind: LibraryRowKind },
    targetId: string,
  ) => {
    if (filtered.searching || dragged.kind !== kind) return;
    const ordered =
      kind === "folder"
        ? contents.folders.map((folder) => folder.id)
        : contents.jobs.map((job) => job.id);
    const targetIndex = ordered.indexOf(targetId);
    if (targetIndex < 0 || dragged.id === targetId) return;
    actions.reorder(kind, reorderIds(ordered, dragged.id, targetIndex));
  };

  const menuAction = (
    kind: LibraryRowKind,
    folder: LibraryFolder | undefined,
    job: LibraryJob | undefined,
    action: Parameters<typeof rowAction>[0],
  ) => {
    if (action === "play" && kind === "folder" && folder) {
      onPlayFolder(folder.id);
      return;
    }
    rowAction(action, kind, folder, job, actions, onOpenFolder, onOpenJob);
  };

  const folderRow = (folder: LibraryFolder) => (
    <LibraryRow
      dragging={dragging?.id === folder.id}
      dropTarget={
        dragging?.kind === "folder" &&
        dragOverId === folder.id &&
        dragging.id !== folder.id
      }
      folder={folder}
      key={folder.id}
      kind="folder"
      onDragEnd={() => {
        setDragging(null);
        setDragOverId(null);
      }}
      onDragOver={() => setDragOverId(folder.id)}
      onDragStart={() => setDragging({ id: folder.id, kind: "folder" })}
      onDrop={() => {
        if (dragging) reorder("folder", dragging, folder.id);
        setDragging(null);
        setDragOverId(null);
      }}
      onMenuAction={(action) => menuAction("folder", folder, undefined, action)}
      onOpen={() => onOpenFolder(folder.id)}
      onPlay={() => onPlayFolder(folder.id)}
      onToggleSelected={(event) => onToggleSelected(folder.id, event)}
      organize={organize}
      selected={selection.has(folder.id)}
    />
  );

  const jobRow = (job: LibraryJob) => (
    <LibraryRow
      dragging={dragging?.id === job.id}
      dropTarget={
        dragging?.kind === "job" &&
        dragOverId === job.id &&
        dragging.id !== job.id
      }
      job={job}
      key={job.id}
      kind="job"
      onDragEnd={() => {
        setDragging(null);
        setDragOverId(null);
      }}
      onDragOver={() => setDragOverId(job.id)}
      onDragStart={() => setDragging({ id: job.id, kind: "job" })}
      onDrop={() => {
        if (dragging) reorder("job", dragging, job.id);
        setDragging(null);
        setDragOverId(null);
      }}
      onMenuAction={(action) => menuAction("job", undefined, job, action)}
      onOpen={() => onOpenJob(job.id, false)}
      onPlay={() => onOpenJob(job.id, true)}
      onToggleSelected={(event) => onToggleSelected(job.id, event)}
      organize={organize}
      selected={selection.has(job.id)}
    />
  );

  return (
    <section
      aria-label="Folder contents"
      className="flex min-h-[60vh] flex-col"
    >
      {/* Breadcrumb + toolbar */}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <nav
            aria-label="Breadcrumb"
            className="flex flex-wrap items-center gap-1 text-sm"
          >
            <button
              className="rounded px-1 text-[var(--ink-secondary)] transition hover:text-[var(--ink-primary)]"
              onClick={() => onOpenFolder(null)}
              type="button"
            >
              Library
            </button>
            {path.map((folder) => (
              <span className="flex items-center gap-1" key={folder.id}>
                <span
                  aria-hidden="true"
                  className="text-[var(--ink-secondary)]/50"
                >
                  /
                </span>
                <button
                  className="max-w-[16rem] truncate rounded px-1 text-[var(--ink-secondary)] transition hover:text-[var(--ink-primary)]"
                  onClick={() => onOpenFolder(folder.id)}
                  type="button"
                >
                  {folder.name}
                </button>
              </span>
            ))}
          </nav>
          <h1 className="mt-1 truncate text-2xl font-bold text-[var(--ink-primary)]">
            {path.at(-1)?.name ?? "Library"}
          </h1>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {/* The root library is not a playable container: only real folders
              have an order that auto-advance can follow, so a "Play folder"
              button here would promise a sequence that stops after one job.
              Play a row directly instead. */}
          {folderId !== null ? (
            <button
              className="rounded-lg bg-[var(--amber)] px-3 py-2 text-sm font-medium text-[var(--canvas)] transition hover:brightness-110 disabled:opacity-40"
              disabled={contents.jobs.length === 0}
              onClick={() => onPlayFolder(folderId)}
              type="button"
            >
              Play folder
            </button>
          ) : null}
          <button
            className="rounded-lg border border-[var(--line)] px-3 py-2 text-sm text-[var(--ink-primary)] transition hover:bg-[var(--hover-bg)]"
            onClick={onCreateJob}
            type="button"
          >
            New job
          </button>
          <button
            className="rounded-lg border border-[var(--line)] px-3 py-2 text-sm text-[var(--ink-primary)] transition hover:bg-[var(--hover-bg)]"
            onClick={onCreateFolder}
            type="button"
          >
            New folder
          </button>
          <button
            aria-pressed={organize}
            className={`rounded-lg border px-3 py-2 text-sm transition ${
              organize
                ? "border-[var(--amber)]/50 bg-[var(--amber-soft)] text-[var(--amber)]"
                : "border-[var(--line)] text-[var(--ink-primary)] hover:bg-[var(--hover-bg)]"
            }`}
            onClick={onToggleOrganize}
            type="button"
          >
            {organize ? "Done" : "Organize"}
          </button>
        </div>
      </div>

      {/* Search + state filter */}
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <input
          aria-label="Search library"
          className="min-w-0 flex-1 rounded-lg border border-[var(--line)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--ink-primary)] placeholder:text-[var(--ink-secondary)]/60 focus:border-[var(--amber)] focus:outline-none"
          onChange={(event) =>
            onFilterChange({ ...filter, query: event.target.value })
          }
          placeholder="Search folders and jobs…"
          type="search"
          value={filter.query}
        />
        <select
          aria-label="Filter by read state"
          className="rounded-lg border border-[var(--line)] bg-[var(--surface)] px-2 py-2 text-sm text-[var(--ink-primary)] focus:border-[var(--amber)] focus:outline-none"
          onChange={(event) =>
            onFilterChange({
              ...filter,
              state: event.target.value as Filter["state"],
            })
          }
          value={filter.state}
        >
          {STATE_FILTERS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        {organize ? (
          <button
            className="rounded-lg px-2 py-2 text-sm text-[var(--ink-secondary)] transition hover:text-[var(--ink-primary)]"
            onClick={onSelectAll}
            type="button"
          >
            Select all
          </button>
        ) : null}
      </div>

      {filtered.searching ? (
        <p className="mt-3 text-xs text-[var(--ink-secondary)]">
          {totalRows} result{totalRows === 1 ? "" : "s"}
          {filter.query.trim() ? ` for “${filter.query.trim()}”` : ""}
        </p>
      ) : null}

      {(contents.folders.length > 0 || contents.jobs.length > 0) &&
      visibleFolders.length === 0 &&
      visibleJobs.length === 0 ? (
        <div className="mt-6 rounded-xl border border-dashed border-[var(--line)] px-5 py-12 text-center text-sm text-[var(--ink-secondary)]">
          No matches in this folder.
        </div>
      ) : totalRows === 0 && !filtered.searching ? (
        <div className="mt-6 rounded-xl border border-dashed border-[var(--line)] px-5 py-12 text-center text-sm text-[var(--ink-secondary)]">
          This folder is empty. Add a job or create a sub-folder.
        </div>
      ) : null}

      <ul className="mt-3 space-y-1.5">
        {visibleFolders.map((folder) => folderRow(folder))}
        {visibleJobs.map((job) => jobRow(job))}
      </ul>

      {organize && selection.size > 0 ? (
        <div className="sticky bottom-2 z-20 mt-4 flex flex-wrap items-center gap-2 rounded-xl border border-[var(--line)] bg-[var(--surface-raised)] px-3 py-2 shadow-lg">
          <span className="text-sm font-medium text-[var(--ink-primary)]">
            {selection.size} selected
          </span>
          <span className="flex-1" />
          <button
            className="rounded-lg px-2 py-1.5 text-sm text-[var(--ink-primary)] transition hover:bg-[var(--hover-bg)]"
            onClick={onBulkMove}
            type="button"
          >
            Move…
          </button>
          <button
            className="rounded-lg px-2 py-1.5 text-sm text-[var(--ink-primary)] transition hover:bg-[var(--hover-bg)]"
            onClick={() => onBulkRead(true)}
            type="button"
          >
            Read
          </button>
          <button
            className="rounded-lg px-2 py-1.5 text-sm text-[var(--ink-primary)] transition hover:bg-[var(--hover-bg)]"
            onClick={() => onBulkRead(false)}
            type="button"
          >
            Unread
          </button>
          <button
            className="rounded-lg px-2 py-1.5 text-sm text-[var(--rose)] transition hover:bg-[var(--hover-bg)]"
            onClick={onBulkDelete}
            type="button"
          >
            Delete
          </button>
        </div>
      ) : null}
    </section>
  );
}

function rowAction(
  action:
    | "open"
    | "play"
    | "rename"
    | "move"
    | "mark-read"
    | "mark-unread"
    | "delete"
    | "delete-only",
  kind: LibraryRowKind,
  folder: LibraryFolder | undefined,
  job: LibraryJob | undefined,
  actions: LibraryRowActions,
  onOpenFolder: (folderId: string | null) => void,
  onOpenJob: (jobId: string, play: boolean) => void,
) {
  if (action === "open") {
    if (folder) onOpenFolder(folder.id);
    if (job) onOpenJob(job.id, false);
    return;
  }
  if (action === "play") {
    if (job) onOpenJob(job.id, true);
    return;
  }
  if (kind === "folder" && folder) {
    if (action === "rename") actions.renameFolder(folder);
    if (action === "move") actions.move([{ kind: "folder", id: folder.id }]);
    if (action === "mark-read")
      actions.markRead([{ kind: "folder", id: folder.id }], true);
    if (action === "mark-unread")
      actions.markRead([{ kind: "folder", id: folder.id }], false);
    if (action === "delete")
      actions.deleteItems([{ kind: "folder", id: folder.id }]);
    if (action === "delete-only") actions.deleteFolderOnly(folder);
    return;
  }
  if (job) {
    if (action === "rename") actions.renameJob(job);
    if (action === "move") actions.move([{ kind: "job", id: job.id }]);
    if (action === "mark-read")
      actions.markRead([{ kind: "job", id: job.id }], true);
    if (action === "mark-unread")
      actions.markRead([{ kind: "job", id: job.id }], false);
    if (action === "delete") actions.deleteItems([{ kind: "job", id: job.id }]);
  }
}
