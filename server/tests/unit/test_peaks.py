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
        int(12_000 * math.sin(2 * math.pi * 440 * (i / sample_rate)))
        for i in range(sample_rate)
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
