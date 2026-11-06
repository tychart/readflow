import io
import json
import struct
import wave
from pathlib import Path
from uuid import uuid4

import pytest

from app.core.config import Settings
from app.media.store import MediaStore


@pytest.fixture
def settings(monkeypatch: pytest.MonkeyPatch) -> Settings:
    monkeypatch.setenv("READFLOW_TEMP_DIR_NAME", f"readflow-test-{uuid4()}")
    return Settings()


def _build_wav_bytes(duration_frames: int = 2400, sample_rate: int = 24_000) -> bytes:
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(sample_rate)
        handle.writeframes(struct.pack(f"<{duration_frames}h", *([8000] * duration_frames)))
    return buffer.getvalue()


def test_package_wav_chunk_writes_peaks_file(settings: Settings) -> None:
    store = MediaStore(settings)
    try:
        stored = store.package_wav_chunk("job-1", 0, _build_wav_bytes())
        peaks_path = store.peaks_path("job-1", 0)
        assert stored.segment_path == str(store.segment_path("job-1", 0))
        assert stored.wav_path == str(store.wav_path("job-1", 0))
        assert peaks_path.exists()
        payload = json.loads(peaks_path.read_text())
        assert payload["bins"] == len(payload["peaks"]) > 0
        assert all(0.0 <= peak <= 1.0 for peak in payload["peaks"])
        assert max(payload["peaks"]) == 0.95
    finally:
        store.remove_job("job-1")


def test_peaks_path_mirrors_segment_versioning(settings: Settings) -> None:
    store = MediaStore(settings)
    try:
        base = store.peaks_path("job-1", 2)
        versioned = store.peaks_path("job-1", 2, version=1)
        assert base.name == "00002.peaks.json"
        assert versioned.name == "00002_v1.peaks.json"
    finally:
        store.remove_job("job-1")


def test_remove_job_cleans_peaks_file(settings: Settings) -> None:
    store = MediaStore(settings)
    store.package_wav_chunk("job-1", 0, _build_wav_bytes())
    assert store.peaks_path("job-1", 0).exists()
    store.remove_job("job-1")
    assert not store.peaks_path("job-1", 0).exists()


def test_a_wedged_ffmpeg_times_out_instead_of_freezing_the_scheduler(
    settings: Settings, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A process that never exits must fail the chunk, not hang the tick.

    `package_wav_chunk` runs on a thread the scheduling loop awaits, so a hung
    ffmpeg froze rendering permanently with nothing logged.
    """
    import subprocess

    from app.media.store import CHUNK_ENCODE_TIMEOUT_SECONDS

    calls: list[dict[str, object]] = []

    def wedged(command, **kwargs):
        calls.append(kwargs)
        raise subprocess.TimeoutExpired(command, 1.0)

    monkeypatch.setattr("app.media.store.subprocess.run", wedged)
    store = MediaStore(settings)
    try:
        with pytest.raises(subprocess.TimeoutExpired):
            store.package_wav_chunk("job-timeout", 0, _build_wav_bytes())
        assert calls[0]["timeout"] == CHUNK_ENCODE_TIMEOUT_SECONDS
        # The truncated encode must not be left behind as if it were real.
        assert not list(store.job_dir("job-timeout").glob("*.mp4"))
    finally:
        store.remove_job("job-timeout")


def test_each_take_gets_its_own_files(settings: Settings) -> None:
    """A reprocessed take must not overwrite the take it replaces.

    The worker used to package every take under the versionless filename, so
    `version` was decorative: switching back to the old take served the new
    audio, and the version in the segment URL selected nothing.
    """
    store = MediaStore(settings)
    try:
        first = store.package_wav_chunk("job-1", 0, _build_wav_bytes())
        first_wav = Path(first.wav_path).read_bytes()

        second = store.package_wav_chunk("job-1", 0, _build_wav_bytes(4800), version=1)

        assert first.wav_path != second.wav_path
        assert first.segment_path != second.segment_path
        assert Path(second.wav_path).name == "00000_v1.wav"
        assert Path(second.segment_path).name == "00000_v1.m4s"
        assert store.peaks_path("job-1", 0, version=1).name == "00000_v1.peaks.json"
        # The superseded take is untouched and still served under version 0.
        assert Path(first.wav_path).read_bytes() == first_wav
        assert store.peaks_path("job-1", 0).exists()
        assert store.peaks_path("job-1", 0, version=1).exists()
    finally:
        store.remove_job("job-1")
