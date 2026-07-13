import { useCallback, useEffect, useRef, useState } from "react";

export interface WaveformOptions {
  /** Number of time-domain bins to sample per frame (default: 128) */
  binCount?: number;
}

export interface WaveformAnalyserState {
  /** The latest live waveform frame (0..1 normalized, length = binCount). Updated per rAF. */
  liveWaveform: Float32Array | null;
  /** Whether the AnalyserNode is connected and active. */
  isConnected: boolean;
}

/**
 * useWaveformAnalyser — Connects an AnalyserNode to an <audio> element via
 * createMediaElementSource, then runs a requestAnimationFrame loop sampling
 * getFloatTimeDomainData().
 *
 * Returns the live waveform buffer (for the currently-playing audio) plus
 * helpers to capture and retrieve per-chunk waveform snapshots.
 *
 * Gracefully handles disconnection/reconnection when the audio element source
 * changes (e.g. new MediaSource) by tearing down and re-creating the graph.
 */
export function useWaveformAnalyser(
  audioRef: React.RefObject<HTMLAudioElement | null>,
  options?: WaveformOptions,
) {
  const binCount = options?.binCount ?? 128;

  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const sourceRef = useRef<MediaElementAudioSourceNode | null>(null);
  const rafIdRef = useRef<number>(0);
  const capturedRef = useRef<Map<number, Float32Array>>(new Map());
  const [state, setState] = useState<WaveformAnalyserState>({
    liveWaveform: null,
    isConnected: false,
  });

  // Store the latest live waveform in a ref so captureSnapshot can read it
  const liveWaveformRef = useRef<Float32Array | null>(null);

  /**
   * Tears down the existing audio graph, if any.
   */
  const disconnect = useCallback(() => {
    cancelAnimationFrame(rafIdRef.current);
    rafIdRef.current = 0;

    if (sourceRef.current) {
      try {
        sourceRef.current.disconnect();
      } catch {
        // Already disconnected
      }
      sourceRef.current = null;
    }
    if (analyserRef.current) {
      try {
        analyserRef.current.disconnect();
      } catch {
        // Already disconnected
      }
      analyserRef.current = null;
    }
    if (audioContextRef.current && audioContextRef.current.state !== "closed") {
      audioContextRef.current.close().catch(() => {});
      audioContextRef.current = null;
    }

    liveWaveformRef.current = null;
    setState({ liveWaveform: null, isConnected: false });
  }, []);

  /**
   * Connects (or reconnects) the AnalyserNode to the given audio element.
   */
  const connect = useCallback(
    (audio: HTMLAudioElement) => {
      // Tear down existing connection first
      disconnect();

      try {
        const ctx = new AudioContext();
        const analyser = ctx.createAnalyser();
        analyser.fftSize = binCount * 2;

        const source = ctx.createMediaElementSource(audio);
        source.connect(analyser);
        analyser.connect(ctx.destination);

        audioContextRef.current = ctx;
        analyserRef.current = analyser;
        sourceRef.current = source;

        const buffer = new Float32Array(analyser.frequencyBinCount);

        function tick() {
          const a = analyserRef.current;
          if (!a) return;

          a.getFloatTimeDomainData(buffer);

          // Normalize from -1..1 to 0..1
          const normalized = new Float32Array(buffer.length);
          for (let i = 0; i < buffer.length; i++) {
            normalized[i] = (buffer[i] + 1) / 2;
          }

          liveWaveformRef.current = normalized;
          setState({ liveWaveform: normalized, isConnected: true });

          rafIdRef.current = requestAnimationFrame(tick);
        }

        rafIdRef.current = requestAnimationFrame(tick);
        setState({ liveWaveform: null, isConnected: true });
      } catch (err) {
        console.warn("useWaveformAnalyser: failed to connect", err);
        setState({ liveWaveform: null, isConnected: false });
      }
    },
    [binCount, disconnect],
  );

  // Set up the analyser when the audio element is available
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    // If the audio element already has a source, connect immediately
    connect(audio);

    // Listen for changes to the audio element's src/srcObject — the element
    // might be reused across different jobs/chunks. When the source changes
    // we need to reconnect.
    const handleSrcChange = () => {
      // Delay slightly to let the element settle
      setTimeout(() => {
        if (audioRef.current) {
          disconnect();
          connect(audioRef.current);
        }
      }, 0);
    };

    // We can't observe src changes directly, so we use a MutationObserver
    // to detect attribute changes that signal a new stream.
    // Additionally, MediaSource transitions are detected by listening to
    // the 'error' event — if the old MediaSource is detached a new one will
    // be attached, and we need to reconnect.
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (
          mutation.type === "attributes" &&
          (mutation.attributeName === "src" || mutation.attributeName === "srcObject")
        ) {
          handleSrcChange();
          return;
        }
      }
    });

    observer.observe(audio, { attributes: true, attributeFilter: ["src", "srcObject"] });

    return () => {
      observer.disconnect();
      disconnect();
    };
  }, [audioRef, connect, disconnect]);

  /**
   * Captures the current live waveform snapshot as the stored representation
   * for a given chunk index. Overwrites any previously stored waveform for
   * this chunk.
   */
  const captureSnapshot = useCallback((chunkIndex: number) => {
    const current = liveWaveformRef.current;
    if (!current) return;
    // Store a copy so the ref can continue to mutate
    capturedRef.current.set(chunkIndex, new Float32Array(current));
  }, []);

  /**
   * Retrieves the stored waveform for a given chunk index, or null if none
   * was captured.
   */
  const getCaptured = useCallback((chunkIndex: number): Float32Array | null => {
    return capturedRef.current.get(chunkIndex) ?? null;
  }, []);

  /**
   * Resets all stored captured waveforms.
   */
  const reset = useCallback(() => {
    capturedRef.current = new Map();
  }, []);

  return {
    liveWaveform: state.liveWaveform,
    isConnected: state.isConnected,
    captureSnapshot,
    getCaptured,
    reset,
    reconnect: () => {
      if (audioRef.current) {
        disconnect();
        connect(audioRef.current);
      }
    },
  };
}
