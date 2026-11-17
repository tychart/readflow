import { describe, expect, test, vi } from "vitest";

import { createPwaUpdateController } from "./updates";

describe("createPwaUpdateController", () => {
  test("announces a waiting worker and activates it only after reload", async () => {
    let needRefresh: (() => void) | undefined;
    const activate = vi.fn().mockResolvedValue(undefined);
    const register = vi.fn((options) => {
      needRefresh = options.onNeedRefresh;
      return activate;
    });
    const updates = createPwaUpdateController(register);
    const listener = vi.fn();

    updates.subscribe(listener);
    updates.start();

    expect(register).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenLastCalledWith(false);
    expect(activate).not.toHaveBeenCalled();

    needRefresh?.();

    expect(listener).toHaveBeenLastCalledWith(true);
    expect(activate).not.toHaveBeenCalled();

    await updates.reload();

    expect(activate).toHaveBeenCalledOnce();
  });

  test("registers at most once and stops notifying an unsubscribed listener", () => {
    let needRefresh: (() => void) | undefined;
    const register = vi.fn((options) => {
      needRefresh = options.onNeedRefresh;
      return async () => undefined;
    });
    const updates = createPwaUpdateController(register);
    const listener = vi.fn();
    const unsubscribe = updates.subscribe(listener);

    updates.start();
    updates.start();
    unsubscribe();
    needRefresh?.();

    expect(register).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledOnce();
  });
});
