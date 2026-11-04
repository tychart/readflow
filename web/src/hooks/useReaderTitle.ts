import { useSyncExternalStore } from "react";

import { getReaderTitle, subscribeReaderTitle } from "../state/reader-title";

/** The open reader's job title, or `null` when no reader is open. */
export function useReaderTitle(): string | null {
  return useSyncExternalStore(
    subscribeReaderTitle,
    getReaderTitle,
    getReaderTitle,
  );
}
