import { useEffect } from "react";

import { liveClient } from "../lib/live-client";

export function useAppBootstrap() {
  useEffect(() => {
    liveClient.retain();
    return () => {
      liveClient.release();
    };
  }, []);
}
