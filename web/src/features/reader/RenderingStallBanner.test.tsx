import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { RenderingStallBanner } from "./RenderingStallBanner";

test("explains the stall and offers retry plus dismiss", async () => {
  const user = userEvent.setup();
  const onRetry = vi.fn();
  const onDismiss = vi.fn();

  render(<RenderingStallBanner onDismiss={onDismiss} onRetry={onRetry} />);

  expect(screen.getByRole("status")).toHaveTextContent(/rendering seems stalled/i);

  await user.click(screen.getByRole("button", { name: "Retry" }));
  expect(onRetry).toHaveBeenCalledTimes(1);

  await user.click(
    screen.getByRole("button", { name: /dismiss rendering stall warning/i }),
  );
  expect(onDismiss).toHaveBeenCalledTimes(1);
});

test("shows a retrying state and disables the button", () => {
  render(
    <RenderingStallBanner isRetrying onDismiss={() => {}} onRetry={() => {}} />,
  );

  const retry = screen.getByRole("button", { name: /retrying/i });
  expect(retry).toBeDisabled();
});
