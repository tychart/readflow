"""A bounded cache of canonical job source text.

The planner needs a job's whole text to cut the next chunk, and a scheduler tick
touches several jobs. Reading a book-sized source row on every tick is pure
overhead — the text is immutable for a job's lifetime — so the scheduler keeps
the text it has read, bounded by characters.

Budget, not entry count, because one 3 MiB book should not be worth the same as
one paragraph. A text larger than the whole budget is simply not cached: it is
read again next tick, which is still cheaper than evicting everything else.

`forget` is the correctness edge: purging a job must drop its text, or a later
job with a recycled id could be planned from the old document.
"""

from __future__ import annotations

from collections import OrderedDict


class SourceTextCache:
    """Least-recently-used cache of immutable job source text."""

    def __init__(self, budget_chars: int) -> None:
        self._budget = max(0, budget_chars)
        self._entries: OrderedDict[str, str] = OrderedDict()
        self._chars = 0

    @property
    def chars(self) -> int:
        """Characters currently held."""
        return self._chars

    @property
    def budget_chars(self) -> int:
        return self._budget

    def __len__(self) -> int:
        return len(self._entries)

    def __contains__(self, job_id: object) -> bool:
        return job_id in self._entries

    def get(self, job_id: str) -> str | None:
        text = self._entries.get(job_id)
        if text is None:
            return None
        # A hit is a use: keep it at the fresh end of the order.
        self._entries.move_to_end(job_id)
        return text

    def put(self, job_id: str, text: str) -> None:
        size = len(text)
        if self._budget == 0 or size > self._budget:
            # Never worth thrashing the cache for one document.
            self.forget(job_id)
            return
        previous = self._entries.pop(job_id, None)
        if previous is not None:
            self._chars -= len(previous)
        self._entries[job_id] = text
        self._chars += size
        while self._chars > self._budget and self._entries:
            _evicted_id, evicted = self._entries.popitem(last=False)
            self._chars -= len(evicted)

    def forget(self, job_id: str) -> None:
        removed = self._entries.pop(job_id, None)
        if removed is not None:
            self._chars -= len(removed)

    def clear(self) -> None:
        self._entries.clear()
        self._chars = 0
