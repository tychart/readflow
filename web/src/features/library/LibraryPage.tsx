import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Navigate, useNavigate, useParams } from "react-router-dom";

import { useAppBootstrap } from "../../hooks/useAppBootstrap";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import { api } from "../../lib/api";
import { useAppStore } from "../../state/store";
import type {
  LibraryFolder,
  LibraryItemRef,
  LibraryJob,
  LibrarySnapshot,
} from "../../types/api";
import { MoveDialog, NewJobDialog, PromptDialog } from "./LibraryDialogs";
import { LibraryPane } from "./LibraryPane";
import { LibraryTree } from "./LibraryTree";
import {
  selectionItems as buildSelectionItems,
  folderContents,
  folderPath,
  type LibraryFilter,
} from "./library-model";
import type { LibraryRowActions } from "./library-types";

type DialogState =
  | { kind: "new-folder" }
  | { kind: "rename-folder"; folder: LibraryFolder }
  | { kind: "rename-job"; job: LibraryJob }
  | { kind: "new-job" }
  | { kind: "move"; items: LibraryItemRef[]; excluded: Set<string> }
  | null;

const DEFAULT_FILTER: LibraryFilter = { query: "", state: "all" };

export function LibraryPage() {
  const { folderId: folderParam } = useParams<{ folderId?: string }>();
  const currentFolderId = folderParam ?? null;
  const navigate = useNavigate();
  const [snapshot, setSnapshot] = useState<LibrarySnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [organize, setOrganize] = useState(false);
  const [selection, setSelection] = useState<ReadonlySet<string>>(new Set());
  const [filter, setFilter] = useState<LibraryFilter>(DEFAULT_FILTER);
  const [dialog, setDialog] = useState<DialogState>(null);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const refreshTimerRef = useRef<number | null>(null);
  const lastEvent = useAppStore((state) => state.lastEvent);
  const isPhone = useMediaQuery(
    "(max-width: 767px)",
    typeof window !== "undefined" ? window.innerWidth < 768 : false,
  );

  // Keep the socket lifecycle honest: it is only needed while something is
  // actually rendering or playing. Folder edits from this tab refresh directly.
  const hasLiveJobs =
    snapshot?.jobs.some(
      (job) => job.status !== "completed" && job.status !== "failed",
    ) ?? false;
  useAppBootstrap(hasLiveJobs);

  const refresh = useCallback(async () => {
    try {
      const next = await api.getLibrary();
      setSnapshot(next);
      setError(null);
    } catch (loadError) {
      setError(
        loadError instanceof Error
          ? loadError.message
          : "Unable to load the library",
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Coalesce live updates: chunk events arrive several times per second while
  // a job renders, and one refetch per burst is enough.
  useEffect(() => {
    if (!lastEvent) return;
    if (
      ![
        "library_changed",
        "job_progress",
        "job_created",
        "job_updated",
        "job_completed",
        "chunk_ready",
      ].includes(lastEvent.type)
    ) {
      return;
    }
    if (refreshTimerRef.current !== null) return;
    refreshTimerRef.current = window.setTimeout(() => {
      refreshTimerRef.current = null;
      void refresh();
    }, 250);
    return () => {
      if (refreshTimerRef.current !== null) {
        window.clearTimeout(refreshTimerRef.current);
        refreshTimerRef.current = null;
      }
    };
  }, [lastEvent, refresh]);

  // Keep the tree path to the open folder expanded when the route changes or
  // the snapshot first arrives.
  useEffect(() => {
    if (!snapshot || !currentFolderId) return;
    const ancestors = folderPath(snapshot.folders, currentFolderId);
    if (ancestors.length === 0) return;
    setExpanded((previous) => {
      const next = new Set(previous);
      for (const folder of ancestors) next.add(folder.id);
      return next;
    });
  }, [currentFolderId, snapshot]);

  useEffect(() => {
    setSelection(new Set());
    setDrawerOpen(false);
  }, [currentFolderId]);

  useEffect(() => {
    if (!organize) setSelection(new Set());
  }, [organize]);

  const flushNotice = useCallback((message: string) => {
    setNotice(message);
    window.setTimeout(() => {
      setNotice((current) => (current === message ? null : current));
    }, 3000);
  }, []);

  const run = useCallback(
    async (action: () => Promise<unknown>, message?: string) => {
      try {
        await action();
        await refresh();
        setError(null);
        if (message) flushNotice(message);
      } catch (actionError) {
        setError(
          actionError instanceof Error
            ? actionError.message
            : "That action could not be completed",
        );
      }
    },
    [flushNotice, refresh],
  );

  const openFolder = (folderId: string | null) => {
    navigate(folderId ? `/library/${folderId}` : "/");
    setDrawerOpen(false);
  };

  const openJob = (jobId: string, play: boolean) => {
    navigate(`/jobs/${jobId}${play ? "?play=1" : ""}`);
  };

  const playFolder = (folderId: string | null) => {
    if (!snapshot) return;
    const jobs = folderContents(snapshot, folderId).jobs;
    if (jobs.length === 0) return;
    const firstUnread =
      jobs.find((job) => (job.progress?.read_status ?? "unread") !== "read") ??
      jobs[0];
    openJob(firstUnread.id, true);
  };

  const actions: LibraryRowActions = {
    openFolder,
    openJob,
    renameFolder: (folder) => setDialog({ kind: "rename-folder", folder }),
    renameJob: (job) => setDialog({ kind: "rename-job", job }),
    move: (items) =>
      setDialog({
        kind: "move",
        items,
        excluded: excludedTargets(snapshot, items),
      }),
    deleteItems: (items) =>
      void run(() => api.deleteLibraryItems(items), "Moved to trash"),
    deleteFolderOnly: (folder) =>
      void run(
        () => api.deleteFolderOnly(folder.id),
        "Folder removed; its jobs moved up",
      ),
    markRead: (items, read) =>
      void run(
        () => api.markLibraryRead(items, read),
        read ? "Marked read" : "Marked unread",
      ),
    reorder: (kind, orderedIds) => {
      if (!snapshot) return;
      const contents = folderContents(snapshot, currentFolderId);
      const folderIds =
        kind === "folder" ? orderedIds : contents.folders.map((f) => f.id);
      const jobIds =
        kind === "job" ? orderedIds : contents.jobs.map((j) => j.id);
      void run(() => api.reorderLibrary(currentFolderId, folderIds, jobIds));
    },
  };

  const visibleIds = useMemo(() => {
    if (!snapshot) return [];
    const contents = folderContents(snapshot, currentFolderId);
    return [
      ...contents.folders.map((folder) => folder.id),
      ...contents.jobs.map((job) => job.id),
    ];
  }, [currentFolderId, snapshot]);

  const toggleSelected = (id: string) => {
    setSelection((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectionItems = useMemo(
    () => (snapshot ? buildSelectionItems(snapshot, selection) : []),
    [selection, snapshot],
  );

  if (loading) {
    return (
      <div className="flex items-center justify-center py-24 text-sm text-[var(--ink-secondary)]">
        <span className="mr-2 inline-block h-4 w-4 animate-spin rounded-full border-2 border-[var(--amber)] border-t-transparent" />
        Loading library…
      </div>
    );
  }

  if (!snapshot) {
    return (
      <div className="mx-auto max-w-xl px-4 py-16 text-center">
        <p className="text-sm text-[var(--rose)]">
          {error ?? "Unable to load the library"}
        </p>
        <button
          className="mt-4 rounded-lg bg-[var(--amber)] px-4 py-2 text-sm font-medium text-[var(--canvas)]"
          onClick={() => void refresh()}
          type="button"
        >
          Retry
        </button>
      </div>
    );
  }

  if (
    currentFolderId &&
    !snapshot.folders.some((f) => f.id === currentFolderId)
  ) {
    return <Navigate replace to="/" />;
  }

  const dialogNode = (() => {
    if (!dialog) return null;
    if (dialog.kind === "new-folder") {
      return (
        <PromptDialog
          confirmLabel="Create folder"
          label="Folder name"
          onCancel={() => setDialog(null)}
          onSubmit={async (name) => {
            await run(
              () => api.createFolder(name, currentFolderId),
              "Folder created",
            );
            setDialog(null);
          }}
          title="New folder"
        />
      );
    }
    if (dialog.kind === "rename-folder") {
      return (
        <PromptDialog
          confirmLabel="Rename"
          initialValue={dialog.folder.name}
          label="Folder name"
          onCancel={() => setDialog(null)}
          onSubmit={async (name) => {
            await run(() => api.renameFolder(dialog.folder.id, name));
            setDialog(null);
          }}
          title="Rename folder"
        />
      );
    }
    if (dialog.kind === "rename-job") {
      return (
        <PromptDialog
          confirmLabel="Rename"
          initialValue={dialog.job.title ?? ""}
          label="Job title"
          onCancel={() => setDialog(null)}
          onSubmit={async (title) => {
            await run(() => api.renameJob(dialog.job.id, title));
            setDialog(null);
          }}
          title="Rename job"
        />
      );
    }
    if (dialog.kind === "new-job") {
      return (
        <NewJobDialog
          folderId={currentFolderId}
          onCancel={() => setDialog(null)}
          onSubmit={async (formData: FormData) => {
            await api.createJob(formData);
            await refresh();
            setDialog(null);
            flushNotice("Job created");
          }}
        />
      );
    }
    return (
      <MoveDialog
        excludedFolderIds={dialog.excluded}
        folders={snapshot.folders}
        onCancel={() => setDialog(null)}
        onMove={(target) => {
          const items = dialog.items;
          setDialog(null);
          void run(() => api.moveLibraryItems(items, target), "Moved").then(
            () => setSelection(new Set()),
          );
        }}
      />
    );
  })();

  return (
    <div className="mx-auto w-full max-w-7xl px-4 py-6 md:px-6 md:py-8">
      {error ? (
        <div
          className="mb-4 rounded-lg border border-rose-900/30 bg-rose-950/30 px-4 py-3 text-sm text-rose-400"
          role="alert"
        >
          {error}
        </div>
      ) : null}
      {notice ? (
        <div
          aria-live="polite"
          className="mb-4 rounded-lg border border-[var(--line)] bg-[var(--surface)] px-4 py-2 text-sm text-[var(--ink-secondary)]"
        >
          {notice}
        </div>
      ) : null}

      <div className="grid grid-cols-[minmax(0,1fr)] gap-6 md:grid-cols-[15rem_minmax(0,1fr)]">
        <aside className="hidden min-h-[60vh] border-r border-[var(--line)] pr-4 md:block">
          <LibraryTree
            currentFolderId={currentFolderId}
            expanded={expanded}
            onOpenTrash={() => navigate("/trash")}
            onSelectFolder={openFolder}
            onToggleExpanded={(folderId) =>
              setExpanded((previous) => {
                const next = new Set(previous);
                if (next.has(folderId)) next.delete(folderId);
                else next.add(folderId);
                return next;
              })
            }
            snapshot={snapshot}
          />
        </aside>

        {isPhone ? (
          <button
            className="mb-2 flex items-center gap-2 rounded-lg border border-[var(--line)] px-3 py-2 text-sm text-[var(--ink-primary)]"
            onClick={() => setDrawerOpen(true)}
            type="button"
          >
            <svg aria-hidden="true" height="14" viewBox="0 0 16 16" width="14">
              <path
                d="M2 4h12M2 8h12M2 12h12"
                stroke="currentColor"
                strokeWidth="1.6"
              />
            </svg>
            Folders
          </button>
        ) : null}

        <LibraryPane
          actions={actions}
          filter={filter}
          folderId={currentFolderId}
          onBulkDelete={() => {
            const items = selectionItems;
            setSelection(new Set());
            void run(() => api.deleteLibraryItems(items), "Moved to trash");
          }}
          onBulkMove={() =>
            setDialog({
              kind: "move",
              items: selectionItems,
              excluded: excludedTargets(snapshot, selectionItems),
            })
          }
          onBulkRead={(read) => {
            const items = selectionItems;
            void run(() => api.markLibraryRead(items, read));
          }}
          onCreateFolder={() => setDialog({ kind: "new-folder" })}
          onCreateJob={() => setDialog({ kind: "new-job" })}
          onFilterChange={setFilter}
          onOpenFolder={openFolder}
          onOpenJob={openJob}
          onPlayFolder={playFolder}
          onSelectAll={() => setSelection(new Set(visibleIds))}
          onToggleOrganize={() => setOrganize((value) => !value)}
          onToggleSelected={toggleSelected}
          organize={organize}
          selection={selection}
          snapshot={snapshot}
        />
      </div>

      {isPhone && drawerOpen ? (
        <div className="fixed inset-0 z-50 flex">
          <button
            aria-label="Close folders"
            className="absolute inset-0 bg-black/50"
            onClick={() => setDrawerOpen(false)}
            type="button"
          />
          <div className="relative z-10 h-full w-72 overflow-y-auto bg-[var(--surface)] p-4 shadow-xl">
            <LibraryTree
              currentFolderId={currentFolderId}
              expanded={expanded}
              onOpenTrash={() => navigate("/trash")}
              onSelectFolder={openFolder}
              onToggleExpanded={(folderId) =>
                setExpanded((previous) => {
                  const next = new Set(previous);
                  if (next.has(folderId)) next.delete(folderId);
                  else next.add(folderId);
                  return next;
                })
              }
              snapshot={snapshot}
            />
          </div>
        </div>
      ) : null}

      {dialogNode}
    </div>
  );
}

function excludedTargets(
  snapshot: LibrarySnapshot | null,
  items: LibraryItemRef[],
): Set<string> {
  const excluded = new Set<string>();
  if (!snapshot) return excluded;
  for (const item of items) {
    if (item.kind !== "folder") continue;
    excluded.add(item.id);
    let changed = true;
    while (changed) {
      changed = false;
      for (const folder of snapshot.folders) {
        if (
          folder.parent_id !== null &&
          excluded.has(folder.parent_id) &&
          !excluded.has(folder.id)
        ) {
          excluded.add(folder.id);
          changed = true;
        }
      }
    }
  }
  return excluded;
}
