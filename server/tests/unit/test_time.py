"""The time contract: epoch floats in the domain, `Z` on the wire.

Every instant in the API ends in an explicit `Z`, and the same stored value
means the same instant regardless of the host process's `TZ`. That is what lets
a browser render it in the viewer's own zone without guessing.
"""

from __future__ import annotations

import os
import subprocess
import sys
from datetime import UTC, datetime, timedelta, timezone
from pathlib import Path

import pytest

from app.core.time import from_datetime, from_iso, to_datetime, to_iso, utc_now

SERVER_DIR = Path(__file__).resolve().parents[2]

FIXED_INSTANT = 1_763_229_851.0  # 2025-11-15T18:04:11Z


def test_utc_now_returns_epoch_seconds_that_advance() -> None:
    first = utc_now()
    second = utc_now()
    assert 1_600_000_000 < first <= second
    assert second - first < 5.0


def test_to_iso_always_ends_with_z_and_has_second_precision() -> None:
    assert to_iso(FIXED_INSTANT) == "2025-11-15T18:04:11Z"


def test_iso_round_trips_exactly() -> None:
    assert from_iso(to_iso(FIXED_INSTANT)) == FIXED_INSTANT


def test_to_iso_truncates_rather_than_rounding() -> None:
    # A timestamp must never claim a moment that has not happened yet.
    assert to_iso(FIXED_INSTANT + 0.999) == "2025-11-15T18:04:11Z"


def test_to_datetime_is_aware_utc() -> None:
    converted = to_datetime(FIXED_INSTANT)
    assert converted.tzinfo is UTC
    assert converted.utcoffset() == timedelta(0)
    assert converted.isoformat() == "2025-11-15T18:04:11+00:00"


def test_from_datetime_accepts_other_zones_but_rejects_naive_values() -> None:
    shifted = datetime(2025, 11, 15, 13, 4, 11, tzinfo=timezone(timedelta(hours=-5)))
    assert from_datetime(shifted) == FIXED_INSTANT
    with pytest.raises(ValueError):
        from_datetime(datetime(2025, 11, 15, 18, 4, 11))


def test_from_iso_rejects_a_zone_less_string() -> None:
    with pytest.raises(ValueError):
        from_iso("2025-11-15T18:04:11")


def test_instants_are_zone_independent_across_processes() -> None:
    """The same stored instant must mean the same thing under any host TZ.

    Runs a child process with an extreme zone and compares its rendering with
    this one's: a bug here is the classic "the server ran in local time" class of
    failure, and it only shows up when the process zone differs.
    """
    script = (
        "from app.core.time import to_iso, from_iso, to_datetime;"
        f"instant = {FIXED_INSTANT!r};"
        "print(to_iso(instant));"
        "print(to_datetime(instant).isoformat());"
        "print(from_iso('2025-11-15T18:04:11Z'))"
    )
    environment = {**os.environ, "TZ": "Pacific/Kiritimati"}
    output = subprocess.run(
        [sys.executable, "-c", script],
        cwd=SERVER_DIR,
        env=environment,
        capture_output=True,
        text=True,
        check=True,
    ).stdout.splitlines()

    assert output[0] == to_iso(FIXED_INSTANT)
    assert output[1] == to_datetime(FIXED_INSTANT).isoformat()
    assert float(output[2]) == FIXED_INSTANT
