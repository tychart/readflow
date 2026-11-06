import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";

import { ConfirmDialog } from "../../components/ConfirmDialog";
import { useAppBootstrap } from "../../hooks/useAppBootstrap";
import { api } from "../../lib/api";
import { useAppStore } from "../../state/store";
import type { TrashEntry } from "../../types/api";

type ConfirmState = {
  kind: "purge";
  entryIds: string[];
  empty: boolean;
  count: number;
} | null;

export function TrashPage() {
  const [entries, setEntries] = useState<TrashEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selection, setSelection] = useState<ReadonlySet<string>>(new Set());
  const [confirm, setConfirm] = useState<ConfirmState>(null);
  const lastEvent = useAppStore((state) => state.lastEvent);

  useAppBootstrap(true);

  const refresh = useCallback(async () => {
    try {
      setEntries(await api.getTrash());
      setError(null);
    } catch (loadError) {
      setError(
        loadError instanceof Error
          ? loadError.message
          : "Unable to load the trash",
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (lastEvent?.type === "library_changed") void refresh();
  }, [lastEvent, refresh]);

  const run = useCallback(
    async (action: () => Promise<unknown>) => {
      try {
        await action();
        setSelection(new Set());
        await refresh();
      } catch (actionError) {
        setError(
          actionError instanceof Error
            ? actionError.message
            : "That action could not be completed",
        );
      }
    },
    [refresh],
  );

  if (loading) {
    return (
      <div className="flex items-center justify-center py-24 text-sm text-[var(--ink-secondary)]">
        <span className="mr-2 inline-block h-4 w-4 animate-spin rounded-full border-2 border-[var(--amber)] border-t-transparent" />
        Loading trash…
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-6 md:px-6 md:py-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-xs uppercase tracking-[0.2em] text-[var(--ink-secondary)]">
            Library
          </p>
          <h1 className="mt-1 text-2xl font-bold text-[var(--ink-primary)]">
            Trash
          </h1>
          <p className="mt-1 text-sm text-[var(--ink-secondary)]">
            Restoring a folder brings back everything that was inside it.
          </p>
        </div>
        <Link
          className="rounded-lg border border-[var(--line)] px-3 py-2 text-sm text-[var(--ink-primary)] transition hover:bg-[var(--hover-bg)]"
          to="/"
        >
          Back to library
        </Link>
      </div>

      {error ? (
        <div
          className="mt-4 rounded-lg border border-rose-900/30 bg-rose-950/30 px-4 py-3 text-sm text-rose-400"
          role="alert"
        >
          {error}
        </div>
      ) : null}

      {entries.length === 0 ? (
        <div className="mt-6 rounded-xl border border-dashed border-[var(--line)] px-5 py-12 text-center text-sm text-[var(--ink-secondary)]">
          The trash is empty.
        </div>
      ) : (
        <ul className="mt-4 space-y-1.5">
          {entries.map((entry) => (
            <li
              className="flex items-center gap-3 rounded-lg border border-[var(--line)] bg-[var(--surface)] px-3 py-2.5"
              key={entry.id}
            >
              <input
                aria-label={`Select ${entry.name}`}
                checked={selection.has(entry.id)}
                className="h-4 w-4 accent-[var(--amber)]"
                onChange={() =>
                  setSelection((previous) => {
                    const next = new Set(previous);
                    if (next.has(entry.id)) next.delete(entry.id);
                    else next.add(entry.id);
                    return next;
                  })
                }
                type="checkbox"
              />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium text-[var(--ink-primary)]">
                  {entry.name}
                </div>
                <div className="text-xs text-[var(--ink-secondary)]">
                  {entry.kind === "folder"
                    ? `Folder${entry.job_count ? ` · ${entry.job_count} jobs` : ""}`
                    : "Job"}{" "}
                  · deleted {new Date(entry.created_at * 1000).toLocaleString()}
                </div>
              </div>
              <button
                className="rounded-lg px-2 py-1.5 text-sm text-[var(--ink-primary)] transition hover:bg-[var(--hover-bg)]"
                onClick={() => void run(() => api.restoreTrash([entry.id]))}
                type="button"
              >
                Restore
              </button>
            </li>
          ))}
        </ul>
      )}

      {entries.length > 0 ? (
        <div className="sticky bottom-2 z-20 mt-4 flex flex-wrap items-center gap-2 rounded-xl border border-[var(--line)] bg-[var(--surface-raised)] px-3 py-2 shadow-lg">
          <span className="text-sm text-[var(--ink-secondary)]">
            {selection.size > 0
              ? `${selection.size} selected`
              : `${entries.length} item${entries.length === 1 ? "" : "s"}`}
          </span>
          <span className="flex-1" />
          <button
            className="rounded-lg px-2 py-1.5 text-sm text-[var(--ink-primary)] transition hover:bg-[var(--hover-bg)] disabled:opacity-40"
            disabled={selection.size === 0}
            onClick={() => void run(() => api.restoreTrash([...selection]))}
            type="button"
          >
            Restore selected
          </button>
          <button
            className="rounded-lg px-2 py-1.5 text-sm text-[var(--rose)] transition hover:bg-[var(--hover-bg)] disabled:opacity-40"
            disabled={selection.size === 0}
            onClick={() =>
              setConfirm({
                kind: "purge",
                entryIds: [...selection],
                empty: false,
                count: selection.size,
              })
            }
            type="button"
          >
            Delete forever
          </button>
          <button
            className="rounded-lg px-2 py-1.5 text-sm text-[var(--rose)] transition hover:bg-[var(--hover-bg)]"
            onClick={() =>
              setConfirm({
                kind: "purge",
                entryIds: [],
                empty: true,
                count: entries.length,
              })
            }
            type="button"
          >
            Empty trash
          </button>
        </div>
      ) : null}

      {confirm ? (
        <ConfirmDialog
          confirmLabel="Delete forever"
          description={`Permanently delete ${confirm.count} item${
            confirm.count === 1 ? "" : "s"
          }? Rendered audio is removed and this cannot be undone.`}
          onCancel={() => setConfirm(null)}
          onConfirm={() => {
            const { entryIds, empty } = confirm;
            setConfirm(null);
            void run(() => api.purgeTrash(entryIds, empty));
          }}
          title={confirm.empty ? "Empty the trash?" : "Delete selected items?"}
        />
      ) : null}
    </div>
  );
}
