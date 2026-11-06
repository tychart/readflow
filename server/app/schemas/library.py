"""Request/response models for the library API.

Kept out of `schemas/api.py` so the folder/trash surface can grow without
turning the job schema module into a dumping ground.
"""

from __future__ import annotations

from pydantic import BaseModel, Field

from app.library.models import TrashKind
from app.schemas.api import JobProgressResponse, JobSummaryResponse


class FolderResponse(BaseModel):
    id: str
    name: str
    parent_id: str | None
    position: int
    # Recursive live job count (nested folders included) and direct sub-folder
    # count, so the tree can render counts without walking every job.
    job_count: int = 0
    folder_count: int = 0
    # Chunk-weighted progress across the whole subtree.
    progress_fraction: float = 0.0


class LibraryJobResponse(JobSummaryResponse):
    position: int = 0


class LibraryResponse(BaseModel):
    folders: list[FolderResponse]
    jobs: list[LibraryJobResponse]
    trash_count: int = 0


class TrashEntryResponse(BaseModel):
    id: str
    kind: TrashKind
    name: str
    parent_id: str | None
    job_count: int
    created_at: float


class ItemRef(BaseModel):
    kind: TrashKind
    id: str


class FolderCreateRequest(BaseModel):
    name: str
    parent_id: str | None = None


class FolderUpdateRequest(BaseModel):
    name: str | None = None


class JobUpdateRequest(BaseModel):
    title: str | None = None


class ReorderRequest(BaseModel):
    parent_id: str | None = None
    folder_ids: list[str] = Field(default_factory=list)
    job_ids: list[str] = Field(default_factory=list)


class MoveRequest(BaseModel):
    items: list[ItemRef]
    folder_id: str | None = None


class DeleteRequest(BaseModel):
    items: list[ItemRef]


class ReadRequest(BaseModel):
    items: list[ItemRef]
    read: bool


class RestoreRequest(BaseModel):
    entry_ids: list[str]


class PurgeRequest(BaseModel):
    entry_ids: list[str] = Field(default_factory=list)
    empty: bool = False


class ProgressUpdateRequest(BaseModel):
    # Job-timeline seconds (0 = start of the first chunk).
    position_seconds: float = 0.0
    is_playing: bool = True
    # Additive: the client reports what it has heard since the last flush.
    heard_chunk_indexes: list[int] = Field(default_factory=list)


class JobReadRequest(BaseModel):
    read: bool
    from_chunk: int | None = None


class ChunkHeardRequest(BaseModel):
    heard: bool = True


class ProgressUpdateResponse(BaseModel):
    job_id: str
    position_seconds: float
    progress: JobProgressResponse
