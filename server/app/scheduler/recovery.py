"""Self-recovery policy for a scheduler that has work but cannot dispatch.

The scheduling loop must always be able to make progress, or at least surface
why it cannot. Two conditions used to trap it while every tick still
"succeeded" (so `consecutive_errors` stayed 0, `last_error` stayed `None`, and
nothing was written to the log):

1. **VRAM hard-limit deadlock.** The check compared the allocator's *reserved*
   pool against the limit, but reserved only grows and is mostly free cache.
   One peak batch (11,008 MiB reserved while only 4,047 MiB was live on a 12 GB
   card) pinned the pool above the 11,000 MiB limit forever. Dispatch paused,
   and `maybe_unload_idle` kept the model resident because pending work
   postponed the idle unload — so the scheduler could neither render nor
   release the memory. It stayed like that for hours.

2. **Provider circuit breaker.** A timed-out synthesis or load sets
   `ModelState.ERROR`, which pauses dispatch until a human clicks
   "Reset provider" in Admin.

`plan_recovery` is the escalating, backoff-bounded answer to both: when
dispatch has been blocked for a while with work pending, drop the thing that is
blocking it (the resident model's weights, or the poisoned provider executor)
and let the next tick try again. The policy is pure so it can be unit-tested
without a GPU.
"""

from __future__ import annotations

from enum import StrEnum


class DispatchBlock(StrEnum):
    """Why a tick could not dispatch a batch even though work was pending."""

    # Live (non-reclaimable) VRAM is at or above the configured hard limit.
    MEMORY = "memory"
    # `ModelState.ERROR`: the provider timed out or failed to load.
    PROVIDER_ERROR = "provider_error"
    # The allocator readings are missing. A monitoring blip, not a stall:
    # dispatch resumes by itself as soon as the readings do.
    MONITORING = "monitoring"


class RecoveryAction(StrEnum):
    """An escalating action that can make a blocked scheduler dispatch again."""

    # Drop the loaded weights (and the allocator pool with them). The next
    # dispatch reloads the model, which is the only way to hand VRAM back while
    # unrendered work is still queued.
    UNLOAD_MODEL = "unload_model"
    # Replace the provider's single worker thread, abandoning a call that is
    # stuck in native code.
    RESET_PROVIDER = "reset_provider"


# Cap on the doubling so the wait between attempts tops out at
# `stall_seconds * 32` (~24 minutes at the default) instead of growing without
# bound. Neither action is free — a model reload is tens of seconds of GPU work
# — so retrying faster than that would be counterproductive.
MAX_RECOVERY_BACKOFF_EXPONENT = 5


def recovery_delay_seconds(stall_seconds: float, attempts: int) -> float:
    """How long dispatch must stay blocked before recovery attempt `attempts`.

    `attempts` is the number of actions already taken in the current stall, so
    the first attempt waits `stall_seconds`, the second twice that, and so on.
    """
    if attempts < 0:
        attempts = 0
    return stall_seconds * float(2 ** min(attempts, MAX_RECOVERY_BACKOFF_EXPONENT))


def plan_recovery(
    *,
    block: DispatchBlock | None,
    blocked_seconds: float,
    attempts: int,
    stall_seconds: float,
) -> RecoveryAction | None:
    """Choose the recovery action for this tick, or `None` to keep waiting.

    `stall_seconds <= 0` disables automatic recovery entirely, leaving the
    warning visible in Admin and the decision to an operator.
    """
    if block is None or block == DispatchBlock.MONITORING:
        return None
    if stall_seconds <= 0:
        return None
    if blocked_seconds < recovery_delay_seconds(stall_seconds, attempts):
        return None
    if block == DispatchBlock.PROVIDER_ERROR:
        return RecoveryAction.RESET_PROVIDER
    return RecoveryAction.UNLOAD_MODEL
