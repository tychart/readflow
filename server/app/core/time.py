"""One clock, one wire format.

The whole server agrees on three rules, and this module is the only place that
implements them:

- **Instants are unix-epoch seconds (`float`)** in the domain. Epoch seconds are
  UTC by definition, so no timezone state travels with a value.
- **Instant columns are `timestamptz`** in Postgres. The adapter converts with
  `to_datetime` / `from_datetime` and nothing else does.
- **The wire format is ISO-8601 with an explicit `Z`** (`2026-11-15T18:04:11Z`),
  so a browser can render it in the viewer's own zone and a zone-less string can
  never be silently misread. `to_iso` is the only formatter.

Durations and positions (`*_seconds`, `duration_seconds`, `position_seconds`,
`buffered_seconds`, …) are *not* instants: they stay plain floats and must never
be stored as a timestamp. `time.monotonic()` likewise stays for scheduler stalls,
recovery backoff and throttle windows — it is never persisted, so it does not
appear here.

Nothing outside this module calls `time.time()`.
"""

from __future__ import annotations

from datetime import UTC, datetime
from time import time

_ISO_FORMAT = "%Y-%m-%dT%H:%M:%SZ"


def utc_now() -> float:
    """Current instant as unix-epoch seconds (UTC by definition)."""
    return time()


def to_datetime(epoch: float) -> datetime:
    """Convert an epoch instant to a timezone-aware UTC `datetime`."""
    return datetime.fromtimestamp(epoch, tz=UTC)


def from_datetime(value: datetime) -> float:
    """Convert a timezone-aware `datetime` to epoch seconds.

    A naive datetime is rejected rather than assumed to be UTC: assuming is how
    a local-time value ends up in the database after a host timezone change.
    """
    if value.tzinfo is None or value.utcoffset() is None:
        raise ValueError("A timezone-aware datetime is required")
    return value.timestamp()


def to_iso(epoch: float) -> str:
    """Render an instant for the API, always ending in `Z`.

    Second precision is deliberate: every consumer either displays the instant
    or uses it for a relative age, and the extra digits only made payloads
    noisier. Sub-second values are truncated, not rounded, so a timestamp never
    claims a moment that has not happened.
    """
    return to_datetime(epoch).strftime(_ISO_FORMAT)


def from_iso(text: str) -> float:
    """Parse an ISO-8601 instant, rejecting a value without a timezone."""
    parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
    return from_datetime(parsed)
