import { act, render, waitFor } from "@testing-library/react";
import { useEffect, useState } from "react";

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
    audio_epoch: 0,
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

/** Install an arbitrary set of buffered ranges (for window / eviction tests). */
function installBufferedRanges(getRanges: () => Array<{ start: number; end: number }>) {
  Object.defineProperty(HTMLMediaElement.prototype, "buffered", {
    configurable: true,
    get() {
      const ranges = getRanges();
      return {
        length: ranges.length,
        start: (index: number) => ranges[index]?.start ?? 0,
        end: (index: number) => ranges[index]?.end ?? 0,
      };
    },
  });
}

interface StreamLog {
  appended: number[];
  removed: Array<{ start: number; end: number }>;
  mediaSourceCount: number;
  /** Marker byte -> number of appends that should reject with a quota error. */
  remainingAppendFailures: Map<number, number>;
}

function createStreamLog(): StreamLog {
  return {
    appended: [],
    removed: [],
    mediaSourceCount: 0,
    remainingAppendFailures: new Map(),
  };
}

/**
 * A MediaSource fake that records appends, removals and stream rebuilds — the
 * three things the streaming window is responsible for.
 */
function installStreamingMediaSource(log: StreamLog) {
  class LoggingSourceBuffer extends EventTarget {
    public updating = false;
    public mode: AppendMode = "segments";

    appendBuffer(buffer: BufferSource) {
      const bytes =
        buffer instanceof ArrayBuffer ? new Uint8Array(buffer) : new Uint8Array(buffer.buffer);
      const marker = bytes[0] ?? 0;
      const remainingFailures = log.remainingAppendFailures.get(marker) ?? 0;
      if (remainingFailures > 0) {
        log.remainingAppendFailures.set(marker, remainingFailures - 1);
        throw new DOMException(
          "The SourceBuffer is full, and cannot free space to append additional buffers.",
          "QuotaExceededError",
        );
      }
      log.appended.push(marker);
      this.updating = true;
      queueMicrotask(() => {
        this.updating = false;
        this.dispatchEvent(new Event("updateend"));
      });
    }

    remove(start: number, end: number) {
      log.removed.push({ start, end });
      this.updating = true;
      queueMicrotask(() => {
        this.updating = false;
        this.dispatchEvent(new Event("updateend"));
      });
    }
  }

  class LoggingMediaSource extends EventTarget {
    public readyState = "closed";

    constructor() {
      super();
      log.mediaSourceCount += 1;
      queueMicrotask(() => {
        this.readyState = "open";
        this.dispatchEvent(new Event("sourceopen"));
      });
    }

    addSourceBuffer() {
      return new LoggingSourceBuffer() as unknown as SourceBuffer;
    }
  }

  Object.defineProperty(window, "MediaSource", { writable: true, value: LoggingMediaSource });
}

/** Fetch mock for the window tests: `/chunks/<index>` returns the index as byte 0. */
function installSegmentFetch(onChunk: (index: number) => void, gate?: Map<number, Promise<void>>) {
  global.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/init")) {
      return { ok: true, arrayBuffer: async () => new Uint8Array([255]).buffer };
    }
    const index = Number(url.split("/").at(-1));
    const waitFor = gate?.get(index);
    if (waitFor) {
      await waitFor;
    }
    onChunk(index);
    return { ok: true, arrayBuffer: async () => new Uint8Array([index % 250]).buffer };
  }) as unknown as typeof fetch;
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
      playbackAnchorIndex: 0,
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
      playbackAnchorIndex: 0,
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
      playbackAnchorIndex: 0,
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
      playbackAnchorIndex: 0,
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
      playbackAnchorIndex: 0,
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
      playbackAnchorIndex: 0,
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
      playbackAnchorIndex: 0,
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
      playbackAnchorIndex: 0,
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

describe("playbackRate", () => {

  test("starts at 1.0x", async () => {
    let bufferedEnd = 0;
    installBufferedAudioState(() => bufferedEnd);
    installRecordingMediaSource([], () => bufferedEnd);

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
      const { audioRef, playbackRate } = useMediaSourcePlayer({
        jobId: "job-1",
        manifest: buildManifest([0]),
        playbackAnchorIndex: 0,
        playIntent: false,
        isTerminal: false,
      });
      return (
        <div data-playback-rate={playbackRate}>
          <audio ref={audioRef} />
        </div>
      );
    }

    const { container } = render(<Harness />);
    await waitFor(() =>
      expect(container.firstChild).toHaveAttribute("data-playback-rate", "1"),
    );
  });

  test("setPlaybackRate sets audio.playbackRate and updates state", async () => {
    let bufferedEnd = 0;
    let setPlaybackRateFromHook: (rate: number) => void = () => {};

    installBufferedAudioState(() => bufferedEnd);
    installRecordingMediaSource([], () => bufferedEnd);

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
      const { audioRef, playbackRate, setPlaybackRate } = useMediaSourcePlayer({
        jobId: "job-1",
        manifest: buildManifest([0]),
        playbackAnchorIndex: 0,
        playIntent: false,
        isTerminal: false,
      });
      setPlaybackRateFromHook = setPlaybackRate;
      return (
        <div data-playback-rate={playbackRate}>
          <audio ref={audioRef} />
        </div>
      );
    }

    const { container } = render(<Harness />);
    const audio = container.querySelector("audio");
    expect(audio).not.toBeNull();

    act(() => {
      setPlaybackRateFromHook(1.5);
    });

    expect(audio!.playbackRate).toBe(1.5);
    expect(container.firstChild).toHaveAttribute("data-playback-rate", "1.5");
  });

  test("setPlaybackRate clamps to minimum of 0.05", async () => {
    let setPlaybackRateFromHook: (rate: number) => void = () => {};
    let bufferedEnd = 0;

    installBufferedAudioState(() => bufferedEnd);
    installRecordingMediaSource([], () => bufferedEnd);

    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith("/init")) {
        bufferedEnd = 0.5;
        return { ok: true, arrayBuffer: async () => new Uint8Array([9]).buffer };
      }
      bufferedEnd = 4;
      return { ok: true, arrayBuffer: async () => new Uint8Array([1]).buffer };
    }) as typeof fetch;

    function Harness() {
      const { audioRef, setPlaybackRate, playbackRate } = useMediaSourcePlayer({
        jobId: "job-1",
        manifest: buildManifest([0]),
        playbackAnchorIndex: 0,
        playIntent: false,
        isTerminal: false,
      });
      setPlaybackRateFromHook = setPlaybackRate;
      return (
        <div data-playback-rate={playbackRate}>
          <audio ref={audioRef} />
        </div>
      );
    }

    const { container } = render(<Harness />);
    const audio = container.querySelector("audio");
    expect(audio).not.toBeNull();

    act(() => {
      setPlaybackRateFromHook(0.01);
    });

    expect(audio!.playbackRate).toBe(0.05);
    expect(container.firstChild).toHaveAttribute("data-playback-rate", "0.05");
  });

  test("setPlaybackRate works before stream is primed and applies when primed", async () => {
    let bufferedEnd = 0;
    let setPlaybackRateFromHook: (rate: number) => void = () => {};

    installBufferedAudioState(() => bufferedEnd);
    installRecordingMediaSource([], () => bufferedEnd);

    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith("/init")) {
        bufferedEnd = 0.5;
        return { ok: true, arrayBuffer: async () => new Uint8Array([9]).buffer };
      }
      bufferedEnd = 4;
      return { ok: true, arrayBuffer: async () => new Uint8Array([1]).buffer };
    }) as typeof fetch;

    function Harness() {
      const { audioRef, setPlaybackRate, playbackRate, isStreamPrimed } = useMediaSourcePlayer({
        jobId: "job-1",
        manifest: buildManifest([0]),
        playbackAnchorIndex: 0,
        playIntent: false,
        isTerminal: false,
      });
      setPlaybackRateFromHook = setPlaybackRate;
      return (
        <div
          data-playback-rate={playbackRate}
          data-stream-primed={isStreamPrimed ? "yes" : "no"}
        >
          <audio ref={audioRef} />
        </div>
      );
    }

    const { container } = render(<Harness />);
    const audio = container.querySelector("audio");
    expect(audio).not.toBeNull();

    act(() => {
      setPlaybackRateFromHook(2.0);
    });

    // Before primed, audio element isn't ready yet, but ref and state track it
    expect(audio!.playbackRate).toBe(2.0);
    expect(container.firstChild).toHaveAttribute("data-playback-rate", "2");

    // Once the stream becomes primed, the effect re-syncs playbackRate
    await waitFor(() =>
      expect(container.firstChild).toHaveAttribute("data-stream-primed", "yes"),
    );
    expect(audio!.playbackRate).toBe(2.0);
  });

  test("multiple rapid setPlaybackRate calls preserve the last value", async () => {
    let setPlaybackRateFromHook: (rate: number) => void = () => {};
    let bufferedEnd = 0;

    installBufferedAudioState(() => bufferedEnd);
    installRecordingMediaSource([], () => bufferedEnd);

    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith("/init")) {
        bufferedEnd = 0.5;
        return { ok: true, arrayBuffer: async () => new Uint8Array([9]).buffer };
      }
      bufferedEnd = 4;
      return { ok: true, arrayBuffer: async () => new Uint8Array([1]).buffer };
    }) as typeof fetch;

    function Harness() {
      const { audioRef, setPlaybackRate, playbackRate } = useMediaSourcePlayer({
        jobId: "job-1",
        manifest: buildManifest([0]),
        playbackAnchorIndex: 0,
        playIntent: false,
        isTerminal: false,
      });
      setPlaybackRateFromHook = setPlaybackRate;
      return (
        <div data-playback-rate={playbackRate}>
          <audio ref={audioRef} />
        </div>
      );
    }

    const { container } = render(<Harness />);
    const audio = container.querySelector("audio");

    act(() => {
      setPlaybackRateFromHook(0.75);
    });
    act(() => {
      setPlaybackRateFromHook(1.25);
    });
    act(() => {
      setPlaybackRateFromHook(2.5);
    });

    expect(container.firstChild).toHaveAttribute("data-playback-rate", "2.5");
    expect(audio!.playbackRate).toBe(2.5);
    expect(audio!.defaultPlaybackRate).toBe(2.5);
  });
});

test("applies a pending seek only after the new stream (anchor change) is primed and buffered", async () => {
  let bufferedEnd = 0;
  let simulatedCurrentTime = 0;
  const appendedMarkers: number[] = [];
  installBufferedAudioState(() => bufferedEnd);
  installRecordingMediaSource(appendedMarkers, () => bufferedEnd);

  const manifestAnchor0 = buildManifest([0, 1]);
  // A stream anchored at chunk 1 is normalized: chunk 1 starts at 0s.
  const manifestAnchor1: JobManifest = {
    mime_type: 'audio/mp4; codecs="mp4a.40.2"',
    init_segment_url: "/api/jobs/job-1/chunks/init",
    chunks: [
      {
        index: 1,
        status: "written",
        duration_seconds: 2,
        start_seconds: 0,
        plan_version: 1,
        voice_id: "suzy",
        segment_url: "/api/jobs/job-1/chunks/1",
      },
      {
        index: 2,
        status: "written",
        duration_seconds: 2,
        start_seconds: 2,
        plan_version: 1,
        voice_id: "suzy",
        segment_url: "/api/jobs/job-1/chunks/2",
      },
    ],
  };

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
    if (url.endsWith("/chunks/1")) {
      bufferedEnd = 3;
      return { ok: true, arrayBuffer: async () => new Uint8Array([2]).buffer };
    }
    bufferedEnd = 4;
    return { ok: true, arrayBuffer: async () => new Uint8Array([3]).buffer };
  }) as typeof fetch;

  const onSeekApplied = vi.fn();

  function Harness() {
    const [seekIntent, setSeekIntent] = useState<{ anchor: number; target: number } | null>(null);
    const { audioRef, currentTimeSeconds, isStreamPrimed } = useMediaSourcePlayer({
      jobId: "job-1",
      manifest: seekIntent ? manifestAnchor1 : manifestAnchor0,
      playbackAnchorIndex: seekIntent?.anchor ?? 0,
      playIntent: false,
      isTerminal: false,
      pendingSeekSeconds: seekIntent?.target ?? null,
      onSeekApplied,
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
      <div data-current-time={currentTimeSeconds.toFixed(1)} data-primed={isStreamPrimed ? "yes" : "no"}>
        <audio ref={audioRef} />
        <button onClick={() => setSeekIntent({ anchor: 1, target: 1.2 })} type="button">
          seek
        </button>
      </div>
    );
  }

  const { container } = render(<Harness />);

  // The anchor-0 stream primes and fully buffers chunks 0 and 1.
  await waitFor(() => expect(appendedMarkers).toEqual([9, 1, 2]));

  // Click a different chunk mid-way through it (chunk 1, 1.2s in): the anchor
  // changes and a pending seek is set in the same batch — exactly what a
  // timeline click on another chunk does.
  act(() => {
    (container.querySelector("button") as HTMLButtonElement).click();
  });

  // The pending seek must NOT be applied against the old stream's primed/
  // buffered state while the new stream is resetting and priming.
  expect(onSeekApplied).not.toHaveBeenCalled();
  expect(simulatedCurrentTime).toBe(0);

  // Once the new stream primes and buffers past the target, the seek lands
  // exactly at 1.2s (not at the start of chunk 1, and not at 0).
  await waitFor(() => expect(onSeekApplied).toHaveBeenCalledTimes(1));
  expect(simulatedCurrentTime).toBeCloseTo(1.2, 5);
  expect(container.firstChild).toHaveAttribute("data-current-time", "1.2");
});

test("shows waiting for data when playback stalls at the rendered boundary without a waiting event", async () => {
  let bufferedEnd = 0;
  let simulatedCurrentTime = 0;

  installBufferedAudioState(() => bufferedEnd);
  installRecordingMediaSource([], () => bufferedEnd);
  HTMLMediaElement.prototype.play = vi.fn().mockResolvedValue(undefined);

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
    const { audioRef, isWaitingForData, playerState } = useMediaSourcePlayer({
      jobId: "job-1",
      manifest: buildManifest([0, 1]),
      playbackAnchorIndex: 0,
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
      Object.defineProperty(audio, "paused", {
        configurable: true,
        get: () => false,
      });
    }, [audioRef]);

    return (
      <div data-state={playerState} data-waiting={isWaitingForData ? "yes" : "no"}>
        <audio ref={audioRef} />
      </div>
    );
  }

  const { container } = render(<Harness />);
  const audio = container.querySelector("audio");
  expect(audio).not.toBeNull();

  act(() => {
    simulatedCurrentTime = 3.9;
    audio?.dispatchEvent(new Event("play"));
    audio?.dispatchEvent(new Event("timeupdate"));
  });

  await waitFor(() => expect(container.firstChild).toHaveAttribute("data-state", "playing"));

  act(() => {
    simulatedCurrentTime = 4;
    audio?.dispatchEvent(new Event("timeupdate"));
  });

  await waitFor(() =>
    expect(container.firstChild).toHaveAttribute(
      "data-state",
      "stalled_waiting_for_next_chunk",
    ),
  );
  expect(container.firstChild).toHaveAttribute("data-waiting", "yes");
});

test("reconciles a terminal job that stops at the end of the stream to ended (no stuck spinner)", async () => {
  let bufferedEnd = 0;
  let simulatedCurrentTime = 0;
  const pauseMock = vi.fn();
  const animationFrameCallbacks: FrameRequestCallback[] = [];

  installBufferedAudioState(() => bufferedEnd);
  installRecordingMediaSource([], () => bufferedEnd);
  HTMLMediaElement.prototype.play = vi.fn().mockResolvedValue(undefined);
  HTMLMediaElement.prototype.pause = pauseMock;

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
    const { audioRef, isActuallyPlaying, isWaitingForData, playerState } = useMediaSourcePlayer({
      jobId: "job-1",
      manifest: buildManifest([0, 1]),
      playbackAnchorIndex: 0,
      playIntent: true,
      isTerminal: true,
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
      Object.defineProperty(audio, "paused", {
        configurable: true,
        get: () => false,
      });
    }, [audioRef]);

    return (
      <div
        data-playing={isActuallyPlaying ? "yes" : "no"}
        data-state={playerState}
        data-waiting={isWaitingForData ? "yes" : "no"}
      >
        <audio ref={audioRef} />
      </div>
    );
  }

  const { container } = render(<Harness />);
  const audio = container.querySelector("audio");
  expect(audio).not.toBeNull();

  await waitFor(() => expect(requestAnimationFrameSpy).toHaveBeenCalled());

  // Playback advances near the end of the buffered stream…
  act(() => {
    simulatedCurrentTime = 3.9;
    audio?.dispatchEvent(new Event("play"));
    audio?.dispatchEvent(new Event("timeupdate"));
  });

  await waitFor(() => expect(container.firstChild).toHaveAttribute("data-state", "playing"));

  // …then the playhead freezes at the end without a browser 'ended' event.
  act(() => {
    simulatedCurrentTime = 4;
    audio?.dispatchEvent(new Event("timeupdate"));
  });

  // One more frozen tick: the playhead stopped at the end of the buffered
  // stream, so the player must reconcile to ended on its own.
  act(() => {
    audio?.dispatchEvent(new Event("timeupdate"));
  });

  await waitFor(() => expect(container.firstChild).toHaveAttribute("data-state", "ended"));
  expect(container.firstChild).toHaveAttribute("data-playing", "no");
  expect(container.firstChild).toHaveAttribute("data-waiting", "no");
  expect(pauseMock).toHaveBeenCalled();

  requestAnimationFrameSpy.mockRestore();
  cancelAnimationFrameSpy.mockRestore();
});

describe("streaming window", () => {
  /**
   * These tests drive the playhead by hand: jsdom has no media clock, so
   * `currentTime` is a getter over a mutable variable that the test advances and
   * then announces with a `timeupdate` event (the signal a real element emits).
   */
  const LONG_JOB_SECONDS = 400;

  test("appends only the audio inside the lookahead window", async () => {
    const log = createStreamLog();
    installStreamingMediaSource(log);
    let bufferedEnd = 0;
    installBufferedRanges(() => (bufferedEnd > 0 ? [{ start: 0, end: bufferedEnd }] : []));

    const chunkCount = LONG_JOB_SECONDS / 2;
    const fetchedIndexes: number[] = [];
    installSegmentFetch((index) => {
      fetchedIndexes.push(index);
      bufferedEnd = (index + 1) * 2;
    });

    function Harness() {
      const { audioRef, appendedChunksCount } = useMediaSourcePlayer({
        jobId: "job-1",
        manifest: buildManifest(Array.from({ length: chunkCount }, (_, index) => index)),
        playbackAnchorIndex: 0,
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

    // 240s of lookahead / 2s chunks = chunks 0..119. Chunk 120 starts *at* the
    // window edge and must never be fetched.
    await waitFor(() => expect(container.firstChild).toHaveAttribute("data-appended", "120"));
    expect(fetchedIndexes).toContain(119);
    expect(fetchedIndexes).not.toContain(120);
    expect(fetchedIndexes).not.toContain(400);
    expect(log.appended).toHaveLength(121);
  });

  test("extends the window as the playhead advances", async () => {
    const log = createStreamLog();
    installStreamingMediaSource(log);
    let bufferedEnd = 0;
    let playhead = 0;
    installBufferedRanges(() => (bufferedEnd > 0 ? [{ start: 0, end: bufferedEnd }] : []));
    installSegmentFetch((index) => {
      bufferedEnd = (index + 1) * 2;
    });

    const chunkCount = LONG_JOB_SECONDS / 2;

    function Harness() {
      const { audioRef, appendedChunksCount } = useMediaSourcePlayer({
        jobId: "job-1",
        manifest: buildManifest(Array.from({ length: chunkCount }, (_, index) => index)),
        playbackAnchorIndex: 0,
        playIntent: false,
        isTerminal: false,
      });

      useEffect(() => {
        const audio = audioRef.current;
        if (!audio) {
          return;
        }
        Object.defineProperty(audio, "currentTime", {
          configurable: true,
          get: () => playhead,
          set: (value: number) => {
            playhead = value;
          },
        });
      }, [audioRef]);

      return (
        <div data-appended={String(appendedChunksCount)}>
          <audio ref={audioRef} />
        </div>
      );
    }

    const { container } = render(<Harness />);
    await waitFor(() => expect(container.firstChild).toHaveAttribute("data-appended", "120"));

    // Halfway through the buffered window: the lookahead is topped back up from
    // the new playhead instead of the stream growing to the whole document.
    act(() => {
      playhead = 300;
      container.querySelector("audio")?.dispatchEvent(new Event("timeupdate"));
    });

    await waitFor(() => expect(container.firstChild).toHaveAttribute("data-appended", "200"));
  });

  test("evicts played audio behind the keep-behind margin without rebuilding the stream", async () => {
    const log = createStreamLog();
    installStreamingMediaSource(log);
    let bufferedEnd = 0;
    let playhead = 0;
    installBufferedRanges(() => (bufferedEnd > 0 ? [{ start: 0, end: bufferedEnd }] : []));
    installSegmentFetch((index) => {
      bufferedEnd = (index + 1) * 2;
    });

    function Harness() {
      const { audioRef, appendedChunksCount } = useMediaSourcePlayer({
        jobId: "job-1",
        manifest: buildManifest([0, 1, 2, 3, 4]),
        playbackAnchorIndex: 0,
        playIntent: false,
        isTerminal: false,
      });

      useEffect(() => {
        const audio = audioRef.current;
        if (!audio) {
          return;
        }
        Object.defineProperty(audio, "currentTime", {
          configurable: true,
          get: () => playhead,
          set: (value: number) => {
            playhead = value;
          },
        });
      }, [audioRef]);

      return (
        <div data-appended={String(appendedChunksCount)}>
          <audio ref={audioRef} />
        </div>
      );
    }

    const { container } = render(<Harness />);
    await waitFor(() => expect(container.firstChild).toHaveAttribute("data-appended", "5"));

    act(() => {
      playhead = 100;
      container.querySelector("audio")?.dispatchEvent(new Event("timeupdate"));
    });
    // 100s in, the whole stream is still inside the 120s keep-behind margin.
    expect(log.removed).toEqual([]);

    act(() => {
      playhead = 300;
      container.querySelector("audio")?.dispatchEvent(new Event("timeupdate"));
    });

    await waitFor(() => expect(log.removed).toEqual([{ start: 0, end: 180 }]));
    // Eviction trims the front of the same stream; it never reopens it.
    expect(log.mediaSourceCount).toBe(1);
  });

  test("stays in the loading state until a seek outside the loaded audio arrives", async () => {
    const log = createStreamLog();
    installStreamingMediaSource(log);
    let bufferedEnd = 0;
    let playhead = 0;
    installBufferedRanges(() => (bufferedEnd > 0 ? [{ start: 0, end: bufferedEnd }] : []));

    let releaseChunk: () => void = () => {};
    const chunkGate = new Promise<void>((resolve) => {
      releaseChunk = resolve;
    });
    installSegmentFetch(
      (index) => {
        bufferedEnd = (index + 1) * 2;
      },
      new Map([[5, chunkGate]]),
    );

    const onSeekApplied = vi.fn();

    function Harness() {
      const [pendingSeek, setPendingSeek] = useState<number | null>(null);
      const { audioRef, currentTimeSeconds, isLoadingAudio, isStreamPrimed } =
        useMediaSourcePlayer({
          jobId: "job-1",
          manifest: buildManifest([0, 1, 2, 3, 4, 5]),
          playbackAnchorIndex: 0,
          playIntent: false,
          isTerminal: false,
          pendingSeekSeconds: pendingSeek,
          onSeekApplied: () => {
            setPendingSeek(null);
            onSeekApplied();
          },
        });

      useEffect(() => {
        const audio = audioRef.current;
        if (!audio) {
          return;
        }
        Object.defineProperty(audio, "currentTime", {
          configurable: true,
          get: () => playhead,
          set: (value: number) => {
            playhead = value;
          },
        });
      }, [audioRef]);

      return (
        <div
          data-loading={isLoadingAudio ? "yes" : "no"}
          data-primed={isStreamPrimed ? "yes" : "no"}
          data-time={currentTimeSeconds.toFixed(1)}
        >
          <audio ref={audioRef} />
          <button onClick={() => setPendingSeek(11)} type="button">
            seek
          </button>
        </div>
      );
    }

    const { container } = render(<Harness />);

    // The stream is primed and buffered through chunk 4 (10s); chunk 5 — which
    // holds the 11s target — is still in flight.
    await waitFor(() => expect(container.firstChild).toHaveAttribute("data-primed", "yes"));
    await waitFor(() => expect(log.appended).toHaveLength(5 + 1));

    act(() => {
      (container.querySelector("button") as HTMLButtonElement).click();
    });

    // The listener asked for audio this client does not hold: spinner on, no seek
    // applied, and the clock does not jump to a clamped position.
    expect(container.firstChild).toHaveAttribute("data-loading", "yes");
    expect(container.firstChild).toHaveAttribute("data-time", "0.0");
    expect(onSeekApplied).not.toHaveBeenCalled();

    await act(async () => {
      releaseChunk();
      await chunkGate;
    });

    await waitFor(() => expect(onSeekApplied).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(container.firstChild).toHaveAttribute("data-time", "11.0"));
    expect(container.firstChild).toHaveAttribute("data-loading", "no");
    expect(playhead).toBeCloseTo(11, 5);
  });

  test("reopening the stream at the same anchor applies a seek into evicted audio", async () => {
    const log = createStreamLog();
    installStreamingMediaSource(log);
    let ranges: Array<{ start: number; end: number }> = [];
    let playhead = 0;
    installBufferedRanges(() => ranges);
    installSegmentFetch((index) => {
      ranges = [{ start: 0, end: (index + 1) * 2 }];
    });

    const onSeekApplied = vi.fn();

    function Harness() {
      const [pendingSeek, setPendingSeek] = useState<number | null>(null);
      const [restartKey, setRestartKey] = useState(0);
      const { audioRef, isLoadingAudio, currentTimeSeconds } = useMediaSourcePlayer({
        jobId: "job-1",
        manifest: buildManifest([0, 1, 2, 3, 4, 5]),
        playbackAnchorIndex: 0,
        playIntent: false,
        isTerminal: false,
        pendingSeekSeconds: pendingSeek,
        onSeekApplied: () => {
          setPendingSeek(null);
          onSeekApplied();
        },
        streamRestartKey: restartKey,
      });

      useEffect(() => {
        const audio = audioRef.current;
        if (!audio) {
          return;
        }
        Object.defineProperty(audio, "currentTime", {
          configurable: true,
          get: () => playhead,
          set: (value: number) => {
            playhead = value;
          },
        });
      }, [audioRef]);

      return (
        <div
          data-loading={isLoadingAudio ? "yes" : "no"}
          data-time={currentTimeSeconds.toFixed(1)}
        >
          <audio ref={audioRef} />
          <button
            onClick={() => {
              setPendingSeek(3);
              setRestartKey((key) => key + 1);
            }}
            type="button"
          >
            seek evicted
          </button>
        </div>
      );
    }

    const { container } = render(<Harness />);
    await waitFor(() => expect(log.appended).toHaveLength(6 + 1));

    // The listener played on: everything before 9s has been evicted.
    ranges = [{ start: 9, end: 12 }];

    act(() => {
      (container.querySelector("button") as HTMLButtonElement).click();
    });

    expect(container.firstChild).toHaveAttribute("data-loading", "yes");

    await waitFor(() => expect(onSeekApplied).toHaveBeenCalledTimes(1));
    // A second MediaSource proves the stream was reopened rather than clamped.
    expect(log.mediaSourceCount).toBe(2);
    expect(playhead).toBeCloseTo(3, 5);
    expect(container.firstChild).toHaveAttribute("data-loading", "no");
  });

  test("frees played audio and retries once when the browser reports a full SourceBuffer", async () => {
    const log = createStreamLog();
    log.remainingAppendFailures.set(3, 1);
    installStreamingMediaSource(log);
    let playhead = 300;
    installBufferedRanges(() => [{ start: 0, end: 20 }]);
    installSegmentFetch(() => {});

    function Harness() {
      const { audioRef, appendedChunksCount, lastPlayerError } = useMediaSourcePlayer({
        jobId: "job-1",
        manifest: buildManifest([0, 1, 2, 3, 4]),
        playbackAnchorIndex: 0,
        playIntent: false,
        isTerminal: false,
      });

      useEffect(() => {
        const audio = audioRef.current;
        if (!audio) {
          return;
        }
        Object.defineProperty(audio, "currentTime", {
          configurable: true,
          get: () => playhead,
          set: (value: number) => {
            playhead = value;
          },
        });
      }, [audioRef]);

      return (
        <div data-appended={String(appendedChunksCount)}>
          <audio ref={audioRef} />
          <span data-testid="error">{lastPlayerError}</span>
        </div>
      );
    }

    const { container } = render(<Harness />);

    await waitFor(() => expect(container.firstChild).toHaveAttribute("data-appended", "5"));
    expect(log.removed.length).toBeGreaterThan(0);
    expect(container.querySelector("span")).toBeEmptyDOMElement();
  });

  test("reports a readable error when a full SourceBuffer cannot be recovered", async () => {
    const log = createStreamLog();
    log.remainingAppendFailures.set(0, 10);
    installStreamingMediaSource(log);
    // Nothing buffered yet, so there is nothing the player can free.
    installBufferedRanges(() => []);
    installSegmentFetch(() => {});

    function Harness() {
      const { audioRef, lastPlayerError } = useMediaSourcePlayer({
        jobId: "job-1",
        manifest: buildManifest([0, 1]),
        playbackAnchorIndex: 0,
        playIntent: false,
        isTerminal: false,
      });
      return (
        <div>
          <audio ref={audioRef} />
          <span data-testid="error">{lastPlayerError}</span>
        </div>
      );
    }

    const { container } = render(<Harness />);
    const error = container.querySelector('[data-testid="error"]');

    await waitFor(() => expect(error).toHaveTextContent(/ran out of audio buffer space/i));
    // The raw browser message never reaches the listener.
    expect(error).not.toHaveTextContent(/appendBuffer/i);
    expect(log.removed).toEqual([]);
  });
});
