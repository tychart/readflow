import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";

import { ReaderEndCard } from "./ReaderEndCard";

function renderCard(
  overrides: Partial<Parameters<typeof ReaderEndCard>[0]> = {},
) {
  const props = {
    folderName: "Books",
    nextJobTitle: null,
    continuousPlay: true,
    onReplay: vi.fn(),
    onPlayNext: vi.fn(),
    onBackToLibrary: vi.fn(),
    ...overrides,
  };
  render(<ReaderEndCard {...props} />);
  return props;
}

it("says it was the last job only when the folder really has no next job", () => {
  renderCard();
  expect(screen.getByText("End of Books")).toBeInTheDocument();
  expect(
    screen.getByText("This was the last job in the folder."),
  ).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Play next" })).toBeNull();
});

it("names the next job instead of claiming the folder ended", () => {
  renderCard({ nextJobTitle: "Second book" });
  expect(screen.getByText("Up next: Second book")).toBeInTheDocument();
  expect(screen.queryByText("This was the last job in the folder.")).toBeNull();
  expect(
    screen.getByText("Continuous play is on, so it opens automatically."),
  ).toBeInTheDocument();
});

it("offers to open the next job when continuous play is off", async () => {
  const props = renderCard({
    nextJobTitle: "Second book",
    continuousPlay: false,
  });
  expect(
    screen.getByText(
      "Continuous play is off: open the next job when you are ready.",
    ),
  ).toBeInTheDocument();
  await userEvent
    .setup()
    .click(screen.getByRole("button", { name: "Play next" }));
  expect(props.onPlayNext).toHaveBeenCalledTimes(1);
});

it("explains that a root job has nothing to advance to", () => {
  renderCard({ folderName: null });
  expect(screen.getByText("You reached the end")).toBeInTheDocument();
  expect(
    screen.getByText(
      "This job is not in a folder, so there is nothing to play next.",
    ),
  ).toBeInTheDocument();
});
