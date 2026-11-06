"""HTTP <-> response mapping that needs more than one service.

The router stays a thin translator: these helpers gather the derived progress
view and the folder context the reader needs, so neither the schema layer nor
the React app has to re-derive ordering or listening state.
"""

from __future__ import annotations

from collections.abc import Iterable

from app.core.services import AppServices
from app.jobs.models import Job
from app.library.playback import next_job_in_folder, previous_job_in_folder
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


def job_summary_response(services: AppServices, job: Job) -> JobSummaryResponse:
    return job_to_summary(job, progress=services.progress.view(job))


def job_summaries_response(services: AppServices, jobs: Iterable[Job]) -> list[JobSummaryResponse]:
    jobs = list(jobs)
    views = services.progress.views(jobs)
    return [job_to_summary(job, progress=views.get(job.id)) for job in jobs]


def job_detail_response(services: AppServices, job: Job) -> JobDetailResponse:
    all_jobs = services.job_manager.list_jobs()
    path = services.library.folder_path(job.folder_id)
    previous = previous_job_in_folder(all_jobs, job)
    following = next_job_in_folder(all_jobs, job)
    return job_to_detail(
        job,
        progress=services.progress.view(job),
        folder_path=[FolderBriefResponse(id=folder.id, name=folder.name) for folder in path],
        previous_job_id=previous.id if previous is not None else None,
        next_job_id=following.id if following is not None else None,
    )


def library_job_response(
    services: AppServices, job: Job, views: dict[str, ProgressView]
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
