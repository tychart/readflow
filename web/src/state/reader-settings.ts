/**
 * Reader preferences.
 *
 * These are device-local UI preferences (not job state), so they live in
 * `localStorage` rather than the workspace `zustand` store or the backend — the
 * project deliberately has no database and no accounts.
 *
 * The module keeps a cached snapshot because `useSyncExternalStore` requires a
 * referentially stable value between notifications.
 */

export type MotionMode = "auto" | "reduced" | "always";
export type ConveyorWindowSize = "auto" | 3 | 4 | 5;

export interface ReaderSettings {
  /** Whether the sub playbar animates, forces animation, or snaps. */
  motionMode: MotionMode;
  /** Show the reader's chunk conveyor (the sub playbar). */
  showConveyor: boolean;
  /** Show the per-chunk jump control in the reader text. */
  showChunkJumpButtons: boolean;
  /** Chunk slots visible in the conveyor; "auto" adapts to viewport width. */
  conveyorWindowSize: ConveyorWindowSize;
}

export const DEFAULT_READER_SETTINGS: ReaderSettings = {
  motionMode: "auto",
  showConveyor: true,
  showChunkJumpButtons: true,
  conveyorWindowSize: "auto",
};

export const READER_SETTINGS_STORAGE_KEY = "readflow.reader-settings.v1";

const MOTION_MODES: readonly MotionMode[] = ["auto", "reduced", "always"];
const WINDOW_SIZES: readonly ConveyorWindowSize[] = ["auto", 3, 4, 5];

/**
 * Coerce anything (corrupt storage, an older schema, a hand-edited value) into a
 * valid settings object, field by field. Unknown values fall back to the
 * default for that field rather than discarding the whole object, so one bad
 * value never resets everything else.
 */
export function sanitizeReaderSettings(raw: unknown): ReaderSettings {
  if (!raw || typeof raw !== "object") return { ...DEFAULT_READER_SETTINGS };
  const value = raw as Partial<Record<keyof ReaderSettings, unknown>>;
  return {
    motionMode: MOTION_MODES.includes(value.motionMode as MotionMode)
      ? (value.motionMode as MotionMode)
      : DEFAULT_READER_SETTINGS.motionMode,
    showConveyor:
      typeof value.showConveyor === "boolean"
        ? value.showConveyor
        : DEFAULT_READER_SETTINGS.showConveyor,
    showChunkJumpButtons:
      typeof value.showChunkJumpButtons === "boolean"
        ? value.showChunkJumpButtons
        : DEFAULT_READER_SETTINGS.showChunkJumpButtons,
    conveyorWindowSize: WINDOW_SIZES.includes(value.conveyorWindowSize as ConveyorWindowSize)
      ? (value.conveyorWindowSize as ConveyorWindowSize)
      : DEFAULT_READER_SETTINGS.conveyorWindowSize,
  };
}

/** Combine the user's motion preference with the OS setting. */
export function resolveAnimatedMotion(
  mode: MotionMode,
  prefersReducedMotion: boolean,
): "animated" | "reduced" {
  if (mode === "always") return "animated";
  if (mode === "reduced") return "reduced";
  return prefersReducedMotion ? "reduced" : "animated";
}

/* ── Store ────────────────────────────────────────────────── */

let cached: ReaderSettings | null = null;
const listeners = new Set<() => void>();

function loadFromStorage(): ReaderSettings {
  if (typeof localStorage === "undefined") return { ...DEFAULT_READER_SETTINGS };
  try {
    const raw = localStorage.getItem(READER_SETTINGS_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_READER_SETTINGS };
    return sanitizeReaderSettings(JSON.parse(raw));
  } catch {
    // Corrupt or unreadable storage must never break the reader.
    return { ...DEFAULT_READER_SETTINGS };
  }
}

function persist(settings: ReaderSettings): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(READER_SETTINGS_STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Quota/private-mode failures are not worth surfacing to the reader.
  }
}

function notify(): void {
  for (const listener of listeners) listener();
}

/** Current settings snapshot (stable reference until they change). */
export function getReaderSettings(): ReaderSettings {
  if (!cached) cached = loadFromStorage();
  return cached;
}

export function subscribeReaderSettings(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function setReaderSettings(patch: Partial<ReaderSettings>): void {
  cached = sanitizeReaderSettings({ ...getReaderSettings(), ...patch });
  persist(cached);
  notify();
}

export function resetReaderSettings(): void {
  cached = { ...DEFAULT_READER_SETTINGS };
  persist(cached);
  notify();
}

/** Drop the in-memory cache so the next read reloads from storage (tests). */
export function invalidateReaderSettingsCache(): void {
  cached = null;
}
