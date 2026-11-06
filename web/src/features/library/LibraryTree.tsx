import { useMemo } from "react";
import type { LibrarySnapshot } from "../../types/api";
import { buildFolderTree, type FolderNode } from "./library-model";

interface LibraryTreeProps {
  snapshot: LibrarySnapshot;
  currentFolderId: string | null;
  expanded: ReadonlySet<string>;
  onToggleExpanded: (folderId: string) => void;
  onSelectFolder: (folderId: string | null) => void;
  onOpenTrash: () => void;
}

/**
 * Nested folder navigation. Folders are the only grouping concept, so the tree
 * is the whole map of the library; jobs live in the pane.
 */
export function LibraryTree({
  snapshot,
  currentFolderId,
  expanded,
  onToggleExpanded,
  onSelectFolder,
  onOpenTrash,
}: LibraryTreeProps) {
  const { roots } = useMemo(() => buildFolderTree(snapshot), [snapshot]);

  const renderNode = (node: FolderNode, depth: number) => {
    const isOpen = expanded.has(node.folder.id);
    const hasChildren = node.folders.length > 0;
    const selected = node.folder.id === currentFolderId;
    return (
      <li key={node.folder.id}>
        <div
          className={`group flex items-center gap-1 rounded-lg pr-1 ${
            selected
              ? "bg-[var(--amber-soft)] text-[var(--amber)]"
              : "text-[var(--ink-secondary)] hover:bg-[var(--hover-bg)] hover:text-[var(--ink-primary)]"
          }`}
          style={{ paddingLeft: `${depth * 12}px` }}
        >
          <button
            aria-label={isOpen ? "Collapse folder" : "Expand folder"}
            className={`flex h-6 w-6 shrink-0 items-center justify-center rounded transition ${
              hasChildren ? "opacity-70 hover:opacity-100" : "opacity-0"
            }`}
            disabled={!hasChildren}
            onClick={() => onToggleExpanded(node.folder.id)}
            tabIndex={hasChildren ? 0 : -1}
            type="button"
          >
            <svg
              aria-hidden="true"
              className={`h-3 w-3 transition-transform ${isOpen ? "rotate-90" : ""}`}
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              viewBox="0 0 12 12"
            >
              <path d="M4 2l4 4-4 4" />
            </svg>
          </button>
          <button
            aria-current={selected ? "page" : undefined}
            className="min-w-0 flex-1 truncate py-1.5 text-left text-sm font-medium"
            onClick={() => onSelectFolder(node.folder.id)}
            type="button"
          >
            {node.folder.name}
          </button>
          {node.folder.job_count > 0 ? (
            <span className="shrink-0 pr-1 text-[10px] tabular-nums opacity-60">
              {node.folder.job_count}
            </span>
          ) : null}
        </div>
        {hasChildren && isOpen ? (
          <ul>{node.folders.map((child) => renderNode(child, depth + 1))}</ul>
        ) : null}
      </li>
    );
  };

  return (
    <nav aria-label="Folders" className="flex h-full flex-col">
      <ul className="space-y-0.5">
        <li>
          <button
            aria-current={currentFolderId === null ? "page" : undefined}
            className={`w-full rounded-lg px-2 py-1.5 text-left text-sm font-semibold transition ${
              currentFolderId === null
                ? "bg-[var(--amber-soft)] text-[var(--amber)]"
                : "text-[var(--ink-primary)] hover:bg-[var(--hover-bg)]"
            }`}
            onClick={() => onSelectFolder(null)}
            type="button"
          >
            Library
          </button>
        </li>
        {roots.map((node) => renderNode(node, 0))}
        {roots.length === 0 ? (
          <li className="px-2 py-2 text-xs text-[var(--ink-secondary)]">
            No folders yet.
          </li>
        ) : null}
      </ul>
      <div className="mt-auto border-t border-[var(--line)] pt-2">
        <button
          className="flex w-full items-center justify-between rounded-lg px-2 py-1.5 text-sm text-[var(--ink-secondary)] transition hover:bg-[var(--hover-bg)] hover:text-[var(--ink-primary)]"
          onClick={onOpenTrash}
          type="button"
        >
          <span>Trash</span>
          {snapshot.trash_count > 0 ? (
            <span className="rounded-full bg-[var(--hover-bg)] px-1.5 text-[10px] tabular-nums">
              {snapshot.trash_count}
            </span>
          ) : null}
        </button>
      </div>
    </nav>
  );
}
