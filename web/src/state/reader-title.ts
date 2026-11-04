/**
 * The title of the job the reader currently has open.
 *
 * The reader is the only writer (it is what loaded the job) and the app header
 * is the only consumer, so this is a three-function store rather than a context
 * or a zustand slice: nothing but the display string crosses it, and it is not
 * job state — the header must not grow a dependency on the reader's data model
 * to label itself.
 *
 * The fade is deliberately *not* in here. It interpolates on the reader's
 * `--scroll-progress` custom property (see `useScrollProgressVar`), so scrolling
 * still renders nothing; only opening or closing a reader touches this store.
 */
let currentTitle: string | null = null;
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

/**
 * Publishes the open job's title, or `null` when no reader is open.
 *
 * Blank/whitespace-only titles clear it instead: the header renders the string
 * as-is and an empty label is worse than no label.
 */
export function setReaderTitle(title: string | null): void {
  const next = title?.trim() ? title.trim() : null;
  if (next === currentTitle) return;
  currentTitle = next;
  notify();
}

export function getReaderTitle(): string | null {
  return currentTitle;
}

export function subscribeReaderTitle(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Test helper: drop the title and its subscribers. */
export function resetReaderTitle(): void {
  currentTitle = null;
  listeners.clear();
}
