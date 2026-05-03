import { act, render, waitFor } from "@testing-library/react";

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
