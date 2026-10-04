import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { ConfirmDialog } from "./ConfirmDialog";

test("renders its actions and fires confirm/cancel", async () => {
  const user = userEvent.setup();
  const onConfirm = vi.fn();
  const onCancel = vi.fn();

  render(
    <ConfirmDialog
      confirmLabel="Yes"
      description="Body copy"
      onCancel={onCancel}
      onConfirm={onConfirm}
      title="Are you sure?"
    />,
  );

  expect(screen.getByRole("dialog")).toBeInTheDocument();
  expect(screen.getByText("Body copy")).toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: "Yes" }));
  expect(onConfirm).toHaveBeenCalledTimes(1);

  await user.click(screen.getByRole("button", { name: "Cancel" }));
  expect(onCancel).toHaveBeenCalledTimes(1);
});

test("escape cancels", async () => {
  const onCancel = vi.fn();

  render(
    <ConfirmDialog
      confirmLabel="Yes"
      description="Body"
      onCancel={onCancel}
      onConfirm={vi.fn()}
      title="Title"
    />,
  );

  await userEvent.keyboard("{Escape}");
  expect(onCancel).toHaveBeenCalledTimes(1);
});
