from __future__ import annotations

import re
from dataclasses import dataclass

from app.core.config import RuntimeConfig
from app.jobs.models import Job


@dataclass(slots=True)
class PlannedChunk:
    text: str
    char_start: int
    char_end: int
    estimated_duration_seconds: float


class ChunkPlanner:
    def __init__(self, config: RuntimeConfig) -> None:
        self._config = config

    def normalize_text(self, text: str) -> str:
        text = text.replace("\r\n", "\n").replace("\r", "\n")
        text = re.sub(r"[ \t]+", " ", text)
        text = re.sub(r"\n{3,}", "\n\n", text)
        return text.strip()

    def plan_next(self, job: Job) -> PlannedChunk | None:
        if job.planner_cursor.exhausted:
            return None
        normalized = self.normalize_text(job.source_text)
        offset = job.planner_cursor.offset
        if offset >= len(normalized):
            job.planner_cursor.offset = -1
            return None

        emitted = job.planner_cursor.chunks_emitted
        target_chars = self._target_chars(job)
        start = offset
        remaining = normalized[start:]
        if not remaining.strip():
            job.planner_cursor.offset = -1
            return None

        char_end = self._find_boundary(remaining, target_chars, startup_mode=emitted == 0)
        chunk_text = remaining[:char_end].strip()
        if not chunk_text:
            job.planner_cursor.offset = -1
            return None

        absolute_end = start + char_end
        while absolute_end < len(normalized) and normalized[absolute_end].isspace():
            absolute_end += 1

        if absolute_end >= len(normalized):
            job.planner_cursor.offset = -1
        else:
            job.planner_cursor.offset = absolute_end
        job.planner_cursor.chunks_emitted += 1

        return PlannedChunk(
            text=chunk_text,
            char_start=start,
            char_end=absolute_end,
            estimated_duration_seconds=max(
                1.0, len(chunk_text) / self._config.estimated_chars_per_second
            ),
        )

    def _target_chars(self, job: Job) -> int:
        emitted = job.planner_cursor.chunks_emitted
        if emitted == 0:
            return self._config.chunk_startup_target_chars
        if emitted < 3:
            return self._config.chunk_safety_target_chars
        return self._config.chunk_steady_target_chars

    def _find_boundary(self, text: str, target_chars: int, *, startup_mode: bool) -> int:
        if len(text) <= target_chars:
            return len(text)

        candidates = [
            self._last_boundary(text, target_chars, r"\n\n+"),
            self._last_boundary(text, target_chars, r"(?<=[.!?])\s+"),
            self._last_boundary(text, target_chars, r"(?<=[,;:])\s+"),
        ]
        minimum_boundary = 20 if startup_mode else max(40, int(target_chars * 0.45))
        for candidate in candidates:
            if candidate is not None and candidate >= minimum_boundary:
                return candidate

        hard_limit = min(len(text), int(target_chars * 1.2))
        space_index = text.rfind(" ", 0, hard_limit)
        if space_index > 0:
            return space_index
        return hard_limit

    def _last_boundary(self, text: str, target_chars: int, pattern: str) -> int | None:
        last_match: int | None = None
        for match in re.finditer(pattern, text[: int(target_chars * 1.2)]):
            last_match = match.end()
        return last_match
