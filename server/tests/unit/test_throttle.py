"""The login throttle: windows, lockouts, resets and bounded memory."""

from __future__ import annotations

import pytest

from app.auth.throttle import LoginThrottle, RateLimitedError

KEY = ("127.0.0.1", "someuser")


class Clock:
    def __init__(self) -> None:
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now

    def advance(self, seconds: float) -> None:
        self.now += seconds


def _throttle(clock: Clock, **kwargs) -> LoginThrottle:
    return LoginThrottle(clock=clock, **kwargs)


def test_a_fresh_key_may_try() -> None:
    throttle = _throttle(Clock())
    throttle.check(KEY)
    assert throttle.retry_after(KEY) == 0.0


def test_failures_below_the_threshold_do_not_lock() -> None:
    clock = Clock()
    throttle = _throttle(clock)
    for _ in range(4):
        throttle.record_failure(KEY)
    throttle.check(KEY)
    assert throttle.retry_after(KEY) == 0.0


def test_the_threshold_locks_the_key() -> None:
    clock = Clock()
    throttle = _throttle(clock)
    for _ in range(5):
        throttle.record_failure(KEY)

    assert throttle.retry_after(KEY) > 0
    with pytest.raises(RateLimitedError):
        throttle.check(KEY)


def test_the_lockout_expires() -> None:
    clock = Clock()
    throttle = _throttle(clock, base_lockout_seconds=30.0)
    for _ in range(5):
        throttle.record_failure(KEY)

    clock.advance(31)
    throttle.check(KEY)


def test_lockouts_grow_exponentially_and_are_capped() -> None:
    clock = Clock()
    throttle = _throttle(clock, base_lockout_seconds=30.0, max_lockout_seconds=120.0)
    retries = []
    for _ in range(9):
        throttle.record_failure(KEY)
        retries.append(round(throttle.retry_after(KEY)))
        # Step past the current lockout so the next failure counts again.
        clock.advance(throttle.retry_after(KEY) + 1)

    assert retries[:4] == [0, 0, 0, 0]
    assert retries[4] == 30  # the fifth failure locks
    assert retries[5] == 60  # doubling
    assert max(retries) == 120  # ... and the cap holds


def test_old_failures_fall_out_of_the_window() -> None:
    clock = Clock()
    throttle = _throttle(clock, window_seconds=300.0)
    for _ in range(4):
        throttle.record_failure(KEY)

    clock.advance(301)
    throttle.record_failure(KEY)
    # The four old failures no longer count, so this is the first in the window.
    throttle.check(KEY)
    assert throttle.retry_after(KEY) == 0.0


def test_a_success_resets_the_key() -> None:
    clock = Clock()
    throttle = _throttle(clock)
    for _ in range(4):
        throttle.record_failure(KEY)

    throttle.record_success(KEY)
    for _ in range(4):
        throttle.record_failure(KEY)

    throttle.check(KEY)
    assert throttle.retry_after(KEY) == 0.0


def test_keys_are_independent() -> None:
    clock = Clock()
    throttle = _throttle(clock)
    for _ in range(5):
        throttle.record_failure(KEY)

    other = ("127.0.0.1", "otheruser")
    throttle.check(other)
    assert throttle.retry_after(other) == 0.0


def test_tracking_is_bounded(monkeypatch: pytest.MonkeyPatch) -> None:
    """An attacker can try unlimited usernames; the dict must not grow forever."""
    from app.auth import throttle as throttle_module

    monkeypatch.setattr(throttle_module, "MAX_TRACKED_KEYS", 10)
    clock = Clock()
    throttle = _throttle(clock)
    for index in range(200):
        throttle.record_failure(("127.0.0.1", f"user{index}"))

    assert len(throttle._attempts) <= 11
