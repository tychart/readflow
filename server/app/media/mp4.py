from __future__ import annotations

from dataclasses import dataclass


@dataclass(slots=True)
class Mp4Segments:
    init_segment: bytes
    media_segment: bytes


def split_fragmented_mp4(payload: bytes) -> Mp4Segments:
    offset = 0
    init_parts: list[bytes] = []
    media_parts: list[bytes] = []
    while offset + 8 <= len(payload):
        size = int.from_bytes(payload[offset : offset + 4], "big")
        box_type = payload[offset + 4 : offset + 8]
        if size == 0:
            size = len(payload) - offset
        box = payload[offset : offset + size]
        if box_type in {b"ftyp", b"moov"}:
            init_parts.append(box)
        else:
            media_parts.append(box)
        offset += size
    if not init_parts or not media_parts:
        raise ValueError("Unable to split fragmented MP4 payload into init and media segments")
    return Mp4Segments(init_segment=b"".join(init_parts), media_segment=b"".join(media_parts))
