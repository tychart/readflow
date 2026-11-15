"""HTTP <-> response mapping that needs more than one service.

The router stays a thin translator: these helpers gather the derived progress
view and the folder context the reader needs, so neither the schema layer nor
the React app has to re-derive ordering or listening state.

Everything here works from `JobSummary` unless it genuinely needs the aggregate
(the reader's detail view, which ships the chunk list and the source text).
"""

from __future__ import annotations

from collections.abc import Iterable

from app.core.services import AppServices
from app.jobs.models import Job, JobSummary
from app.library.playback import (
    next_job_in_folder,
    ordered_folder_jobs,
    previous_job_in_folder,
)
from app.library.progress import ProgressView, aggregate_fraction
from app.library.tree import descendant_folder_ids, subtree_counts
from app.schemas.api import (
    FolderBriefResponse,
    JobDetailResponse,
    JobSummaryResponse,
    job_to_detail,
    job_to_summary,
)
from app.schemas.library import (
    FolderResponse,
    LibraryJobResponse,
    LibraryResponse,
)


def job_summary_response(services: AppServices, job: JobSummary) -> JobSummaryResponse:
    return job_to_summary(job, progress=services.progress.view(job))


def job_summaries_response(
    services: AppServices, jobs: Iterable[JobSummary]
) -> list[JobSummaryResponse]:
    jobs = list(jobs)
    views = services.progress.views(jobs)
    return [job_to_summary(job, progress=views.get(job.id)) for job in jobs]


def job_detail_response(services: AppServices, job: Job) -> JobDetailResponse:
    """One job's full reader payload, including its canonical source text.

    This is the only read that materialises the source text, and it is the only
    one that needs folder neighbours; both are fetched here so the route stays a
    translator.
    """
    siblings = services.job_manager.summaries()
    path = services.library.folder_path(job.folder_id)
    previous = previous_job_in_folder(siblings, job)
    following = next_job_in_folder(siblings, job)
    ordered = ordered_folder_jobs(siblings, job.folder_id) if job.folder_id else []
    index = next(
        (position + 1 for position, item in enumerate(ordered) if item.id == job.id),
        None,
    )
    return job_to_detail(
        job,
        source_text=services.job_manager.source_text(job.id),
        progress=services.progress.view(job),
        folder_path=[FolderBriefResponse(id=folder.id, name=folder.name) for folder in path],
        previous_job_id=previous.id if previous is not None else None,
        next_job_id=following.id if following is not None else None,
        folder_index=index,
        folder_count=len(ordered) if ordered else None,
        previous_job_title=previous.title if previous is not None else None,
        next_job_title=following.title if following is not None else None,
    )


def library_job_response(
    services: AppServices, job: JobSummary, views: dict[str, ProgressView]
) -> LibraryJobResponse:
    summary = job_to_summary(job, progress=views.get(job.id))
    return LibraryJobResponse(**summary.model_dump(), position=job.position)


def library_response(services: AppServices) -> LibraryResponse:
    """One consistent snapshot for the library page.

    Folder counts and progress are computed here, not in React: the aggregate
    rules (recursive jobs, chunk-weighted progress) belong next to the storage
    model, and the tree then renders what it is given.
    """
    snapshot = services.library.snapshot()
    views = services.progress.views(snapshot.jobs)
    counts = subtree_counts(snapshot.folders, snapshot.jobs)
    folder_counts: dict[str, int] = {}
    for folder in snapshot.folders:
        folder_counts[folder.id] = sum(
            1 for child in snapshot.folders if child.parent_id == folder.id
        )
    folders = [
        FolderResponse(
            id=folder.id,
            name=folder.name,
            parent_id=folder.parent_id,
            position=folder.position,
            job_count=counts.get(folder.id, 0),
            folder_count=folder_counts[folder.id],
            progress_fraction=aggregate_fraction(
                [
                    job
                    for job in snapshot.jobs
                    if job.folder_id in descendant_folder_ids(snapshot.folders, folder.id)
                ],
                views,
            ),
        )
        for folder in snapshot.folders
    ]
    # Sorting here keeps the payload deterministic; the client still owns the
    # tree shape (folders first, then jobs).
    folders.sort(key=lambda f: (f.parent_id or "", f.position, f.name))
    jobs = sorted(snapshot.jobs, key=lambda job: (job.folder_id or "", job.position, job.id))
    return LibraryResponse(
        folders=folders,
        jobs=[library_job_response(services, job, views) for job in jobs],
        trash_count=snapshot.trash_count,
    )
