import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { useAppStore } from "../../state/store";
import type { LibraryFolder, LibrarySnapshot } from "../../types/api";
import { LibraryPage } from "./LibraryPage";
import { TrashPage } from "./TrashPage";

const originalFetch = globalThis.fetch;

function folder(
  id: string,
  name: string,
  parent_id: string | null = null,
  position = 0,
): LibraryFolder {
  return {
    id,
    name,
    parent_id,
    position,
    job_count: 0,
    folder_count: 0,
    progress_fraction: 0,
  };
}

function job(
  id: string,
  title: string,
  folder_id: string | null,
  position = 0,
  status: "completed" | "rendering" = "completed",
) {
  return {
    id,
    title,
    status,
    voice_id: "suzy",
    model_id: "model",
    is_active_listening: false,
    render_to_end: false,
    total_chunks_emitted: 4,
    total_chunks_completed: 4,
    buffered_seconds: 0,
    completed_seconds: 0,
    folder_id,
    position,
    progress: {
      fraction: 0.4,
      read_status: "in_progress" as const,
      heard_chunks: [0],
      remaining_seconds: 600,
      position_seconds: 4,
    },
  };
}

function seedLibrary(): LibrarySnapshot {
  return {
    folders: [folder("books", "Books"), folder("notes", "Notes", null, 1)],
    jobs: [
      job("dune", "Dune", "books", 0),
      job("hyperion", "Hyperion", "books", 1),
      job("essay", "Loose essay", null, 0),
    ],
    trash_count: 1,
  };
}

type Call = { method: string; url: string; body: unknown };

function installApi(initial: LibrarySnapshot = seedLibrary()) {
  const library = structuredClone(initial);
  const calls: Call[] = [];
  globalThis.fetch = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      calls.push({ method, url, body });

      if (method === "GET" && url.endsWith("/api/library")) {
        return {
          ok: true,
          status: 200,
          json: async () => structuredClone(library),
        };
      }
      if (method === "GET" && url.endsWith("/api/trash")) {
        return { ok: true, status: 200, json: async () => [] };
      }
      if (method === "POST" && url.endsWith("/api/folders")) {
        const created = folder(
          `f${library.folders.length}`,
          body.name,
          body.parent_id,
        );
        library.folders.push(created);
        return { ok: true, status: 201, json: async () => created };
      }
      if (method === "PATCH" && /\/api\/folders\/[^/]+$/.test(url)) {
        const id = url.split("/").at(-1) ?? "";
        const target = library.folders.find((item) => item.id === id);
        if (target) target.name = body.name;
        return { ok: true, status: 200, json: async () => target };
      }
      if (method === "POST" && url.endsWith("/api/library/read")) {
        return { ok: true, status: 204, json: async () => ({}) };
      }
      if (method === "POST" && url.endsWith("/api/library/delete")) {
        const items = (body.items ?? []) as Array<{ kind: string; id: string }>;
        for (const item of items) {
          if (item.kind === "folder") {
            library.folders = library.folders.filter((f) => f.id !== item.id);
            library.jobs = library.jobs.filter((j) => j.folder_id !== item.id);
          } else {
            library.jobs = library.jobs.filter((j) => j.id !== item.id);
          }
        }
        return { ok: true, status: 204, json: async () => ({}) };
      }
      if (method === "POST" && url.endsWith("/api/library/reorder")) {
        return { ok: true, status: 204, json: async () => ({}) };
      }
      if (method === "POST" && url.endsWith("/api/library/move")) {
        return { ok: true, status: 204, json: async () => ({}) };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    },
  ) as unknown as typeof fetch;
  return { calls, library };
}

function LocationProbe() {
  const location = useLocation();
  return <p>{`${location.pathname}${location.search}`}</p>;
}

function renderLibrary(entry = "/") {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route element={<LibraryPage />} path="/" />
        <Route element={<LibraryPage />} path="/library/:folderId" />
        <Route element={<TrashPage />} path="/trash" />
        <Route element={<LocationProbe />} path="/jobs/:jobId" />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  useAppStore.setState({ lastEvent: null, websocketStatus: "idle" });
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

it("shift-click selects the visible range", async () => {
  const { calls } = installApi();
  const user = userEvent.setup();
  renderLibrary("/library/books");

  await user.click(await screen.findByRole("button", { name: "Organize" }));
  const dune = (await screen.findByText("Dune")).closest("li");
  const hyperion = screen.getByText("Hyperion").closest("li");
  await user.click(
    within(dune as HTMLElement).getByRole("button", { name: /Dune/ }),
  );
  await user.keyboard("{Shift>}");
  await user.click(
    within(hyperion as HTMLElement).getByRole("button", { name: /Hyperion/ }),
  );
  await user.keyboard("{/Shift}");

  await user.click(screen.getByRole("button", { name: "Read" }));
  await waitFor(() => {
    const readCall = calls.find((call) => call.url.endsWith("/library/read"));
    expect(readCall?.body).toEqual({
      items: [
        { kind: "job", id: "dune" },
        { kind: "job", id: "hyperion" },
      ],
      read: true,
    });
  });
});

function dragRow(from: HTMLElement, to: HTMLElement) {
  const dataTransfer = {
    effectAllowed: "none",
    setData: vi.fn(),
  };
  fireEvent.dragStart(from, { dataTransfer });
  fireEvent.dragOver(to, { dataTransfer });
  fireEvent.drop(to, { dataTransfer });
}

it("reorders same-kind rows by dropping one onto another", async () => {
  const { calls } = installApi();
  const user = userEvent.setup();
  renderLibrary("/library/books");

  await user.click(await screen.findByRole("button", { name: "Organize" }));
  const dune = (await screen.findByText("Dune")).closest("li");
  const hyperion = screen.getByText("Hyperion").closest("li");
  dragRow(hyperion as HTMLElement, dune as HTMLElement);

  await waitFor(() => {
    const reorderCall = calls.find((call) =>
      call.url.endsWith("/api/library/reorder"),
    );
    expect(reorderCall?.body).toEqual({
      parent_id: "books",
      folder_ids: [],
      job_ids: ["hyperion", "dune"],
    });
  });
});

it("ignores a drop between a folder and a job", async () => {
  const { calls } = installApi();
  const user = userEvent.setup();
  renderLibrary("/");

  await user.click(await screen.findByRole("button", { name: "Organize" }));
  const pane = screen.getByRole("region", { name: "Folder contents" });
  const folderRow = (await within(pane).findByText("Books")).closest("li");
  const jobRow = within(pane).getByText("Loose essay").closest("li");
  dragRow(folderRow as HTMLElement, jobRow as HTMLElement);

  // Folders and jobs have separate position sequences; a mixed drop used to
  // send a child set the server rejects.
  expect(calls.some((call) => call.url.endsWith("/api/library/reorder"))).toBe(
    false,
  );
});

it("selects only the rows a filter is showing", async () => {
  const { calls } = installApi();
  const user = userEvent.setup();
  renderLibrary("/");

  await user.click(await screen.findByRole("button", { name: "Organize" }));
  await user.type(
    screen.getByRole("searchbox", { name: "Search library" }),
    "Dune",
  );
  await user.click(screen.getByRole("button", { name: "Select all" }));
  await user.click(screen.getByRole("button", { name: "Read" }));

  // Select-all used to take the folder contents, silently including rows the
  // search had hidden.
  await waitFor(() => {
    const readCall = calls.find((call) => call.url.endsWith("/library/read"));
    expect(readCall?.body).toEqual({
      items: [{ kind: "job", id: "dune" }],
      read: true,
    });
  });
});

it("renders the tree and opens a folder", async () => {
  installApi();
  const user = userEvent.setup();
  renderLibrary();

  expect(await screen.findByText("Loose essay")).toBeInTheDocument();
  expect(screen.queryByText("Dune")).not.toBeInTheDocument();

  const tree = screen.getByRole("navigation", { name: "Folders" });
  await user.click(within(tree).getByRole("button", { name: "Books" }));

  expect(
    await screen.findByRole("heading", { name: "Books" }),
  ).toBeInTheDocument();
  expect(screen.getByText("Hyperion")).toBeInTheDocument();
  expect(screen.queryByText("Loose essay")).not.toBeInTheDocument();
});

it("searches folders and jobs globally", async () => {
  installApi();
  const user = userEvent.setup();
  renderLibrary();

  await user.type(
    await screen.findByRole("searchbox", { name: "Search library" }),
    "Hyperion",
  );

  expect(await screen.findByText("Hyperion")).toBeInTheDocument();
  const pane = screen.getByRole("region", { name: "Folder contents" });
  expect(within(pane).queryByText("Dune")).not.toBeInTheDocument();
  expect(within(pane).queryByText("Books")).not.toBeInTheDocument();
});

it("bulk-marks a selection read", async () => {
  const { calls } = installApi();
  const user = userEvent.setup();
  renderLibrary("/library/books");

  await user.click(await screen.findByRole("button", { name: "Organize" }));
  await user.click(screen.getByRole("checkbox", { name: "Select Dune" }));
  await user.click(screen.getByRole("button", { name: "Read" }));

  await waitFor(() => {
    const readCall = calls.find((call) => call.url.endsWith("/library/read"));
    expect(readCall?.body).toEqual({
      items: [{ kind: "job", id: "dune" }],
      read: true,
    });
  });
});

it("creates a folder in the open folder", async () => {
  const { calls } = installApi();
  const user = userEvent.setup();
  renderLibrary("/library/books");

  await user.click(await screen.findByRole("button", { name: "New folder" }));
  await user.type(screen.getByLabelText("Folder name"), "Audiobooks");
  await user.click(screen.getByRole("button", { name: "Create folder" }));

  await waitFor(() => {
    const createCall = calls.find(
      (call) => call.method === "POST" && call.url.endsWith("/api/folders"),
    );
    expect(createCall?.body).toEqual({
      name: "Audiobooks",
      parent_id: "books",
    });
  });
  const tree = screen.getByRole("navigation", { name: "Folders" });
  expect(await within(tree).findByText("Audiobooks")).toBeInTheDocument();
});

it("renames a job from its row menu", async () => {
  const { calls } = installApi();
  const user = userEvent.setup();
  renderLibrary("/library/books");

  const row = (await screen.findByText("Dune")).closest("li");
  expect(row).not.toBeNull();
  await user.click(
    within(row as HTMLElement).getByRole("button", { name: "Row actions" }),
  );
  await user.click(screen.getByRole("button", { name: "Rename…" }));

  const input = screen.getByLabelText("Job title");
  await user.clear(input);
  await user.type(input, "Dune Messiah");
  await user.click(screen.getByRole("button", { name: "Rename" }));

  await waitFor(() =>
    expect(
      calls.some(
        (call) => call.method === "PATCH" && call.url.endsWith("/jobs/dune"),
      ),
    ).toBe(true),
  );
});

it("moves a job to the trash from its row menu", async () => {
  const { calls } = installApi();
  const user = userEvent.setup();
  renderLibrary("/library/books");

  const row = (await screen.findByText("Dune")).closest("li");
  await user.click(
    within(row as HTMLElement).getByRole("button", { name: "Row actions" }),
  );
  await user.click(screen.getByRole("button", { name: "Move to trash" }));

  await waitFor(() => {
    const deleteCall = calls.find((call) =>
      call.url.endsWith("/api/library/delete"),
    );
    expect(deleteCall?.body).toEqual({
      items: [{ kind: "job", id: "dune" }],
    });
  });
});

it("play on a job asks the reader to autoplay", async () => {
  installApi();
  const user = userEvent.setup();
  renderLibrary("/library/books");

  const row = (await screen.findByText("Hyperion")).closest("li");
  await user.click(
    within(row as HTMLElement).getByRole("button", { name: "Play" }),
  );

  expect(await screen.findByText("/jobs/hyperion?play=1")).toBeInTheDocument();
});

it("play folder resumes at the first job that is not read", async () => {
  const library = seedLibrary();
  const firstJob = library.jobs[0];
  if (firstJob.progress) firstJob.progress.read_status = "read";
  installApi(library);
  const user = userEvent.setup();
  renderLibrary("/library/books");

  await user.click(await screen.findByRole("button", { name: "Play folder" }));

  expect(await screen.findByText("/jobs/hyperion?play=1")).toBeInTheDocument();
});

it("restores trashed items", async () => {
  const calls: Call[] = [];
  globalThis.fetch = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      calls.push({ method, url, body: init?.body ?? null });
      if (url.endsWith("/api/trash") && method === "GET") {
        return {
          ok: true,
          status: 200,
          json: async () => [
            {
              id: "entry-1",
              kind: "job",
              name: "Old job",
              parent_id: null,
              job_count: 1,
              created_at: 1_700_000_000,
            },
          ],
        };
      }
      return { ok: true, status: 204, json: async () => ({}) };
    },
  ) as unknown as typeof fetch;
  const user = userEvent.setup();
  renderLibrary("/trash");

  await user.click(await screen.findByRole("button", { name: "Restore" }));

  await waitFor(() =>
    expect(
      calls.some(
        (call) =>
          call.method === "POST" && call.url.endsWith("/api/trash/restore"),
      ),
    ).toBe(true),
  );
});
