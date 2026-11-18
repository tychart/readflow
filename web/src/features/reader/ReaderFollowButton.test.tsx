import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";

import { ReaderFollowButton } from "./ReaderFollowButton";

describe("ReaderFollowButton", () => {
  test("shows a muted resumable control while follow is paused", () => {
    const onToggle = vi.fn();
    render(<ReaderFollowButton enabled={false} onToggle={onToggle} />);

    const button = screen.getByRole("button", {
      name: "Resume smart follow",
    });
    expect(button).toHaveAttribute("aria-pressed", "false");
    expect(button).toHaveClass("opacity-65");

    fireEvent.click(button);
    expect(onToggle).toHaveBeenCalledOnce();
  });

  test("announces active following and remains toggleable", () => {
    render(<ReaderFollowButton enabled onToggle={vi.fn()} />);

    const button = screen.getByRole("button", {
      name: "Pause smart follow",
    });
    expect(button).toHaveAttribute("aria-pressed", "true");
    expect(button).toHaveTextContent("Following");
  });
});
