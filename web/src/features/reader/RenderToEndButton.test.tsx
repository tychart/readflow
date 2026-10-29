import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, test, vi } from "vitest";

import { RenderToEndButton } from "./RenderToEndButton";

describe("RenderToEndButton", () => {
  test("requests a full render when clicked", async () => {
    const user = userEvent.setup();
    const onRenderToEnd = vi.fn();

    render(
      <RenderToEndButton
        enabled={false}
        isTerminal={false}
        onRenderToEnd={onRenderToEnd}
      />,
    );

    await user.click(screen.getByRole("button", { name: /Render the rest of this job now/ }));

    expect(onRenderToEnd).toHaveBeenCalledTimes(1);
  });

  test("becomes inert once the job already renders to the end", () => {
    render(<RenderToEndButton enabled isTerminal={false} onRenderToEnd={vi.fn()} />);

    const button = screen.getByRole("button", { name: /already renders to the end/ });
    expect(button).toBeDisabled();
    expect(button).toHaveTextContent("Rendering rest");
  });

  test("is not rendered for a terminal job", () => {
    render(<RenderToEndButton enabled={false} isTerminal onRenderToEnd={vi.fn()} />);

    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
});
