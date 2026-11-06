from __future__ import annotations

import re
from dataclasses import dataclass

from app.core.config import RuntimeConfig


@dataclass(frozen=True, slots=True)
class ChunkPlan:
    """One chunk cut out of the canonical source text.

    `char_start`/`char_end` are absolute offsets into `Job.source_text` and
    cover the separator whitespace up to the next chunk, so consecutive plans
    tile the document with no gaps and no overlap. `char_end` doubles as the
    offset planning continues from — a separate field for that was always the
    same value, and a default for it silently stopped planning.
    """

    text: str
    char_start: int
    char_end: int


class ChunkPlanner:
    """Splits a job's canonical source text into renderable chunks.

    A pure function of (text, offset): it never touches the job. `JobManager`
    owns the cursor and the chunk list, so a plan that is computed but never
    appended (a cancelled tick, a raised error) cannot silently skip text —
    the old version advanced the cursor before the chunk was stored.

    `Job.source_text` is already normalized (see
    `app.chunking.normalize.normalize_source_text`), so this planner only reads
    it. Re-normalizing here used to make planning a whole book O(n^2).
    """

    def __init__(self, config: RuntimeConfig) -> None:
        self._config = config

    def plan_next(self, text: str, offset: int) -> ChunkPlan | None:
        """Cut the next chunk out of `text` at `offset`, or None when done.

        Only a bounded window past `offset` is inspected. Slicing the whole
        remainder (the old implementation did `text[offset:]` and then scanned
        it) copied every remaining character once per chunk, which is quadratic
        work on a book even though each chunk only looks ~1.2 targets ahead.
        """
        if offset < 0 or offset >= len(text):
            return None
        target_chars = self._config.chunk_target_chars
        window_end = min(len(text), offset + int(target_chars * 1.2) + 1)
        window = text[offset:window_end]
        if not window.strip():
            return None

        char_end = self._find_boundary(window, target_chars)
        chunk_text = window[:char_end].strip()
        if not chunk_text:
            return None

        absolute_end = offset + char_end
        while absolute_end < len(text) and text[absolute_end].isspace():
            absolute_end += 1

        return ChunkPlan(text=chunk_text, char_start=offset, char_end=absolute_end)

    def _find_boundary(self, window: str, target_chars: int) -> int:
        """Index to cut `window` at, preferring a natural break near the target.

        `window` is already bounded by the caller (`plan_next`); this only looks
        inside it.
        """
        if len(window) <= target_chars:
            return len(window)

        candidates = [
            self._last_boundary(window, target_chars, r"\n\n+"),
            self._last_boundary(window, target_chars, r"(?<=[.!?])\s+"),
            self._last_boundary(window, target_chars, r"(?<=[,;:])\s+"),
        ]
        minimum_boundary = max(40, int(target_chars * 0.45))
        for candidate in candidates:
            if candidate is not None and candidate >= minimum_boundary:
                return candidate

        hard_limit = min(len(window), int(target_chars * 1.2))
        space_index = window.rfind(" ", 0, hard_limit)
        if space_index > 0:
            return space_index
        return hard_limit

    def _last_boundary(self, window: str, target_chars: int, pattern: str) -> int | None:
        last_match: int | None = None
        for match in re.finditer(pattern, window[: int(target_chars * 1.2)]):
            last_match = match.end()
        return last_match
