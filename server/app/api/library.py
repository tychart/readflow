"""Library, trash and listening-progress HTTP surface.

The router only translates HTTP into `LibraryService` / `ProgressService` calls
and broadcasts invalidation events; all rules live in `app.library`.
"""

from __future__ import annotations

from collections.abc import Callable

from fastapi import APIRouter, Depends, HTTPException, status

from app.api.mappers import library_response
from app.core.services import AppServices
from app.jobs.models import Job
from app.library.models import Folder, TrashEntry
from app.library.tree import LibraryError, LibraryItem, descendant_folder_ids
from app.schemas.api import (
    JobSummaryResponse,
    WsEnvelope,
    job_to_summary,
    progress_to_response,
)
from app.schemas.library import (
    ChunkHeardRequest,
    DeleteRequest,
    FolderCreateRequest,
    FolderResponse,
    FolderUpdateRequest,
    ItemRef,
    JobReadRequest,
    JobUpdateRequest,
    LibraryResponse,
    MoveRequest,
    ProgressUpdateRequest,
    ProgressUpdateResponse,
    PurgeRequest,
    ReadRequest,
    ReorderRequest,
    RestoreRequest,
    TrashEntryResponse,
)


def _http_error(exc: Exception) -> HTTPException:
    if isinstance(exc, KeyError):
        detail = exc.args[0] if exc.args else str(exc)
        return HTTPException(status_code=404, detail=str(detail))
    return HTTPException(status_code=422, detail=str(exc))


async def _broadcast_library(services: AppServices, reason: str) -> None:
    await services.hub.broadcast(
        WsEnvelope(type="library_changed", payload={"reason": reason}).model_dump()
    )


def _folder_response(folder: Folder) -> FolderResponse:
    return FolderResponse(
        id=folder.id,
        name=folder.name,
        parent_id=folder.parent_id,
        position=folder.position,
    )


def _trash_response(entry: TrashEntry) -> TrashEntryResponse:
    return TrashEntryResponse(
        id=entry.id,
        kind=entry.kind,
        name=entry.name,
        parent_id=entry.parent_id,
        job_count=entry.job_count,
        created_at=entry.created_at,
    )


def build_library_router(get_services: Callable[[], AppServices]) -> APIRouter:
    router = APIRouter()

    async def services() -> AppServices:
        return get_services()

    # ── snapshot ────────────────────────────────────────────────────────────

    @router.get("/library", response_model=LibraryResponse)
    async def get_library(
        app_services: AppServices = Depends(services),
    ) -> LibraryResponse:
        return library_response(app_services)

    # ── folders and titles ─────────────────────────────────────────────────

    @router.post("/folders", response_model=FolderResponse, status_code=status.HTTP_201_CREATED)
    async def create_folder(
        request: FolderCreateRequest,
        app_services: AppServices = Depends(services),
    ) -> FolderResponse:
        try:
            folder = app_services.library.create_folder(request.name, request.parent_id)
        except (KeyError, LibraryError) as exc:
            raise _http_error(exc) from exc
        await _broadcast_library(app_services, "folder_created")
        return _folder_response(folder)

    @router.patch("/folders/{folder_id}", response_model=FolderResponse)
    async def update_folder(
        folder_id: str,
        request: FolderUpdateRequest,
        app_services: AppServices = Depends(services),
    ) -> FolderResponse:
        try:
            if request.name is None:
                raise LibraryError("Nothing to update")
            folder = app_services.library.rename_folder(folder_id, request.name)
        except (KeyError, LibraryError) as exc:
            raise _http_error(exc) from exc
        await _broadcast_library(app_services, "folder_updated")
        return _folder_response(folder)

    @router.patch("/jobs/{job_id}", response_model=JobSummaryResponse)
    async def update_job(
        job_id: str,
        request: JobUpdateRequest,
        app_services: AppServices = Depends(services),
    ) -> JobSummaryResponse:
        try:
            if request.title is None:
                raise LibraryError("Nothing to update")
            job = app_services.library.rename_job(job_id, request.title)
        except (KeyError, LibraryError) as exc:
            raise _http_error(exc) from exc
        await _broadcast_library(app_services, "job_updated")
        return job_to_summary(job, progress=app_services.progress.view(job))

    # ── ordering and bulk operations ────────────────────────────────────────

    @router.post("/library/reorder", status_code=status.HTTP_204_NO_CONTENT)
    async def reorder(
        request: ReorderRequest,
        app_services: AppServices = Depends(services),
    ) -> None:
        try:
            app_services.library.reorder(request.parent_id, request.folder_ids, request.job_ids)
        except (KeyError, LibraryError) as exc:
            raise _http_error(exc) from exc
        await _broadcast_library(app_services, "reordered")

    @router.post("/library/move", status_code=status.HTTP_204_NO_CONTENT)
    async def move(
        request: MoveRequest,
        app_services: AppServices = Depends(services),
    ) -> None:
        try:
            app_services.library.move(
                [LibraryItem(kind=item.kind, id=item.id) for item in request.items],
                request.folder_id,
            )
        except (KeyError, LibraryError) as exc:
            raise _http_error(exc) from exc
        await _broadcast_library(app_services, "moved")

    @router.post("/library/delete", status_code=status.HTTP_204_NO_CONTENT)
    async def delete(
        request: DeleteRequest,
        app_services: AppServices = Depends(services),
    ) -> None:
        try:
            app_services.library.delete(
                [LibraryItem(kind=item.kind, id=item.id) for item in request.items]
            )
        except (KeyError, LibraryError) as exc:
            raise _http_error(exc) from exc
        await _broadcast_library(app_services, "deleted")

    @router.post("/folders/{folder_id}/delete-only", status_code=status.HTTP_204_NO_CONTENT)
    async def delete_folder_only(
        folder_id: str,
        app_services: AppServices = Depends(services),
    ) -> None:
        try:
            app_services.library.delete_folder_only(folder_id)
        except (KeyError, LibraryError) as exc:
            raise _http_error(exc) from exc
        await _broadcast_library(app_services, "deleted")

    @router.post("/library/read", status_code=status.HTTP_204_NO_CONTENT)
    async def mark_read(
        request: ReadRequest,
        app_services: AppServices = Depends(services),
    ) -> None:
        try:
            job_ids = _job_ids_for_items(app_services, request.items)
            app_services.progress.mark_many(job_ids, read=request.read)
        except (KeyError, LibraryError) as exc:
            raise _http_error(exc) from exc
        # Bulk selections can cover a whole folder; `library_changed` is the
        # invalidation signal, so per-job progress events would be pure noise.
        await _broadcast_library(app_services, "read_state")

    # ── trash ───────────────────────────────────────────────────────────────

    @router.get("/trash", response_model=list[TrashEntryResponse])
    async def list_trash(
        app_services: AppServices = Depends(services),
    ) -> list[TrashEntryResponse]:
        return [_trash_response(entry) for entry in app_services.library.list_trash()]

    @router.post("/trash/restore", status_code=status.HTTP_204_NO_CONTENT)
    async def restore_trash(
        request: RestoreRequest,
        app_services: AppServices = Depends(services),
    ) -> None:
        try:
            app_services.library.restore(request.entry_ids)
        except (KeyError, LibraryError) as exc:
            raise _http_error(exc) from exc
        await _broadcast_library(app_services, "restored")

    @router.post("/trash/purge", status_code=status.HTTP_204_NO_CONTENT)
    async def purge_trash(
        request: PurgeRequest,
        app_services: AppServices = Depends(services),
    ) -> None:
        try:
            purged = app_services.library.purge(None if request.empty else request.entry_ids)
        except (KeyError, LibraryError) as exc:
            raise _http_error(exc) from exc
        for job_id in purged:
            app_services.media_store.remove_job(job_id)
        await _broadcast_library(app_services, "purged")

    # ── listening progress ──────────────────────────────────────────────────

    @router.post("/jobs/{job_id}/progress", response_model=ProgressUpdateResponse)
    async def update_progress(
        job_id: str,
        request: ProgressUpdateRequest,
        app_services: AppServices = Depends(services),
    ) -> ProgressUpdateResponse:
        try:
            app_services.job_manager.update_playback(
                job_id, request.position_seconds, request.is_playing
            )
            job, progress = app_services.progress.record(
                job_id,
                position_seconds=request.position_seconds,
                heard_chunk_indexes=request.heard_chunk_indexes,
            )
        except KeyError as exc:
            raise _http_error(exc) from exc
        await _broadcast_progress(app_services, [job_id])
        return _progress_response(app_services, job, progress.position_seconds)

    @router.post("/jobs/{job_id}/read", response_model=ProgressUpdateResponse)
    async def update_job_read(
        job_id: str,
        request: JobReadRequest,
        app_services: AppServices = Depends(services),
    ) -> ProgressUpdateResponse:
        try:
            job, progress = app_services.progress.mark_job(
                job_id, read=request.read, from_chunk=request.from_chunk
            )
        except KeyError as exc:
            raise _http_error(exc) from exc
        await _broadcast_library(app_services, "read_state")
        await _broadcast_progress(app_services, [job_id])
        return _progress_response(app_services, job, progress.position_seconds)

    @router.post(
        "/jobs/{job_id}/chunks/{chunk_index}/heard",
        response_model=ProgressUpdateResponse,
    )
    async def update_chunk_heard(
        job_id: str,
        chunk_index: int,
        request: ChunkHeardRequest,
        app_services: AppServices = Depends(services),
    ) -> ProgressUpdateResponse:
        try:
            job, progress = app_services.progress.mark_chunk(
                job_id, chunk_index, heard=request.heard
            )
        except KeyError as exc:
            raise _http_error(exc) from exc
        await _broadcast_library(app_services, "read_state")
        await _broadcast_progress(app_services, [job_id])
        return _progress_response(app_services, job, progress.position_seconds)

    return router


def _job_ids_for_items(services: AppServices, items: list[ItemRef]) -> list[str]:
    """Expand folder selections to their recursive jobs (bulk read)."""
    snapshot = services.library.snapshot()
    folder_ids = {item.id for item in items if item.kind == "folder"}
    known_folders = {folder.id for folder in snapshot.folders}
    known_jobs = {job.id for job in snapshot.jobs}
    missing = (folder_ids - known_folders) | {
        item.id for item in items if item.kind == "job" and item.id not in known_jobs
    }
    if missing:
        raise KeyError(f"Unknown items: {', '.join(sorted(missing))}")
    subtree: set[str] = set()
    for folder_id in folder_ids:
        subtree |= descendant_folder_ids(snapshot.folders, folder_id)
    job_ids = {item.id for item in items if item.kind == "job"}
    job_ids |= {job.id for job in snapshot.jobs if job.folder_id in subtree}
    return sorted(job_ids)


def _progress_response(
    services: AppServices, job: Job, position_seconds: float
) -> ProgressUpdateResponse:
    view = services.progress.view(job)
    return ProgressUpdateResponse(
        job_id=job.id,
        position_seconds=position_seconds,
        progress=progress_to_response(view),
    )


async def _broadcast_progress(services: AppServices, job_ids: list[str]) -> None:
    """Keep a second tab's rows fresh without re-sending chunk text."""
    for job_id in job_ids:
        job = services.job_manager.get_job(job_id)
        view = services.progress.view(job)
        await services.hub.broadcast(
            WsEnvelope(
                type="job_progress",
                payload={"job_id": job_id, "progress": progress_to_response(view).model_dump()},
            ).model_dump()
        )
