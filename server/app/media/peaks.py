"""Per-chunk waveform peaks for the static reader playbar.

Peaks are computed once at packaging time from the source WAV and stored as a
small JSON file next to each media segment. The frontend fetches and renders
them; browsers never decode audio just to draw the visualization.
"""

from __future__ import annotations

import io
import struct
import wave

PEAK_BINS = 256
_PEAK_SCALE = 0.95  # loudest bin maps to this after normalization
_BLOCK_FRAMES = 8192


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

    signed = sample_width == 2
    peaks = [0.0] * bins
    frames_per_bin = max(1.0, frame_count / bins)
    bytes_per_frame = channel_count * sample_width

    offset = 0
    while offset < frame_count:
        take = min(_BLOCK_FRAMES, frame_count - offset)
        block = frames[offset * bytes_per_frame : (offset + take) * bytes_per_frame]
        if signed:
            samples = struct.unpack(f"<{take * channel_count}h", block)
        else:
            samples = struct.unpack(f"<{take * channel_count}B", block)
        for local, raw_value in enumerate(samples):
            magnitude = abs(raw_value) if signed else abs(raw_value - 128)
            frame_index = offset + local // channel_count
            bin_index = min(bins - 1, int(frame_index / frames_per_bin))
            if magnitude > peaks[bin_index]:
                peaks[bin_index] = magnitude
        offset += take

    loudest = max(peaks)
    if loudest <= 0:
        return peaks
    scale = _PEAK_SCALE / loudest
    return [round(min(1.0, value * scale), 4) for value in peaks]
