"""Library, trash and listening-progress HTTP surface.

The router only translates HTTP into `LibraryService` / `ProgressService` calls
and broadcasts invalidation events; all rules live in `app.library`.
"""

from __future__ import annotations

from collections.abc import Callable

from fastapi import APIRouter, Depends, HTTPException, status

from app.api.deps import user_services
from app.api.mappers import job_summary_response, library_response
from app.core.services import AppServices
from app.core.time import to_iso
from app.core.user_services import UserServices
from app.jobs.models import Job
from app.library.models import Folder, TrashEntry
from app.library.tree import LibraryError, LibraryItem, descendant_folder_ids
from app.schemas.api import (
    JobSummaryResponse,
    WsEnvelope,
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


async def _broadcast_library(services: AppServices, user_id: str, reason: str) -> None:
    await services.hub.send_to_user(
        user_id, WsEnvelope(type="library_changed", payload={"reason": reason}).model_dump()
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
        created_at=to_iso(entry.created_at),
    )


def build_library_router(get_services: Callable[[], AppServices]) -> APIRouter:
    router = APIRouter()

    async def services() -> AppServices:
        return get_services()

    # ── snapshot ────────────────────────────────────────────────────────────

    @router.get("/library", response_model=LibraryResponse)
    async def get_library(
        app_services: AppServices = Depends(services),
        user: UserServices = Depends(user_services),
    ) -> LibraryResponse:
        return await library_response(user)

    # ── folders and titles ─────────────────────────────────────────────────

    @router.post("/folders", response_model=FolderResponse, status_code=status.HTTP_201_CREATED)
    async def create_folder(
        request: FolderCreateRequest,
        app_services: AppServices = Depends(services),
        user: UserServices = Depends(user_services),
    ) -> FolderResponse:
        try:
            folder = await user.library.create_folder(request.name, request.parent_id)
        except (KeyError, LibraryError) as exc:
            raise _http_error(exc) from exc
        await _broadcast_library(app_services, user.user_id, "folder_created")
        return _folder_response(folder)

    @router.patch("/folders/{folder_id}", response_model=FolderResponse)
    async def update_folder(
        folder_id: str,
        request: FolderUpdateRequest,
        app_services: AppServices = Depends(services),
        user: UserServices = Depends(user_services),
    ) -> FolderResponse:
        try:
            if request.name is None:
                raise LibraryError("Nothing to update")
            folder = await user.library.rename_folder(folder_id, request.name)
        except (KeyError, LibraryError) as exc:
            raise _http_error(exc) from exc
        await _broadcast_library(app_services, user.user_id, "folder_updated")
        return _folder_response(folder)

    @router.patch("/jobs/{job_id}", response_model=JobSummaryResponse)
    async def update_job(
        job_id: str,
        request: JobUpdateRequest,
        app_services: AppServices = Depends(services),
        user: UserServices = Depends(user_services),
    ) -> JobSummaryResponse:
        try:
            if request.title is None:
                raise LibraryError("Nothing to update")
            job = await user.library.rename_job(job_id, request.title)
        except (KeyError, LibraryError) as exc:
            raise _http_error(exc) from exc
        await _broadcast_library(app_services, user.user_id, "job_updated")
        return await job_summary_response(user, job.summary())

    # ── ordering and bulk operations ────────────────────────────────────────

    @router.post("/library/reorder", status_code=status.HTTP_204_NO_CONTENT)
    async def reorder(
        request: ReorderRequest,
        app_services: AppServices = Depends(services),
        user: UserServices = Depends(user_services),
    ) -> None:
        try:
            await user.library.reorder(request.parent_id, request.folder_ids, request.job_ids)
        except (KeyError, LibraryError) as exc:
            raise _http_error(exc) from exc
        await _broadcast_library(app_services, user.user_id, "reordered")

    @router.post("/library/move", status_code=status.HTTP_204_NO_CONTENT)
    async def move(
        request: MoveRequest,
        app_services: AppServices = Depends(services),
        user: UserServices = Depends(user_services),
    ) -> None:
        try:
            await user.library.move(
                [LibraryItem(kind=item.kind, id=item.id) for item in request.items],
                request.folder_id,
            )
        except (KeyError, LibraryError) as exc:
            raise _http_error(exc) from exc
        await _broadcast_library(app_services, user.user_id, "moved")

    @router.post("/library/delete", status_code=status.HTTP_204_NO_CONTENT)
    async def delete(
        request: DeleteRequest,
        app_services: AppServices = Depends(services),
        user: UserServices = Depends(user_services),
    ) -> None:
        try:
            await user.library.delete(
                [LibraryItem(kind=item.kind, id=item.id) for item in request.items]
            )
        except (KeyError, LibraryError) as exc:
            raise _http_error(exc) from exc
        await _broadcast_library(app_services, user.user_id, "deleted")

    @router.post("/folders/{folder_id}/delete-only", status_code=status.HTTP_204_NO_CONTENT)
    async def delete_folder_only(
        folder_id: str,
        app_services: AppServices = Depends(services),
        user: UserServices = Depends(user_services),
    ) -> None:
        try:
            await user.library.delete_folder_only(folder_id)
        except (KeyError, LibraryError) as exc:
            raise _http_error(exc) from exc
        await _broadcast_library(app_services, user.user_id, "deleted")

    @router.post("/library/read", status_code=status.HTTP_204_NO_CONTENT)
    async def mark_read(
        request: ReadRequest,
        app_services: AppServices = Depends(services),
        user: UserServices = Depends(user_services),
    ) -> None:
        try:
            job_ids = await _job_ids_for_items(user, request.items)
            await user.progress.mark_many(job_ids, read=request.read)
        except (KeyError, LibraryError) as exc:
            raise _http_error(exc) from exc
        # Bulk selections can cover a whole folder; `library_changed` is the
        # invalidation signal, so per-job progress events would be pure noise.
        await _broadcast_library(app_services, user.user_id, "read_state")

    # ── trash ───────────────────────────────────────────────────────────────

    @router.get("/trash", response_model=list[TrashEntryResponse])
    async def list_trash(
        app_services: AppServices = Depends(services),
        user: UserServices = Depends(user_services),
    ) -> list[TrashEntryResponse]:
        return [_trash_response(entry) for entry in await user.library.list_trash()]

    @router.post("/trash/restore", status_code=status.HTTP_204_NO_CONTENT)
    async def restore_trash(
        request: RestoreRequest,
        app_services: AppServices = Depends(services),
        user: UserServices = Depends(user_services),
    ) -> None:
        try:
            await user.library.restore(request.entry_ids)
        except (KeyError, LibraryError) as exc:
            raise _http_error(exc) from exc
        await _broadcast_library(app_services, user.user_id, "restored")

    @router.post("/trash/purge", status_code=status.HTTP_204_NO_CONTENT)
    async def purge_trash(
        request: PurgeRequest,
        app_services: AppServices = Depends(services),
        user: UserServices = Depends(user_services),
    ) -> None:
        try:
            purged = await user.library.purge(None if request.empty else request.entry_ids)
        except (KeyError, LibraryError) as exc:
            raise _http_error(exc) from exc
        for job_id in purged:
            app_services.media_store.remove_job(job_id)
            app_services.scheduler.forget_source(job_id)
        await _broadcast_library(app_services, user.user_id, "purged")

    # ── listening progress ──────────────────────────────────────────────────

    @router.post("/jobs/{job_id}/progress", response_model=ProgressUpdateResponse)
    async def update_progress(
        job_id: str,
        request: ProgressUpdateRequest,
        app_services: AppServices = Depends(services),
        user: UserServices = Depends(user_services),
    ) -> ProgressUpdateResponse:
        try:
            job, progress = await user.progress.record(
                job_id,
                position_seconds=request.position_seconds,
                is_playing=request.is_playing,
                heard_chunk_indexes=request.heard_chunk_indexes,
            )
        except KeyError as exc:
            raise _http_error(exc) from exc
        await _broadcast_progress(app_services, user, [job_id])
        return await _progress_response(user, job, progress.position_seconds)

    @router.post("/jobs/{job_id}/read", response_model=ProgressUpdateResponse)
    async def update_job_read(
        job_id: str,
        request: JobReadRequest,
        app_services: AppServices = Depends(services),
        user: UserServices = Depends(user_services),
    ) -> ProgressUpdateResponse:
        try:
            job, progress = await user.progress.mark_job(
                job_id, read=request.read, from_chunk=request.from_chunk
            )
        except KeyError as exc:
            raise _http_error(exc) from exc
        await _broadcast_library(app_services, user.user_id, "read_state")
        await _broadcast_progress(app_services, user, [job_id])
        return await _progress_response(user, job, progress.position_seconds)

    @router.post(
        "/jobs/{job_id}/chunks/{chunk_index}/heard",
        response_model=ProgressUpdateResponse,
    )
    async def update_chunk_heard(
        job_id: str,
        chunk_index: int,
        request: ChunkHeardRequest,
        app_services: AppServices = Depends(services),
        user: UserServices = Depends(user_services),
    ) -> ProgressUpdateResponse:
        try:
            job, progress = await user.progress.mark_chunk(job_id, chunk_index, heard=request.heard)
        except KeyError as exc:
            raise _http_error(exc) from exc
        await _broadcast_library(app_services, user.user_id, "read_state")
        await _broadcast_progress(app_services, user, [job_id])
        return await _progress_response(user, job, progress.position_seconds)

    return router


async def _job_ids_for_items(user: UserServices, items: list[ItemRef]) -> list[str]:
    """Expand folder selections to their recursive jobs (bulk read)."""
    snapshot = await user.library.snapshot()
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


async def _progress_response(
    user: UserServices, job: Job, position_seconds: float
) -> ProgressUpdateResponse:
    view = await user.progress.view(job)
    return ProgressUpdateResponse(
        job_id=job.id,
        position_seconds=position_seconds,
        progress=progress_to_response(view),
    )


async def _broadcast_progress(
    services: AppServices, user: UserServices, job_ids: list[str]
) -> None:
    """Keep the owner's other tabs fresh without re-sending chunk text.

    One event per job, to the owner only. A second listener on the same account
    gets it; nobody else does.
    """
    for job_id in job_ids:
        job = await user.jobs.get_job(job_id)
        view = await user.progress.view(job)
        await services.hub.send_to_user(
            user.user_id,
            WsEnvelope(
                type="job_progress",
                payload={"job_id": job_id, "progress": progress_to_response(view).model_dump()},
            ).model_dump(),
        )
