"""Encodings offered when downloading a job's rendered audio.

The export re-encodes the job's lossless per-chunk WAVs into one file, so every
format here is a single generation from the model output. `wav` is the
untouched source (large, kept for debugging); `flac` is lossless at maximum
compression; `m4a`/`mp3`/`opus` are lossy and small.

This table is the only place that knows an encoding's ffmpeg arguments, file
extension and media type, so the route and the store cannot disagree.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

DownloadFormatName = Literal["m4a", "mp3", "opus", "flac", "wav"]


@dataclass(frozen=True, slots=True)
class DownloadFormat:
    """One selectable export encoding."""

    extension: str
    media_type: str
    codec_args: tuple[str, ...]


DOWNLOAD_FORMATS: dict[DownloadFormatName, DownloadFormat] = {
    # AAC in MP4: the browser-streamed format's codec, and the default.
    "m4a": DownloadFormat(
        extension="m4a",
        media_type="audio/mp4",
        codec_args=("-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart"),
    ),
    # MP3 is the encode-everywhere fallback (car stereos, old players).
    "mp3": DownloadFormat(
        extension="mp3",
        media_type="audio/mpeg",
        codec_args=("-c:a", "libmp3lame", "-b:a", "128k"),
    ),
    # Opus in Ogg is the smallest for speech at a given quality. ffmpeg
    # resamples 24 kHz TTS to Opus's native 48 kHz, which is expected.
    "opus": DownloadFormat(
        extension="opus",
        media_type="audio/ogg",
        codec_args=("-c:a", "libopus", "-b:a", "64k"),
    ),
    # Lossless from the model's WAVs, at the maximum compression level (12).
    "flac": DownloadFormat(
        extension="flac",
        media_type="audio/flac",
        codec_args=("-c:a", "flac", "-compression_level", "12"),
    ),
    # The raw model output, only re-wrapped: no loss, no compression.
    "wav": DownloadFormat(
        extension="wav",
        media_type="audio/wav",
        codec_args=("-c:a", "pcm_s16le"),
    ),
}

DEFAULT_DOWNLOAD_FORMAT: DownloadFormatName = "m4a"
