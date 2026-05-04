import { useEffect } from "react";

import { liveClient } from "../lib/live-client";

export function useAppBootstrap(enabled = true) {
  useEffect(() => {
    if (!enabled) {
      return;
    }
    liveClient.retain();
    return () => {
      liveClient.release();
    };
  }, [enabled]);
}
