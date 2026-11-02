import io
import math
import struct
import wave

import pytest

from app.media.peaks import PEAK_BINS, compute_peaks


def _build_wav(
    samples: list[int],
    sample_rate: int = 24_000,
    channels: int = 1,
    sample_width: int = 2,
) -> bytes:
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as handle:
        handle.setnchannels(channels)
        handle.setsampwidth(sample_width)
        handle.setframerate(sample_rate)
        if sample_width == 2:
            handle.writeframes(struct.pack(f"<{len(samples)}h", *samples))
        else:
            handle.writeframes(bytes(sample & 0xFF for sample in samples))
    return buffer.getvalue()


def test_silent_wav_yields_zeros() -> None:
    peaks = compute_peaks(_build_wav([0] * 2400))
    assert len(peaks) == PEAK_BINS
    assert all(peak == 0.0 for peak in peaks)


def test_loudest_bin_normalized_to_peak_scale() -> None:
    samples = [0] * 2400
    samples[1200] = 20000
    peaks = compute_peaks(_build_wav(samples))
    assert len(peaks) == PEAK_BINS
    assert max(peaks) == pytest.approx(0.95, abs=1e-6)
    assert all(0.0 <= peak <= 1.0 for peak in peaks)


def test_constant_amplitude_maps_every_bin_to_scale() -> None:
    peaks = compute_peaks(_build_wav([8000] * 2400))
    assert len(peaks) == PEAK_BINS
    assert max(peaks) == pytest.approx(0.95, abs=1e-6)
    assert min(peaks) == pytest.approx(0.95, abs=1e-6)


def test_custom_bin_count() -> None:
    peaks = compute_peaks(_build_wav([8000] * 1000), bins=64)
    assert len(peaks) == 64
    assert max(peaks) == pytest.approx(0.95, abs=1e-6)


def test_sine_wave_produces_bounded_peaks() -> None:
    sample_rate = 22_050
    samples = [
        int(12_000 * math.sin(2 * math.pi * 440 * (i / sample_rate))) for i in range(sample_rate)
    ]
    peaks = compute_peaks(_build_wav(samples, sample_rate=sample_rate))
    assert len(peaks) == PEAK_BINS
    assert max(peaks) == pytest.approx(0.95, abs=1e-6)
    assert all(0.0 <= peak <= 1.0 for peak in peaks)


def test_stereo_wav_downmixed_by_first_channel() -> None:
    samples = [8000 if i % 2 == 0 else 0 for i in range(4800)]
    peaks = compute_peaks(_build_wav(samples, channels=2))
    assert max(peaks) == pytest.approx(0.95, abs=1e-6)


def test_8bit_wav_supported() -> None:
    samples = [200] * 2400  # 200 unsigned = +72 signed
    peaks = compute_peaks(_build_wav(samples, sample_width=1))
    assert max(peaks) == pytest.approx(0.95, abs=1e-6)


def test_empty_wav_yields_zeros() -> None:
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(24_000)
    peaks = compute_peaks(buffer.getvalue())
    assert len(peaks) == PEAK_BINS
    assert all(peak == 0.0 for peak in peaks)


def test_invalid_bins_rejected() -> None:
    with pytest.raises(ValueError):
        compute_peaks(_build_wav([1] * 100), bins=0)


def _reference_peaks(wav_bytes: bytes, bins: int = PEAK_BINS) -> list[float]:
    """The original per-sample implementation, kept as the semantic reference.

    The production version is vectorised (numpy) because the Python loop held the
    GIL for ~44 ms per 12 s chunk, which stalled the API for a whole batch's
    packaging time. These values are what the reader's waveform geometry is
    based on, so any rewrite has to reproduce them exactly.
    """
    with wave.open(io.BytesIO(wav_bytes), "rb") as handle:
        frame_count = handle.getnframes()
        channel_count = handle.getnchannels()
        sample_width = handle.getsampwidth()
        frames = handle.readframes(frame_count)
    if frame_count <= 0 or sample_width not in (1, 2):
        return [0.0] * bins
    signed = sample_width == 2
    peaks = [0.0] * bins
    frames_per_bin = max(1.0, frame_count / bins)
    bytes_per_frame = channel_count * sample_width
    offset = 0
    while offset < frame_count:
        take = min(8192, frame_count - offset)
        block = frames[offset * bytes_per_frame : (offset + take) * bytes_per_frame]
        samples = (
            struct.unpack(f"<{take * channel_count}h", block)
            if signed
            else struct.unpack(f"<{take * channel_count}B", block)
        )
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
    scale = 0.95 / loudest
    return [round(min(1.0, value * scale), 4) for value in peaks]


@pytest.mark.parametrize("bins", [64, 256, 1000])
@pytest.mark.parametrize(
    "wav_bytes",
    [
        pytest.param(_build_wav([0] * 2400), id="silence"),
        pytest.param(_build_wav([0] * 1200 + [20000] + [0] * 1199), id="single-spike"),
        pytest.param(_build_wav([-32768] * 500 + [0] * 500), id="int16-minimum"),
        pytest.param(_build_wav([100, -200, 300, -400] * 3), id="fewer-frames-than-bins"),
        pytest.param(_build_wav([500] * 256), id="one-bin-of-frames"),
        pytest.param(_build_wav([300, -900, 300, -900] * 700, channels=2), id="stereo"),
        pytest.param(_build_wav([0, 64, 128, 192, 255] * 500, sample_width=1), id="8-bit"),
        pytest.param(_build_wav([1000] * 2401), id="odd-frame-count"),
    ],
)
def test_vectorised_peaks_match_the_reference_algorithm(wav_bytes, bins) -> None:
    assert compute_peaks(wav_bytes, bins=bins) == _reference_peaks(wav_bytes, bins)
