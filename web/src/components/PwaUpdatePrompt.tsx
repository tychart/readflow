import { useEffect, useState } from "react";

import type { PwaUpdateController } from "../pwa/updates";

export type UpdatePromptPlacement =
  | "default"
  | "above-mini-player"
  | "above-reader-dock";

interface PwaUpdatePromptProps {
  updates: PwaUpdateController;
  placement: UpdatePromptPlacement;
}

/**
 * A waiting service worker is deliberately user-controlled. Reloading swaps the
 * app bundle and tears down the active MediaSource, so an unobtrusive persistent
 * action is safer than interrupting someone who is listening.
 */
export function PwaUpdatePrompt({ updates, placement }: PwaUpdatePromptProps) {
  const [updateReady, setUpdateReady] = useState(false);
  const [isReloading, setIsReloading] = useState(false);

  useEffect(() => {
    const unsubscribe = updates.subscribe(setUpdateReady);
    updates.start();
    return unsubscribe;
  }, [updates]);

  if (!updateReady) return null;

  const reload = async () => {
    setIsReloading(true);
    try {
      await updates.reload();
    } catch {
      // A transient registration failure leaves the waiting worker in place.
      // Keep the prompt usable so the listener can try again.
      setIsReloading(false);
    }
  };

  return (
    <div
      className="pwa-update-prompt fixed left-1/2 z-[45] -translate-x-1/2"
      data-placement={placement}
      data-testid="pwa-update-prompt"
    >
      <button
        aria-live="polite"
        className="flex items-center gap-2 rounded-full border border-[var(--amber)]/35 bg-[var(--surface-raised)] px-3 py-2 text-xs font-medium text-[var(--ink-primary)] shadow-[var(--shadow)] transition hover:bg-[var(--hover-bg)] disabled:cursor-wait disabled:opacity-70"
        disabled={isReloading}
        onClick={() => void reload()}
        type="button"
      >
        <span>New version available</span>
        <span className="rounded-full bg-[var(--amber)] px-2 py-0.5 font-semibold text-[var(--canvas)]">
          {isReloading ? "Reloading…" : "Reload"}
        </span>
      </button>
    </div>
  );
}
