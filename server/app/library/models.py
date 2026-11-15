"""Library domain entities.

These are the things a listener owns: folders (ordered, nestable containers that
are also playable), their listening progress, and the trash. Job storage lives
in `app.jobs.models`; the library only adds ordering and soft-delete metadata to
a job.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import StrEnum

from app.core.identity import DEFAULT_USER_ID
from app.core.time import utc_now
from app.jobs.models import Job, JobSummary

# A job as the library sees it: either the full aggregate or its flat summary.
# Ordering and playback helpers accept both, so a caller never loads chunks it
# will not use. A union (not a protocol) because both are concrete, and because
# `JobSummary` is frozen — a mutable protocol member would not accept it.
FolderJob = Job | JobSummary


class TrashKind(StrEnum):
    FOLDER = "folder"
    JOB = "job"


@dataclass(slots=True)
class Folder:
    """An ordered, nestable group of jobs that can also be played.

    Folders are always listed before jobs inside a folder. Playing a folder
    traverses only its **direct** job children; sub-folders are organization and
    are played on their own.
    """

    id: str
    name: str
    user_id: str = DEFAULT_USER_ID
    parent_id: str | None = None
    # Manual order among siblings. Jobs and folders have separate sequences
    # because the UI always renders folders first.
    position: int = 0
    created_at: float = field(default_factory=utc_now)
    updated_at: float = field(default_factory=utc_now)
    # Soft delete. `trash_entry_id` groups a whole subtree under one trash entry
    # so restoring a folder restores everything that was inside it.
    deleted_at: float | None = None
    trash_entry_id: str | None = None


@dataclass(slots=True)
class JobProgress:
    """One user's listening state for one job.

    - `position_seconds` is job-timeline seconds (0 = start of the first chunk).
    - `heard` maps chunk index -> the **version** that was heard. Keying on the
      version is what makes a reprocessed chunk unheard again automatically, and
      it needs no cross-service invalidation writes.
    - `audio_epoch` is the job epoch the heard marks belong to. A full re-render
      bumps the job's epoch, so the old marks stop counting without deleting
      them (and the client re-reports as it listens again).
    - `heard_seconds` is the duration of the takes that are *currently* valid
      heard marks. It is stored, not derived, so the remaining-audio estimate
      needs no chunk access; `ProgressService` and the chunk-write path are its
      only writers.
    """

    user_id: str
    job_id: str
    position_seconds: float = 0.0
    audio_epoch: int = 0
    heard: dict[int, int] = field(default_factory=dict)
    heard_seconds: float = 0.0
    updated_at: float = field(default_factory=utc_now)


@dataclass(slots=True)
class TrashEntry:
    """One deleted item, or one deleted folder with its whole subtree."""

    id: str
    user_id: str
    kind: TrashKind
    root_id: str
    name: str
    # Where the root lived, so Restore can put it back. None = root library.
    parent_id: str | None = None
    job_count: int = 0
    created_at: float = field(default_factory=utc_now)
