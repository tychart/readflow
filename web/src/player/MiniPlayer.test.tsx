import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";

import { MiniPlayer } from "./MiniPlayer";
import { resetPlayerStore, usePlayerStore } from "./player-store";

const originalFetch = globalThis.fetch;

afterEach(() => {
  cleanup();
  resetPlayerStore();
  globalThis.fetch = originalFetch;
});

function seedPlayer(
  overrides: Partial<ReturnType<typeof usePlayerStore.getState>> = {},
) {
  usePlayerStore.setState({
    job: {
      id: "job-1",
      title: "A long book",
      isTerminal: false,
      audioEpoch: 0,
      folderId: null,
      nextJobId: "job-2",
      previousJobId: null,
    },
    currentTimeSeconds: 30,
    renderedDurationSeconds: 120,
    anchorOffsetSeconds: 0,
    durationSeconds: 300,
    ...overrides,
  });
}

function renderMiniPlayer() {
  return render(
    <MemoryRouter>
      <MiniPlayer />
    </MemoryRouter>,
  );
}

it("renders nothing when no job is open", () => {
  renderMiniPlayer();
  expect(screen.queryByLabelText("Now playing")).not.toBeInTheDocument();
});

it("shows the open job, its progress and a link back to the reader", async () => {
  seedPlayer();
  renderMiniPlayer();

  expect(screen.getByText("A long book")).toBeInTheDocument();
  const link = screen.getByRole("link");
  expect(link).toHaveAttribute("href", "/jobs/job-1");
  expect(screen.getByLabelText("Now playing")).toBeInTheDocument();
});

it("starts playback through the same activate path as the reader", async () => {
  const fetchMock = vi.fn(async (_input: RequestInfo | URL) => ({
    ok: true,
    json: async () => ({}),
  }));
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  seedPlayer();
  renderMiniPlayer();

  await userEvent.click(screen.getByRole("button", { name: "Play" }));

  await waitFor(() => expect(usePlayerStore.getState().playIntent).toBe(true));
  expect(
    fetchMock.mock.calls.some(([url]) => String(url).endsWith("/activate")),
  ).toBe(true);
});

it("does not activate a terminal job", async () => {
  const fetchMock = vi.fn(async (_input: RequestInfo | URL) => ({
    ok: true,
    json: async () => ({}),
  }));
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  seedPlayer({
    job: {
      id: "job-1",
      title: "Finished book",
      isTerminal: true,
      audioEpoch: 0,
      folderId: null,
      nextJobId: null,
      previousJobId: null,
    },
  });
  renderMiniPlayer();

  await userEvent.click(screen.getByRole("button", { name: "Play" }));

  expect(usePlayerStore.getState().playIntent).toBe(true);
  expect(fetchMock).not.toHaveBeenCalled();
});

it("pauses through the store", async () => {
  usePlayerStore.setState({ playIntent: true });
  seedPlayer({ playIntent: true });
  renderMiniPlayer();

  await userEvent.click(screen.getByRole("button", { name: "Pause" }));

  expect(usePlayerStore.getState().playIntent).toBe(false);
});
