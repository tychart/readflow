"""Unit tests for the scheduler's self-recovery policy.

The policy is pure so the "the queue froze and nothing ever recovered" cases
can be exercised without a GPU, a provider, or a running scheduler.
"""

from __future__ import annotations

import pytest

from app.scheduler.recovery import (
    MAX_RECOVERY_BACKOFF_EXPONENT,
    DispatchBlock,
    RecoveryAction,
    plan_recovery,
    recovery_delay_seconds,
)

STALL = 45.0


def test_no_stall_means_no_recovery():
    assert (
        plan_recovery(block=None, blocked_seconds=10_000, attempts=5, stall_seconds=STALL) is None
    )


def test_monitoring_blips_never_trigger_recovery():
    """Missing allocator readings clear themselves; unloading cannot help."""
    assert (
        plan_recovery(
            block=DispatchBlock.MONITORING,
            blocked_seconds=10_000,
            attempts=5,
            stall_seconds=STALL,
        )
        is None
    )


def test_automatic_recovery_can_be_disabled():
    for block in DispatchBlock:
        assert (
            plan_recovery(block=block, blocked_seconds=10_000, attempts=0, stall_seconds=0) is None
        )


def test_nothing_happens_before_the_stall_window():
    assert (
        plan_recovery(
            block=DispatchBlock.MEMORY,
            blocked_seconds=STALL - 0.1,
            attempts=0,
            stall_seconds=STALL,
        )
        is None
    )


@pytest.mark.parametrize(
    ("block", "expected"),
    [
        (DispatchBlock.MEMORY, RecoveryAction.UNLOAD_MODEL),
        (DispatchBlock.PROVIDER_ERROR, RecoveryAction.RESET_PROVIDER),
    ],
)
def test_each_block_has_the_action_that_can_actually_clear_it(block, expected):
    assert (
        plan_recovery(block=block, blocked_seconds=STALL, attempts=0, stall_seconds=STALL)
        == expected
    )


def test_memory_pressure_unloads_the_model_even_after_repeated_attempts():
    """Unloading is the only way to hand VRAM back while work is queued."""
    assert (
        plan_recovery(
            block=DispatchBlock.MEMORY,
            blocked_seconds=100_000,
            attempts=4,
            stall_seconds=STALL,
        )
        == RecoveryAction.UNLOAD_MODEL
    )


def test_recovery_delay_doubles_and_is_capped():
    assert recovery_delay_seconds(STALL, 0) == STALL
    assert recovery_delay_seconds(STALL, 1) == STALL * 2
    assert recovery_delay_seconds(STALL, 2) == STALL * 4
    assert recovery_delay_seconds(STALL, 99) == STALL * 2**MAX_RECOVERY_BACKOFF_EXPONENT
    # Negative attempt counts cannot make the delay shorter than one stall.
    assert recovery_delay_seconds(STALL, -3) == STALL


def test_backoff_holds_off_the_second_attempt():
    """A reload is expensive, so a failed first attempt must not retry at once."""
    assert (
        plan_recovery(
            block=DispatchBlock.MEMORY,
            blocked_seconds=STALL + 1,
            attempts=1,
            stall_seconds=STALL,
        )
        is None
    )
    assert (
        plan_recovery(
            block=DispatchBlock.MEMORY,
            blocked_seconds=STALL * 2,
            attempts=1,
            stall_seconds=STALL,
        )
        == RecoveryAction.UNLOAD_MODEL
    )
