from __future__ import annotations

import os
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
    wav_path: str
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

    def wav_path(self, job_id: str, chunk_index: int) -> Path:
        return self.job_dir(job_id) / f"{chunk_index:05d}.wav"

    def package_wav_chunk(self, job_id: str, chunk_index: int, wav_bytes: bytes) -> PackagedChunk:
        job_dir = self.job_dir(job_id)
        wav_path = self.wav_path(job_id, chunk_index)
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
        mp4_path.unlink(missing_ok=True)
        return PackagedChunk(
            init_segment_path=str(init_path),
            segment_path=str(segment_path),
            wav_path=str(wav_path),
            duration_seconds=duration,
        )

    def build_export_file(self, job_id: str, wav_paths: list[str]) -> Path:
        if not wav_paths:
            raise ValueError("At least one WAV path is required to build an export")

        job_dir = self.job_dir(job_id)
        with tempfile.NamedTemporaryFile(
            mode="w",
            suffix=".txt",
            prefix="export-",
            dir=job_dir,
            delete=False,
        ) as concat_file:
            concat_path = Path(concat_file.name)
            for wav_path in wav_paths:
                concat_file.write(f"file '{self._escape_concat_path(wav_path)}'\n")

        with tempfile.NamedTemporaryFile(
            suffix=".m4a",
            prefix="export-",
            dir=job_dir,
            delete=False,
        ) as export_file:
            export_path = Path(export_file.name)

        try:
            self._run_export_ffmpeg(concat_path, export_path)
            return export_path
        finally:
            concat_path.unlink(missing_ok=True)

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

    def _run_export_ffmpeg(self, concat_path: Path, output_path: Path) -> None:
        command = [
            "ffmpeg",
            "-y",
            "-hide_banner",
            "-loglevel",
            "error",
            "-f",
            "concat",
            "-safe",
            "0",
            "-i",
            str(concat_path),
            "-vn",
            "-c:a",
            "aac",
            "-b:a",
            "128k",
            "-movflags",
            "+faststart",
            str(output_path),
        ]
        try:
            subprocess.run(command, check=True)
        except subprocess.CalledProcessError:
            output_path.unlink(missing_ok=True)
            raise

    def _escape_concat_path(self, path: str) -> str:
        normalized = os.fspath(path)
        return normalized.replace("'", r"'\''")
