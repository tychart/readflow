"""Pure playback-order helpers shared by the scheduler and the reader.

A folder plays only its **direct** jobs, in manual order. The next job after a
listened one is therefore a fact about the folder, not about a playlist object:
find the job's position among its siblings and take the next one.
"""

from __future__ import annotations

from collections.abc import Iterable

from app.jobs.models import Job


def ordered_folder_jobs(jobs: Iterable[Job], folder_id: str) -> list[Job]:
    """Live jobs directly inside `folder_id`, in manual order."""
    return sorted(
        (job for job in jobs if job.folder_id == folder_id and job.deleted_at is None),
        key=lambda job: (job.position, job.submitted_at, job.id),
    )


def next_job_in_folder(jobs: Iterable[Job], job: Job) -> Job | None:
    """The job after `job` inside its folder, or None (root job / last job)."""
    if job.folder_id is None:
        return None
    siblings = ordered_folder_jobs(jobs, job.folder_id)
    for position, candidate in enumerate(siblings):
        if candidate.id == job.id:
            return siblings[position + 1] if position + 1 < len(siblings) else None
    return None


def previous_job_in_folder(jobs: Iterable[Job], job: Job) -> Job | None:
    """The job before `job` inside its folder, or None."""
    if job.folder_id is None:
        return None
    siblings = ordered_folder_jobs(jobs, job.folder_id)
    for position, candidate in enumerate(siblings):
        if candidate.id == job.id:
            return siblings[position - 1] if position > 0 else None
    return None


def up_next_job_ids(jobs: Iterable[Job], *, prebuffer_seconds: int) -> set[str]:
    """Jobs that should be warmed because a listener is about to reach them.

    Derived, never stored: every actively playing job contributes its folder
    successor, and a successor stops needing priority once it already has
    `prebuffer_seconds` of contiguous audio. Root jobs have no successor, and a
    paused job contributes nothing.
    """
    all_jobs = list(jobs)
    up_next: set[str] = set()
    for job in all_jobs:
        if not job.is_active_listening or not job.playback_state.is_playing:
            continue
        successor = next_job_in_folder(all_jobs, job)
        if successor is None:
            continue
        if successor.contiguous_written_seconds >= prebuffer_seconds:
            continue
        up_next.add(successor.id)
    return up_next
