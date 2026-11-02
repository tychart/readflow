"""Per-chunk waveform peaks for the static reader playbar.

Peaks are computed once at packaging time from the source WAV and stored as a
small JSON file next to each media segment. The frontend fetches and renders
them; browsers never decode audio just to draw the visualization.
"""

from __future__ import annotations

import io
import wave

import numpy as np

PEAK_BINS = 256
_PEAK_SCALE = 0.95  # loudest bin maps to this after normalization


def compute_peaks(wav_bytes: bytes, bins: int = PEAK_BINS) -> list[float]:
    """Compute max-amplitude peaks from a WAV payload, normalized to [0, 1].

    Samples are max-pooled into ``bins`` buckets, then normalized so the
    loudest bucket maps to ``_PEAK_SCALE``. A silent WAV yields zeros, which
    the frontend renders at its minimum bar height.
    """
    if bins <= 0:
        raise ValueError("bins must be positive")

    with wave.open(io.BytesIO(wav_bytes), "rb") as handle:
        frame_count = handle.getnframes()
        channel_count = handle.getnchannels()
        sample_width = handle.getsampwidth()
        frames = handle.readframes(frame_count)

    if frame_count <= 0:
        return [0.0] * bins
    if sample_width not in (1, 2):
        raise ValueError(f"Unsupported sample width: {sample_width}")

    if sample_width == 2:
        # Widen before abs(): |int16 minimum| does not fit back into int16.
        samples = np.frombuffer(frames, dtype="<i2").astype(np.int32)
    else:
        samples = np.frombuffer(frames, dtype=np.uint8).astype(np.int32) - 128
    frame_total = samples.size // channel_count
    if frame_total <= 0:
        return [0.0] * bins
    # One magnitude per frame (the loudest channel), then max-pool into bins.
    # This runs in C, which matters: the old per-sample Python loop held the GIL
    # for ~44 ms per 12 s chunk and stalled the API for the whole batch's
    # packaging time.
    per_frame = np.abs(samples[: frame_total * channel_count].reshape(-1, channel_count)).max(
        axis=1
    )
    frames_per_bin = max(1.0, frame_total / bins)
    bin_index = np.minimum(bins - 1, (np.arange(frame_total) / frames_per_bin).astype(np.int64))
    peaks_by_bin = np.zeros(bins, dtype=np.int32)
    np.maximum.at(peaks_by_bin, bin_index, per_frame)
    peaks = peaks_by_bin.tolist()

    loudest = max(peaks)
    if loudest <= 0:
        return [0.0] * bins
    scale = _PEAK_SCALE / loudest
    return [round(min(1.0, value * scale), 4) for value in peaks]
