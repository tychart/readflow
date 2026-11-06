import type {
  LibraryFolder,
  LibraryItemRef,
  LibraryJob,
} from "../../types/api";

export type LibraryRowKind = "folder" | "job";

export interface LibraryRowActions {
  openFolder(folderId: string | null): void;
  openJob(jobId: string, play: boolean): void;
  renameFolder(folder: LibraryFolder): void;
  renameJob(job: LibraryJob): void;
  move(items: LibraryItemRef[]): void;
  deleteItems(items: LibraryItemRef[]): void;
  deleteFolderOnly(folder: LibraryFolder): void;
  markRead(items: LibraryItemRef[], read: boolean): void;
  reorder(kind: LibraryRowKind, orderedIds: string[]): void;
}
