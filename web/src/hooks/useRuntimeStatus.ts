import { useEffect } from "react";

import { api } from "../lib/api";
import { useAppStore } from "../state/store";
import type { RuntimeStatus } from "../types/api";

/**
 * The GPU's current model/voice commitment.
 *
 * Kept fresh by the `scheduler_state` WebSocket tick (the store applies it
 * regardless of whether the admin view is loaded) and fetched once on mount so
 * the first render has a value even when no live job has opened the socket yet.
 * This is advisory UI state: a failed fetch just means no default/warning.
 */
export function useRuntimeStatus(): RuntimeStatus | null {
  const runtimeStatus = useAppStore((state) => state.runtimeStatus);
  const setRuntimeStatus = useAppStore((state) => state.setRuntimeStatus);

  useEffect(() => {
    if (runtimeStatus) return;
    let cancelled = false;
    void api
      .getStatus()
      .then((status) => {
        if (!cancelled && status) setRuntimeStatus(status);
      })
      .catch(() => {
        /* advisory only */
      });
    return () => {
      cancelled = true;
    };
  }, [runtimeStatus, setRuntimeStatus]);

  return runtimeStatus;
}
