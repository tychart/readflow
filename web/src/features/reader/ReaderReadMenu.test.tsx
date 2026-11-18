import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";

import { ReaderReadMenu } from "./ReaderReadMenu";

function renderMenu(onOpenDetails?: () => void) {
  render(
    <ReaderReadMenu
      activeChunkIndex={1}
      onMarkAll={vi.fn()}
      onMarkFrom={vi.fn()}
      onOpenDetails={onOpenDetails}
    />,
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Listening state actions" }),
  );
}

describe("ReaderReadMenu", () => {
  test("offers diagnostic details only when an overlay sidebar is available", () => {
    const onOpenDetails = vi.fn();
    renderMenu(onOpenDetails);

    fireEvent.click(screen.getByRole("button", { name: "Open details" }));
    expect(onOpenDetails).toHaveBeenCalledOnce();
  });

  test("does not add a redundant details action without a sidebar callback", () => {
    renderMenu();

    expect(screen.queryByRole("button", { name: "Open details" })).toBeNull();
  });
});
