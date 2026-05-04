import { act, render, waitFor } from "@testing-library/react";
import { useEffect } from "react";

import { useMediaSourcePlayer } from "./media-source";
import type { JobManifest } from "../types/api";

const originalMediaSource = window.MediaSource;

function buildManifest(chunkIndexes: number[]): JobManifest {
  return {
    mime_type: 'audio/mp4; codecs="mp4a.40.2"',
    init_segment_url: "/api/jobs/job-1/chunks/init",
    chunks: chunkIndexes.map((index) => ({
      index,
      status: "written",
      duration_seconds: 2,
      start_seconds: index * 2,
      plan_version: 1,
      voice_id: "suzy",
      segment_url: `/api/jobs/job-1/chunks/${index}`,
    })),
  };
}

function buildPendingManifest(): JobManifest {
  return {
    mime_type: 'audio/mp4; codecs="mp4a.40.2"',
    init_segment_url: null,
    chunks: [],
  };
}

function installRecordingMediaSource(recording: number[], getBufferedEnd: () => number) {
  class RecordingSourceBuffer extends EventTarget {
    public updating = false;

    appendBuffer(buffer: BufferSource) {
      const bytes =
        buffer instanceof ArrayBuffer ? new Uint8Array(buffer) : new Uint8Array(buffer.buffer);
      recording.push(bytes[0] ?? 0);
      this.updating = true;
      queueMicrotask(() => {
        this.updating = false;
        this.dispatchEvent(new Event("updateend"));
      });
      void getBufferedEnd();
    }
  }

  class RecordingMediaSource extends EventTarget {
    public readyState = "closed";

    constructor() {
      super();
      queueMicrotask(() => {
        this.readyState = "open";
        this.dispatchEvent(new Event("sourceopen"));
      });
    }

    addSourceBuffer() {
      return new RecordingSourceBuffer() as unknown as SourceBuffer;
    }
  }

  Object.defineProperty(window, "MediaSource", {
    writable: true,
    value: RecordingMediaSource,
  });
}

function installBufferedAudioState(getBufferedEnd: () => number) {
  Object.defineProperty(HTMLMediaElement.prototype, "buffered", {
    configurable: true,
    get() {
      const bufferedEnd = getBufferedEnd();
      return {
        length: bufferedEnd > 0 ? 1 : 0,
        end: () => bufferedEnd,
        start: () => 0,
      };
    },
  });
}

beforeEach(() => {
  HTMLMediaElement.prototype.pause = vi.fn();
  HTMLMediaElement.prototype.load = vi.fn();
});

afterEach(() => {
  Object.defineProperty(window, "MediaSource", {
    writable: true,
    value: originalMediaSource,
  });
});

test("appends init and media chunks in ascending index order", async () => {
  let bufferedEnd = 0;
  const appendedMarkers: number[] = [];
  installBufferedAudioState(() => bufferedEnd);
  installRecordingMediaSource(appendedMarkers, () => bufferedEnd);

  global.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/init")) {
      bufferedEnd = 0.5;
      return { ok: true, arrayBuffer: async () => new Uint8Array([9]).buffer };
    }
    if (url.endsWith("/chunks/0")) {
      bufferedEnd = 2;
      return { ok: true, arrayBuffer: async () => new Uint8Array([1]).buffer };
    }
    bufferedEnd = 4;
    return { ok: true, arrayBuffer: async () => new Uint8Array([2]).buffer };
  }) as typeof fetch;

  function Harness() {
    const { audioRef, appendedChunksCount, isReady } = useMediaSourcePlayer({
      jobId: "job-1",
      manifest: buildManifest([0, 1]),
      playIntent: false,
      isTerminal: false,
    });
    return (
      <div data-appended={String(appendedChunksCount)} data-ready={isReady ? "yes" : "no"}>
        <audio ref={audioRef} />
      </div>
    );
  }

  const { container } = render(<Harness />);

  await waitFor(() => expect(container.firstChild).toHaveAttribute("data-ready", "yes"));
  await waitFor(() => expect(container.firstChild).toHaveAttribute("data-appended", "2"));
  expect(appendedMarkers).toEqual([9, 1, 2]);
});

test("uses sequence mode so independently packaged chunks play in append order", async () => {
  let bufferedEnd = 0;
  let sourceBufferMode = "segments";

  class SequenceAwareSourceBuffer extends EventTarget {
    public updating = false;
    public mode: AppendMode = "segments";

    appendBuffer() {
      sourceBufferMode = this.mode;
      this.updating = true;
      queueMicrotask(() => {
        this.updating = false;
        this.dispatchEvent(new Event("updateend"));
      });
    }
  }

  class SequenceAwareMediaSource extends EventTarget {
    public readyState = "closed";

    constructor() {
      super();
      queueMicrotask(() => {
        this.readyState = "open";
        this.dispatchEvent(new Event("sourceopen"));
      });
    }

    addSourceBuffer() {
      return new SequenceAwareSourceBuffer() as unknown as SourceBuffer;
    }
  }

  Object.defineProperty(window, "MediaSource", {
    writable: true,
    value: SequenceAwareMediaSource,
  });
  installBufferedAudioState(() => bufferedEnd);

  global.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/init")) {
      bufferedEnd = 0.5;
      return { ok: true, arrayBuffer: async () => new Uint8Array([9]).buffer };
    }
    bufferedEnd = 2;
    return { ok: true, arrayBuffer: async () => new Uint8Array([1]).buffer };
  }) as typeof fetch;

  function Harness() {
    const { audioRef, appendedChunksCount } = useMediaSourcePlayer({
      jobId: "job-1",
      manifest: buildManifest([0]),
      playIntent: false,
      isTerminal: false,
    });
    return (
      <div data-appended={String(appendedChunksCount)}>
        <audio ref={audioRef} />
      </div>
    );
  }

  const { container } = render(<Harness />);

  await waitFor(() => expect(container.firstChild).toHaveAttribute("data-appended", "1"));
  expect(sourceBufferMode).toBe("sequence");
});

test("does not recreate the media source when the manifest object changes but the stream key stays the same", async () => {
  let bufferedEnd = 0;
  const appendedMarkers: number[] = [];
  let mediaSourceCount = 0;

  class StableSourceBuffer extends EventTarget {
    public updating = false;

    appendBuffer(buffer: BufferSource) {
      const bytes =
        buffer instanceof ArrayBuffer ? new Uint8Array(buffer) : new Uint8Array(buffer.buffer);
      appendedMarkers.push(bytes[0] ?? 0);
      this.updating = true;
      queueMicrotask(() => {
        this.updating = false;
        this.dispatchEvent(new Event("updateend"));
      });
    }
  }

  class StableMediaSource extends EventTarget {
    public readyState = "closed";

    constructor() {
      super();
      mediaSourceCount += 1;
      queueMicrotask(() => {
        this.readyState = "open";
        this.dispatchEvent(new Event("sourceopen"));
      });
    }

    addSourceBuffer() {
      return new StableSourceBuffer() as unknown as SourceBuffer;
    }
  }

  Object.defineProperty(window, "MediaSource", {
    writable: true,
    value: StableMediaSource,
  });
  installBufferedAudioState(() => bufferedEnd);

  global.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/init")) {
      bufferedEnd = 0.5;
      return { ok: true, arrayBuffer: async () => new Uint8Array([9]).buffer };
    }
    if (url.endsWith("/chunks/0")) {
      bufferedEnd = 2;
      return { ok: true, arrayBuffer: async () => new Uint8Array([1]).buffer };
    }
    bufferedEnd = 4;
    return { ok: true, arrayBuffer: async () => new Uint8Array([2]).buffer };
  }) as typeof fetch;

  function Harness({
    manifest,
    playIntent = false,
  }: {
    manifest: JobManifest;
    playIntent?: boolean;
  }) {
    const { audioRef, appendedChunksCount } = useMediaSourcePlayer({
      jobId: "job-1",
      manifest,
      playIntent,
      isTerminal: false,
    });
    return (
      <div data-appended={String(appendedChunksCount)}>
        <audio ref={audioRef} />
      </div>
    );
  }

  const { container, rerender } = render(<Harness manifest={buildManifest([0])} />);

  await waitFor(() => expect(container.firstChild).toHaveAttribute("data-appended", "1"));

  rerender(<Harness manifest={buildManifest([0, 1])} />);

  await waitFor(() => expect(container.firstChild).toHaveAttribute("data-appended", "2"));
  expect(mediaSourceCount).toBe(1);
  expect(appendedMarkers).toEqual([9, 1, 2]);
});

test("tries to resume playback after waiting when play intent remains true and new audio arrives", async () => {
  let bufferedEnd = 0;
  const playMock = vi.fn().mockResolvedValue(undefined);

  installBufferedAudioState(() => bufferedEnd);
  installRecordingMediaSource([], () => bufferedEnd);
  HTMLMediaElement.prototype.play = playMock;

  global.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/init")) {
      return { ok: true, arrayBuffer: async () => new Uint8Array([9]).buffer };
    }
    bufferedEnd = 3;
    return { ok: true, arrayBuffer: async () => new Uint8Array([1]).buffer };
  }) as typeof fetch;

  function Harness({ manifest, playIntent }: { manifest: JobManifest; playIntent: boolean }) {
    const { audioRef } = useMediaSourcePlayer({
      jobId: "job-1",
      manifest,
      playIntent,
      isTerminal: false,
    });
    return <audio ref={audioRef} />;
  }

  const { container, rerender } = render(
    <Harness manifest={buildManifest([])} playIntent={true} />,
  );
  const audio = container.querySelector("audio");
  expect(audio).not.toBeNull();

  act(() => {
    audio?.dispatchEvent(new Event("waiting"));
  });

  rerender(<Harness manifest={buildManifest([0])} playIntent={true} />);

  await waitFor(() => expect(playMock).toHaveBeenCalled());
});

test("starts playback after the first hydrated chunk arrives when play was pressed early", async () => {
  let bufferedEnd = 0;
  const playMock = vi.fn().mockResolvedValue(undefined);

  installBufferedAudioState(() => bufferedEnd);
  installRecordingMediaSource([], () => bufferedEnd);
  HTMLMediaElement.prototype.play = playMock;

  global.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/init")) {
      bufferedEnd = 0.5;
      return { ok: true, arrayBuffer: async () => new Uint8Array([9]).buffer };
    }
    bufferedEnd = 3;
    return { ok: true, arrayBuffer: async () => new Uint8Array([1]).buffer };
  }) as typeof fetch;

  function Harness({ manifest, playIntent }: { manifest: JobManifest; playIntent: boolean }) {
    const { audioRef } = useMediaSourcePlayer({
      jobId: "job-1",
      manifest,
      playIntent,
      isTerminal: false,
    });
    return <audio ref={audioRef} />;
  }

  const { rerender } = render(<Harness manifest={buildPendingManifest()} playIntent={true} />);

  rerender(<Harness manifest={buildManifest([0])} playIntent={true} />);

  await waitFor(() => expect(playMock).toHaveBeenCalled());
});

test("surfaces autoplay blocking when automatic resume is rejected by the browser", async () => {
  let bufferedEnd = 0;
  const blockedPlay = vi.fn().mockRejectedValue(new DOMException("blocked", "NotAllowedError"));

  installBufferedAudioState(() => bufferedEnd);
  installRecordingMediaSource([], () => bufferedEnd);
  HTMLMediaElement.prototype.play = blockedPlay;

  global.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/init")) {
      bufferedEnd = 0.5;
      return { ok: true, arrayBuffer: async () => new Uint8Array([9]).buffer };
    }
    bufferedEnd = 3;
    return { ok: true, arrayBuffer: async () => new Uint8Array([1]).buffer };
  }) as typeof fetch;

  function Harness() {
    const { audioRef, isAutoplayBlocked, lastPlayerError } = useMediaSourcePlayer({
      jobId: "job-1",
      manifest: buildManifest([0]),
      playIntent: true,
      isTerminal: false,
    });
    return (
      <div data-autoplay-blocked={isAutoplayBlocked ? "yes" : "no"}>
        <audio ref={audioRef} />
        <span>{lastPlayerError}</span>
      </div>
    );
  }

  const { container } = render(<Harness />);

  await waitFor(() => expect(container.firstChild).toHaveAttribute("data-autoplay-blocked", "yes"));
});

test("clamps custom timeline seeking to currently buffered audio", async () => {
  let bufferedEnd = 0;

  installBufferedAudioState(() => bufferedEnd);
  installRecordingMediaSource([], () => bufferedEnd);

  global.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/init")) {
      bufferedEnd = 0.5;
      return { ok: true, arrayBuffer: async () => new Uint8Array([9]).buffer };
    }
    bufferedEnd = 2;
    return { ok: true, arrayBuffer: async () => new Uint8Array([1]).buffer };
  }) as typeof fetch;

  function Harness() {
    const { audioRef, bufferedUntilSeconds, seekToSeconds } = useMediaSourcePlayer({
      jobId: "job-1",
      manifest: buildManifest([0]),
      playIntent: false,
      isTerminal: false,
    });

    useEffect(() => {
      if (bufferedUntilSeconds < 2) {
        return;
      }
      const audio = audioRef.current;
      if (!audio) {
        return;
      }
      audio.currentTime = 0;
      seekToSeconds(9);
    }, [audioRef, bufferedUntilSeconds, seekToSeconds]);

    return <audio ref={audioRef} />;
  }

  const { container } = render(<Harness />);
  const audio = container.querySelector("audio");

  await waitFor(() => expect(audio?.currentTime).toBe(2));
});

test("keeps the custom player clock in sync while audio time advances live", async () => {
  let bufferedEnd = 0;
  let simulatedCurrentTime = 0;
  const animationFrameCallbacks: FrameRequestCallback[] = [];
  installBufferedAudioState(() => bufferedEnd);
  installRecordingMediaSource([], () => bufferedEnd);
  HTMLMediaElement.prototype.play = vi.fn().mockResolvedValue(undefined);

  const requestAnimationFrameSpy = vi
    .spyOn(window, "requestAnimationFrame")
    .mockImplementation((callback: FrameRequestCallback) => {
      animationFrameCallbacks.push(callback);
      return animationFrameCallbacks.length;
    });
  const cancelAnimationFrameSpy = vi
    .spyOn(window, "cancelAnimationFrame")
    .mockImplementation(() => {});

  global.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/init")) {
      bufferedEnd = 0.5;
      return { ok: true, arrayBuffer: async () => new Uint8Array([9]).buffer };
    }
    bufferedEnd = 4;
    return { ok: true, arrayBuffer: async () => new Uint8Array([1]).buffer };
  }) as typeof fetch;

  function Harness() {
    const { audioRef, currentTimeSeconds } = useMediaSourcePlayer({
      jobId: "job-1",
      manifest: buildManifest([0]),
      playIntent: true,
      isTerminal: false,
    });

    useEffect(() => {
      const audio = audioRef.current;
      if (!audio) {
        return;
      }
      Object.defineProperty(audio, "currentTime", {
        configurable: true,
        get: () => simulatedCurrentTime,
        set: (value: number) => {
          simulatedCurrentTime = value;
        },
      });
    }, [audioRef]);

    return (
      <div data-current-time={currentTimeSeconds.toFixed(1)}>
        <audio ref={audioRef} />
      </div>
    );
  }

  const { container } = render(<Harness />);

  await waitFor(() => expect(requestAnimationFrameSpy).toHaveBeenCalled());

  act(() => {
    simulatedCurrentTime = 1.2;
    const nextFrame = animationFrameCallbacks.shift();
    nextFrame?.(performance.now());
  });

  await waitFor(() => expect(container.firstChild).toHaveAttribute("data-current-time", "1.2"));

  requestAnimationFrameSpy.mockRestore();
  cancelAnimationFrameSpy.mockRestore();
});
