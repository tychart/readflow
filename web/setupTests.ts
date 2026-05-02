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
