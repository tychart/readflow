"""Per-(client, username) login throttle.

An in-process sliding window: five failures in five minutes lock the pair out for
an exponentially growing period, capped at fifteen minutes. `monotonic` and an
injectable clock, so the window arithmetic is unit-testable and a clock jump
cannot extend a lockout.

Single instance only, by design: there is no Redis in this product, and the
documented deployment is one API container. A restart forgets the windows, which
trades a brief window of attempts against a dependency that does not exist.
"""

from __future__ import annotations

from dataclasses import dataclass
from time import monotonic

FAILURES_BEFORE_LOCKOUT = 5
WINDOW_SECONDS = 300.0
BASE_LOCKOUT_SECONDS = 30.0
MAX_LOCKOUT_SECONDS = 15 * 60.0
# Bound the dict: an attacker can send unlimited distinct usernames.
MAX_TRACKED_KEYS = 4096


@dataclass(slots=True)
class _Attempts:
    failures: list[float]
    locked_until: float = 0.0


class LoginThrottle:
    def __init__(
        self,
        *,
        clock=monotonic,
        window_seconds: float = WINDOW_SECONDS,
        failures_before_lockout: int = FAILURES_BEFORE_LOCKOUT,
        base_lockout_seconds: float = BASE_LOCKOUT_SECONDS,
        max_lockout_seconds: float = MAX_LOCKOUT_SECONDS,
    ) -> None:
        self._clock = clock
        self._window = window_seconds
        self._limit = failures_before_lockout
        self._base_lockout = base_lockout_seconds
        self._max_lockout = max_lockout_seconds
        self._attempts: dict[tuple[str, str], _Attempts] = {}

    def retry_after(self, key: tuple[str, str]) -> float:
        """Seconds the caller must wait, or 0 when it may try now."""
        entry = self._attempts.get(key)
        if entry is None:
            return 0.0
        remaining = entry.locked_until - self._clock()
        return max(0.0, remaining)

    def check(self, key: tuple[str, str]) -> None:
        """Raise `RateLimitedError` when the key is locked."""
        retry_after = self.retry_after(key)
        if retry_after > 0:
            raise RateLimitedError(retry_after)

    def record_failure(self, key: tuple[str, str]) -> None:
        now = self._clock()
        entry = self._attempts.setdefault(key, _Attempts(failures=[]))
        # Everything older than the window no longer counts.
        entry.failures = [when for when in entry.failures if now - when <= self._window]
        entry.failures.append(now)
        if len(entry.failures) >= self._limit:
            # Each extra failure past the threshold doubles the wait.
            over = len(entry.failures) - self._limit
            lockout = min(self._max_lockout, self._base_lockout * (2**over))
            entry.locked_until = now + lockout
        self._prune(now)

    def record_success(self, key: tuple[str, str]) -> None:
        self._attempts.pop(key, None)

    def _prune(self, now: float) -> None:
        """Keep the dict bounded.

        Expired windows go first. If that is not enough — an attacker cycling
        usernames never lets anything expire — the least recently failed keys are
        dropped, because a throttle that grows without bound is a memory leak
        with a login endpoint attached.
        """
        if len(self._attempts) <= MAX_TRACKED_KEYS:
            return
        for key in [
            key
            for key, entry in self._attempts.items()
            if entry.locked_until <= now
            and all(now - when > self._window for when in entry.failures)
        ]:
            del self._attempts[key]
        while len(self._attempts) > MAX_TRACKED_KEYS:
            oldest = min(
                self._attempts,
                key=lambda key: (
                    self._attempts[key].failures[-1] if self._attempts[key].failures else 0.0
                ),
            )
            del self._attempts[oldest]


class RateLimitedError(Exception):
    """Too many failed attempts; `retry_after` is in seconds."""

    def __init__(self, retry_after: float) -> None:
        self.retry_after = retry_after
        super().__init__(f"Too many failed attempts; retry in {retry_after:.0f}s")
