import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, test, vi } from "vitest";

import type { PwaUpdateController } from "../pwa/updates";
import { PwaUpdatePrompt } from "./PwaUpdatePrompt";

function createUpdates() {
  let listener: ((updateReady: boolean) => void) | null = null;
  const reload = vi.fn().mockResolvedValue(undefined);
  const updates: PwaUpdateController = {
    start: vi.fn(),
    subscribe: vi.fn((nextListener) => {
      listener = nextListener;
      nextListener(false);
      return () => {
        listener = null;
      };
    }),
    reload,
  };
  return {
    updates,
    notifyReady: () => listener?.(true),
    reload,
  };
}

describe("PwaUpdatePrompt", () => {
  test("stays hidden until a waiting service worker reports an update", () => {
    const { updates, notifyReady } = createUpdates();
    render(<PwaUpdatePrompt placement="default" updates={updates} />);

    expect(screen.queryByTestId("pwa-update-prompt")).toBeNull();

    act(notifyReady);

    expect(
      screen.getByRole("button", { name: /new version available.*reload/i }),
    ).toBeInTheDocument();
  });

  test("asks the update controller to activate the new version", async () => {
    const user = userEvent.setup();
    const { updates, notifyReady, reload } = createUpdates();
    render(<PwaUpdatePrompt placement="default" updates={updates} />);
    act(notifyReady);

    await user.click(
      screen.getByRole("button", { name: /new version available.*reload/i }),
    );

    expect(reload).toHaveBeenCalledOnce();
  });

  test("raises itself above phone reader controls", () => {
    const { updates, notifyReady } = createUpdates();
    render(<PwaUpdatePrompt placement="above-reader-dock" updates={updates} />);
    act(notifyReady);

    expect(screen.getByTestId("pwa-update-prompt")).toHaveAttribute(
      "data-placement",
      "above-reader-dock",
    );
  });
});
