"""Shared estimate of how long a chunk will take to speak.

Two places need this number and they must agree: the admin queue view reports an
expected duration, and the provider derives its generation-token budget from it.
It used to be re-derived at each site (and a third copy was computed by the
planner and never read). The helper takes a character count because that is
what every caller has on hand — the provider only knows the batch's longest
chunk length.
"""

from __future__ import annotations


def estimated_speech_seconds(char_count: int, *, chars_per_second: float) -> float:
    """Rough spoken length of `char_count` characters at the configured rate.

    Floored at one second so an empty or one-word chunk is still a sane unit
    for budgets; callers that want a different floor apply their own.
    """
    if chars_per_second <= 0:
        raise ValueError("chars_per_second must be positive")
    return max(1.0, char_count / chars_per_second)
