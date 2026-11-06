import { describe, expect, it } from "vitest";

import type {
  LibraryFolder,
  LibraryJob,
  LibrarySnapshot,
} from "../../types/api";
import {
  buildFolderTree,
  filterLibrary,
  folderContents,
  folderPath,
  jobsInFolders,
  progressPercent,
  rangeSelection,
  readStateLabel,
  reorderIds,
  selectionItems,
  toggleSelection,
} from "./library-model";

const folder = (
  id: string,
  name: string,
  parent_id: string | null = null,
  position = 0,
  extra: Partial<LibraryFolder> = {},
): LibraryFolder => ({
  id,
  name,
  parent_id,
  position,
  job_count: 0,
  folder_count: 0,
  progress_fraction: 0,
  ...extra,
});

const job = (
  id: string,
  title: string,
  folder_id: string | null,
  position = 0,
  read: "unread" | "in_progress" | "read" = "unread",
): LibraryJob => ({
  id,
  title,
  status: "completed",
  voice_id: "suzy",
  model_id: "model",
  is_active_listening: false,
  render_to_end: false,
  total_chunks_emitted: 10,
  total_chunks_completed: 10,
  buffered_seconds: 0,
  completed_seconds: 0,
  folder_id,
  position,
  progress: {
    fraction: read === "read" ? 1 : read === "in_progress" ? 0.4 : 0,
    read_status: read,
    heard_chunks: [],
    remaining_seconds: read === "read" ? 0 : 600,
    position_seconds: 0,
  },
});

function snapshot(): LibrarySnapshot {
  return {
    folders: [
      folder("books", "Books", null, 1, { job_count: 3 }),
      folder("scifi", "Sci-fi", "books", 0),
      folder("history", "History", "books", 1),
      folder("notes", "Notes", null, 0),
    ],
    jobs: [
      job("b1", "Dune", "books", 0, "read"),
      job("b2", "Hyperion", "books", 1, "in_progress"),
      job("s1", "Foundation", "scifi", 0),
      job("r1", "Loose essay", null, 0),
    ],
    trash_count: 2,
  };
}

describe("tree", () => {
  it("nests folders and keeps folders before jobs", () => {
    const { roots, rootJobs } = buildFolderTree(snapshot());
    expect(roots.map((node) => node.folder.id)).toEqual(["notes", "books"]);
    const books = roots[1];
    expect(books.folders.map((node) => node.folder.id)).toEqual([
      "scifi",
      "history",
    ]);
    expect(books.jobs.map((item) => item.id)).toEqual(["b1", "b2"]);
    expect(rootJobs.map((item) => item.id)).toEqual(["r1"]);
  });

  it("builds root-to-folder paths", () => {
    const folders = snapshot().folders;
    expect(folderPath(folders, "scifi").map((item) => item.name)).toEqual([
      "Books",
      "Sci-fi",
    ]);
    expect(folderPath(folders, null)).toEqual([]);
    expect(folderPath(folders, "missing")).toEqual([]);
  });

  it("lists only the selected folder's direct children", () => {
    const contents = folderContents(snapshot(), "books");
    expect(contents.folders.map((item) => item.id)).toEqual([
      "scifi",
      "history",
    ]);
    expect(contents.jobs.map((item) => item.id)).toEqual(["b1", "b2"]);
  });
});

describe("filter", () => {
  it("searches folders and jobs globally", () => {
    const result = filterLibrary(snapshot(), { query: "found", state: "all" });
    expect(result.searching).toBe(true);
    expect(result.jobs.map((item) => item.id)).toEqual(["s1"]);
    expect(result.folders).toEqual([]);
  });

  it("filters by read state", () => {
    const result = filterLibrary(snapshot(), { query: "", state: "read" });
    expect(result.jobs.map((item) => item.id)).toEqual(["b1"]);
  });

  it("does not activate for the default filter", () => {
    const result = filterLibrary(snapshot(), { query: "", state: "all" });
    expect(result.searching).toBe(false);
  });
});

describe("selection", () => {
  it("toggles and expands a folder to its recursive jobs", () => {
    const selection = toggleSelection(new Set(["books"]), "r1");
    expect(selection.has("books")).toBe(true);
    expect(selection.has("r1")).toBe(true);
    const items = selectionItems(snapshot(), selection);
    expect(items).toEqual([
      { kind: "folder", id: "books" },
      { kind: "job", id: "r1" },
    ]);
  });

  it("does not duplicate jobs inside a selected folder", () => {
    const items = selectionItems(
      snapshot(),
      new Set(["books", "b1", "b2", "s1"]),
    );
    expect(items).toEqual([{ kind: "folder", id: "books" }]);
  });

  it("selects a range and reorders by id", () => {
    expect([...rangeSelection(["a", "b", "c"], "a", "c")]).toEqual([
      "a",
      "b",
      "c",
    ]);
    expect(reorderIds(["a", "b", "c"], "c", 0)).toEqual(["c", "a", "b"]);
    expect(reorderIds(["a", "b", "c"], "a", 2)).toEqual(["b", "c", "a"]);
  });

  it("collects recursive job ids for folders", () => {
    expect(jobsInFolders(snapshot(), ["scifi"]).sort()).toEqual(["s1"]);
    expect(jobsInFolders(snapshot(), ["books"]).sort()).toEqual([
      "b1",
      "b2",
      "s1",
    ]);
  });
});

describe("labels", () => {
  it("formats progress and read state", () => {
    const progress = job("x", "X", null, 0, "in_progress");
    expect(progressPercent(progress)).toBe(40);
    expect(readStateLabel(progress)).toBe("40%");
    expect(readStateLabel({ ...progress, progress: null })).toBe("unread");
  });
});
