from __future__ import annotations

import shutil
import subprocess
import tempfile
import wave
from dataclasses import dataclass
from pathlib import Path

from app.core.config import Settings
from app.media.mp4 import split_fragmented_mp4


@dataclass(slots=True)
class PackagedChunk:
    init_segment_path: str
    segment_path: str
    duration_seconds: float


class MediaStore:
    def __init__(self, settings: Settings) -> None:
        self._root = Path(tempfile.gettempdir()) / settings.temp_dir_name / "jobs"
        self._root.mkdir(parents=True, exist_ok=True)

    def job_dir(self, job_id: str) -> Path:
        path = self._root / job_id / "chunks"
        path.mkdir(parents=True, exist_ok=True)
        return path

    def init_segment_path(self, job_id: str) -> Path:
        return self.job_dir(job_id) / "init.mp4"

    def segment_path(self, job_id: str, chunk_index: int) -> Path:
        return self.job_dir(job_id) / f"{chunk_index:05d}.m4s"

    def package_wav_chunk(self, job_id: str, chunk_index: int, wav_bytes: bytes) -> PackagedChunk:
        job_dir = self.job_dir(job_id)
        wav_path = job_dir / f"{chunk_index:05d}.wav"
        mp4_path = job_dir / f"{chunk_index:05d}.mp4"
        wav_path.write_bytes(wav_bytes)
        self._run_ffmpeg(wav_path, mp4_path)
        payload = mp4_path.read_bytes()
        segments = split_fragmented_mp4(payload)
        init_path = self.init_segment_path(job_id)
        if not init_path.exists():
            init_path.write_bytes(segments.init_segment)
        segment_path = self.segment_path(job_id, chunk_index)
        segment_path.write_bytes(segments.media_segment)
        duration = self._wav_duration_seconds(wav_path)
        wav_path.unlink(missing_ok=True)
        mp4_path.unlink(missing_ok=True)
        return PackagedChunk(
            init_segment_path=str(init_path),
            segment_path=str(segment_path),
            duration_seconds=duration,
        )

    def remove_job(self, job_id: str) -> None:
        shutil.rmtree(self._root / job_id, ignore_errors=True)

    def _wav_duration_seconds(self, wav_path: Path) -> float:
        with wave.open(str(wav_path), "rb") as handle:
            return handle.getnframes() / float(handle.getframerate())

    def _run_ffmpeg(self, wav_path: Path, mp4_path: Path) -> None:
        command = [
            "ffmpeg",
            "-y",
            "-hide_banner",
            "-loglevel",
            "error",
            "-i",
            str(wav_path),
            "-c:a",
            "aac",
            "-b:a",
            "128k",
            "-movflags",
            "frag_keyframe+empty_moov+default_base_moof+separate_moof",
            str(mp4_path),
        ]
        subprocess.run(command, check=True)
