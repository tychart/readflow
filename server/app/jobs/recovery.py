"""Startup reconciliation: what a crashed process left behind.

Jobs and chunks are persisted, but the process that was rendering them is not.
On startup the database can therefore describe work that no process is doing:

- chunks still marked `RENDERING` (the batch died with the process),
- chunks marked `WRITTEN` whose audio is no longer on the volume (a container was
  recreated without its media volume, or the media directory was cleaned),
- listener flags that outlived the tab that set them.

The decision is a **pure function** here so it can be tested against a fixture
without a database; `JobManager.recover_after_restart` applies it, one
transaction per job. Applying it twice must change nothing the second time.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass

from app.jobs.models import ChunkRecord, ChunkStatus, Job


@dataclass(frozen=True, slots=True)
class RecoveryPlan:
    """What `recover_after_restart` should do to one job."""

    # Chunks to put back in the queue: interrupted renders and takes whose audio
    # disappeared.
    requeue: tuple[ChunkRecord, ...] = ()
    # The subset of `requeue` whose media references must be cleared, because
    # the file they point at is gone.
    reset_audio: tuple[ChunkRecord, ...] = ()
    # A listener flag cannot outlive the process that reported it.
    clear_listener: bool = False

    @property
    def needed(self) -> bool:
        return bool(self.requeue or self.reset_audio or self.clear_listener)


@dataclass(frozen=True, slots=True)
class RecoveryResult:
    """Which jobs the reconciliation changed (empty on a clean shutdown)."""

    examined: int = 0
    recovered: tuple[str, ...] = ()


def plan_startup_recovery(
    job: Job,
    audio_exists: Callable[[ChunkRecord], bool] | None = None,
) -> RecoveryPlan:
    """Decide what to repair for one job, without mutating it.

    `audio_exists` answers "is this written take still on disk?". Passing `None`
    skips that check, which is what a database-only test wants and what a
    development run without a media volume wants.
    """
    requeue: list[ChunkRecord] = []
    reset_audio: list[ChunkRecord] = []
    for chunk in job.active_chunks():
        if chunk.status == ChunkStatus.RENDERING:
            # The batch was in flight when the process stopped. Its attempt is
            # not charged: the crash was not the chunk's fault.
            requeue.append(chunk)
            continue
        if (
            chunk.status == ChunkStatus.WRITTEN
            and audio_exists is not None
            and not audio_exists(chunk)
        ):
            requeue.append(chunk)
            reset_audio.append(chunk)
    clear_listener = job.is_active_listening or job.playback_state.is_playing
    return RecoveryPlan(
        requeue=tuple(requeue),
        reset_audio=tuple(reset_audio),
        clear_listener=clear_listener,
    )
