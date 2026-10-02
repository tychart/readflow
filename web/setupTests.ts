import "@testing-library/jest-dom/vitest";

class FakeSourceBuffer extends EventTarget {
  public updating = false;

  appendBuffer(_buffer: BufferSource) {
    void _buffer;
    this.updating = true;
    queueMicrotask(() => {
      this.updating = false;
      this.dispatchEvent(new Event("updateend"));
    });
  }
}

class FakeMediaSource extends EventTarget {
  public readyState = "closed";

  constructor() {
    super();
    queueMicrotask(() => {
      this.readyState = "open";
      this.dispatchEvent(new Event("sourceopen"));
    });
  }

  addSourceBuffer() {
    return new FakeSourceBuffer() as unknown as SourceBuffer;
  }
}

Object.defineProperty(window, "MediaSource", {
  writable: true,
  value: FakeMediaSource,
});

Object.defineProperty(window.URL, "createObjectURL", {
  writable: true,
  value: () => "blob:mock-media-source",
});

Object.defineProperty(window.URL, "revokeObjectURL", {
  writable: true,
  value: () => undefined,
});

/* ── localStorage ──────────────────────────────────────────── */

/**
 * Node 26 exposes an experimental global `localStorage` accessor that
 * resolves to `undefined` unless `--localstorage-file` is passed, and the
 * vitest jsdom environment (where `window` is `globalThis`) leaves it that
 * way. jsdom itself only provides storage for non-opaque origins.
 *
 * Provide a small browser-like in-memory implementation so tests behave
 * like a real browser — the app persists its theme preference here.
 */
const storageMap = new Map<string, string>();

Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    get length() {
      return storageMap.size;
    },
    clear: () => {
      storageMap.clear();
    },
    getItem: (key: string) => (storageMap.has(key) ? storageMap.get(key)! : null),
    key: (index: number) => Array.from(storageMap.keys())[index] ?? null,
    removeItem: (key: string) => {
      storageMap.delete(key);
    },
    setItem: (key: string, value: string) => {
      storageMap.set(key, String(value));
    },
  },
});

/* ── WebSocket (hermetic by default) ──────────────────────── */

/**
 * jsdom does not implement WebSocket, and Node 26 ships a *real* native
 * WebSocket client — so any component test that mounts a bootstrap hook
 * (e.g. AdminPage → useAppBootstrap → liveClient) would silently connect to
 * a live server if one happens to be running on the jsdom origin's port,
 * and real events would overwrite test fixtures.
 *
 * Provide an inert stub that never opens: liveClient simply stays in
 * "connecting" state with no timers. Tests that exercise socket behavior
 * (App.test) override this with their own mock via `vi.stubGlobal`.
 */
class InertWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  readyState = InertWebSocket.CONNECTING;

  addEventListener() {}
  removeEventListener() {}
  send() {}
  close() {}
}

Object.defineProperty(window, "WebSocket", {
  writable: true,
  value: InertWebSocket,
});
