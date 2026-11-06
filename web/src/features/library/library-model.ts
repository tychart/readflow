/**
 * Pure library derivations: tree shape, ordering, filtering and selection.
 *
 * The server owns folder order, read state and aggregate progress. These helpers
 * only arrange the snapshot for rendering and translate UI intent (drag,
 * shift-click, search) into ids.
 */

import type {
  LibraryFolder,
  LibraryItemRef,
  LibraryJob,
  LibrarySnapshot,
  ReadStatus,
} from "../../types/api";

export interface FolderNode {
  folder: LibraryFolder;
  folders: FolderNode[];
  jobs: LibraryJob[];
}

export function buildFolderTree(snapshot: LibrarySnapshot): {
  roots: FolderNode[];
  rootJobs: LibraryJob[];
} {
  const byParent = new Map<string | null, LibraryFolder[]>();
  for (const folder of snapshot.folders) {
    const siblings = byParent.get(folder.parent_id) ?? [];
    siblings.push(folder);
    byParent.set(folder.parent_id, siblings);
  }
  for (const siblings of byParent.values()) {
    siblings.sort(
      (left, right) =>
        left.position - right.position || left.name.localeCompare(right.name),
    );
  }
  const jobsByFolder = new Map<string | null, LibraryJob[]>();
  for (const job of snapshot.jobs) {
    const key = job.folder_id ?? null;
    const siblings = jobsByFolder.get(key) ?? [];
    siblings.push(job);
    jobsByFolder.set(key, siblings);
  }
  for (const siblings of jobsByFolder.values()) {
    siblings.sort((left, right) => left.position - right.position);
  }

  const build = (parentId: string | null): FolderNode[] =>
    (byParent.get(parentId) ?? []).map((folder) => ({
      folder,
      folders: build(folder.id),
      jobs: jobsByFolder.get(folder.id) ?? [],
    }));

  return {
    roots: build(null),
    rootJobs: jobsByFolder.get(null) ?? [],
  };
}

export function findFolder(
  folders: LibraryFolder[],
  folderId: string | null,
): LibraryFolder | null {
  if (folderId === null) return null;
  return folders.find((folder) => folder.id === folderId) ?? null;
}

/** Root-to-folder chain; `null` selects the root library. */
export function folderPath(
  folders: LibraryFolder[],
  folderId: string | null,
): LibraryFolder[] {
  const byId = new Map(folders.map((folder) => [folder.id, folder]));
  const chain: LibraryFolder[] = [];
  let current = folderId;
  while (current) {
    const folder = byId.get(current);
    if (!folder) break;
    chain.push(folder);
    current = folder.parent_id;
  }
  return chain.reverse();
}

/** Direct children of the selected folder, folders first. */
export function folderContents(
  snapshot: LibrarySnapshot,
  folderId: string | null,
): { folders: LibraryFolder[]; jobs: LibraryJob[] } {
  return {
    folders: snapshot.folders
      .filter((folder) => folder.parent_id === folderId)
      .sort((left, right) => left.position - right.position),
    jobs: snapshot.jobs
      .filter((job) => (job.folder_id ?? null) === folderId)
      .sort((left, right) => left.position - right.position),
  };
}

export interface LibraryFilter {
  query: string;
  state: "all" | ReadStatus;
}

/**
 * Search is flat and global: matching folders *and* jobs are shown, because
 * typing a title is an explicit "find this" action. Filters only narrow the
 * view; they never change the manual order.
 */
export function filterLibrary(
  snapshot: LibrarySnapshot,
  filter: LibraryFilter,
): {
  folders: LibraryFolder[];
  jobs: LibraryJob[];
  searching: boolean;
} {
  const query = filter.query.trim().toLowerCase();
  const matchesState = (job: LibraryJob) =>
    filter.state === "all" ||
    (job.progress?.read_status ?? "unread") === filter.state;
  if (!query && filter.state === "all") {
    return { folders: [], jobs: [], searching: false };
  }
  const folders = query
    ? snapshot.folders.filter((folder) =>
        folder.name.toLowerCase().includes(query),
      )
    : [];
  const jobs = snapshot.jobs.filter((job) => {
    if (!matchesState(job)) return false;
    if (!query) return true;
    return (job.title ?? "").toLowerCase().includes(query);
  });
  return { folders, jobs, searching: true };
}

/** Recursive job ids for a folder selection (used by bulk read/delete). */
export function jobsInFolders(
  snapshot: LibrarySnapshot,
  folderIds: Iterable<string>,
): string[] {
  const allowed = new Set(folderIds);
  let changed = true;
  while (changed) {
    changed = false;
    for (const folder of snapshot.folders) {
      if (
        !allowed.has(folder.id) &&
        folder.parent_id !== null &&
        allowed.has(folder.parent_id)
      ) {
        allowed.add(folder.id);
        changed = true;
      }
    }
  }
  return snapshot.jobs
    .filter((job) => {
      const parent = job.folder_id ?? null;
      return parent !== null && allowed.has(parent);
    })
    .map((job) => job.id);
}

export function toggleSelection(
  selection: ReadonlySet<string>,
  id: string,
): Set<string> {
  const next = new Set(selection);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

/** Shift-click range over the currently visible rows (folders or jobs). */
export function rangeSelection(
  orderedIds: string[],
  anchorId: string | null,
  targetId: string,
): Set<string> {
  const targetIndex = orderedIds.indexOf(targetId);
  const anchorIndex = anchorId ? orderedIds.indexOf(anchorId) : -1;
  if (targetIndex < 0 || anchorIndex < 0) return new Set([targetId]);
  const [start, end] =
    anchorIndex <= targetIndex
      ? [anchorIndex, targetIndex]
      : [targetIndex, anchorIndex];
  return new Set(orderedIds.slice(start, end + 1));
}

/** Move `draggedId` so it lands at `targetIndex` in the given order. */
export function reorderIds(
  orderedIds: string[],
  draggedId: string,
  targetIndex: number,
): string[] {
  const without = orderedIds.filter((id) => id !== draggedId);
  const clamped = Math.max(0, Math.min(without.length, targetIndex));
  without.splice(clamped, 0, draggedId);
  return without;
}

/**
 * Selection as API refs. Folders already imply all of their jobs, so selected
 * jobs inside a selected folder are not duplicated.
 */
export function selectionItems(
  snapshot: LibrarySnapshot,
  selection: ReadonlySet<string>,
): LibraryItemRef[] {
  const folderIds = snapshot.folders
    .filter((folder) => selection.has(folder.id))
    .map((folder) => folder.id);
  const coveredJobs = new Set(jobsInFolders(snapshot, folderIds));
  const items: LibraryItemRef[] = folderIds.map((id) => ({
    kind: "folder" as const,
    id,
  }));
  for (const job of snapshot.jobs) {
    if (selection.has(job.id) && !coveredJobs.has(job.id)) {
      items.push({ kind: "job", id: job.id });
    }
  }
  return items;
}

export function progressPercent(job: LibraryJob): number {
  return Math.round((job.progress?.fraction ?? 0) * 100);
}

export function remainingLabel(job: LibraryJob): string {
  const remaining = job.progress?.remaining_seconds ?? 0;
  if (remaining <= 0) return "done";
  const minutes = Math.round(remaining / 60);
  if (minutes < 60) return `${Math.max(1, minutes)}m left`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours}h left` : `${hours}h ${rest}m left`;
}

export function readStateLabel(job: LibraryJob): string {
  const status = job.progress?.read_status ?? "unread";
  if (status === "read") return "read";
  if (status === "unread") return "unread";
  return `${progressPercent(job)}%`;
}
