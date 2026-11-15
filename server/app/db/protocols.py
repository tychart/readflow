"""The storage boundary.

Everything the server keeps in PostgreSQL goes through these two protocols: a
`Database` that can open a transaction, and a `UnitOfWork` that exposes one
repository per entity for the duration of that transaction.

Two implementations satisfy them: `app.db.memory.MemoryDatabase` (development and
tests) and, later, the Postgres adapter. Nothing above this layer imports either.

Everything is a coroutine because the Postgres adapter is asynchronous, and the
service layer must not care which adapter it holds. The one non-coroutine is
`Database.transaction()`, which *returns* an async context manager — so call
sites read `async with db.transaction() as uow:`.

Semantics every adapter must provide
------------------------------------
- **User scoping.** Every user-scoped lookup is `(user_id, id)`; a repository
  never returns another user's rows, so a foreign id is indistinguishable from
  a missing one.
- **Explicit writes.** Reading an entity never writes. Mutations are declared
  with `save()` / `add()` / `delete()`, and `commit()` is the durability point.
  `add()` persists the values it is given, so a row must be finished *before*
  it is added: mutating it afterwards needs a `save()`, or a real database will
  never see the change (the in-memory adapter shares the instance and hides it).
- **Aggregate boundaries.** A `Job` is loaded and saved together with its
  `ChunkRecord` list. Chunks are append-only: a superseded take is marked
  `deprecated`, never deleted. The canonical source text lives in its own
  `job_sources` row and is not part of the aggregate.
- **Identity within a transaction.** Repeated reads of the same row in one
  transaction return the same object, so a service can mutate it in place and
  save it at the end.
- **Rollback.** An exception inside `transaction()` must leave no structural
  change behind (added rows are gone, deleted rows are back). Neither adapter
  snapshots in-place attribute edits; code that must be atomic validates before
  mutating, which is the pattern the services already follow.
- **Numbers are IEEE-754 doubles** (`double precision`) end to end. Instants are
  epoch-second floats in the domain and `timestamptz` in Postgres; the adapter is
  the only place that converts (see `app.core.time`).
- **JSONB integer keys.** `Job.active_chunk_version` and `JobProgress.heard`
  have `int` keys in the domain; Postgres JSONB keys are strings, so the adapter
  converts in both directions.

Scope
-----
A repository method prefixed `get_any` / `*_all` is **system scope**: it sees
every user's rows and exists for the scheduler, which owns one GPU for the whole
machine. No request handler may reach one.
"""

from __future__ import annotations

from collections.abc import Iterable
from types import TracebackType
from typing import Protocol, runtime_checkable

from app.db.models import Session, User
from app.jobs.models import ChunkRecord, Job, JobSummary
from app.library.models import Folder, JobProgress, TrashEntry


@runtime_checkable
class UserRepository(Protocol):
    async def add(self, user: User) -> None: ...

    async def save(self, user: User) -> None:
        """Persist an already-loaded user row (SQL `UPDATE`)."""

    async def get(self, user_id: str) -> User | None: ...

    async def get_by_username(self, username: str) -> User | None: ...

    async def list(self) -> list[User]: ...


@runtime_checkable
class SessionRepository(Protocol):
    async def add(self, session: Session) -> None: ...

    async def save(self, session: Session) -> None: ...

    async def get_by_token_hash(self, token_hash: bytes) -> Session | None: ...

    async def delete(self, session_id: str) -> None: ...

    async def delete_for_user(self, user_id: str) -> None: ...

    async def list_for_user(self, user_id: str) -> list[Session]: ...


@runtime_checkable
class FolderRepository(Protocol):
    async def add(self, folder: Folder) -> None: ...

    async def save(self, folder: Folder) -> None: ...

    async def get(
        self, user_id: str, folder_id: str, *, include_deleted: bool = False
    ) -> Folder | None: ...

    async def list(self, user_id: str, *, include_deleted: bool = False) -> list[Folder]: ...

    async def delete(self, user_id: str, folder_id: str) -> None: ...

    async def next_position(self, user_id: str, parent_id: str | None) -> int:
        """Next append position among the folder's live children."""
        ...


@runtime_checkable
class JobRepository(Protocol):
    # ── user scope ──────────────────────────────────────────────────────────

    async def add(self, job: Job, *, source_text: str) -> None:
        """Insert a new job aggregate: row, source text and chunks."""

    async def save(self, job: Job) -> None:
        """Persist the job aggregate (row + changed chunks)."""

    async def get(
        self, user_id: str, job_id: str, *, include_deleted: bool = False
    ) -> Job | None: ...

    async def list(self, user_id: str, *, include_deleted: bool = False) -> list[Job]: ...

    async def summaries(self, user_id: str, *, include_deleted: bool = False) -> list[JobSummary]:
        """One row per job, without chunks or source text."""
        ...

    async def source_text(self, user_id: str, job_id: str) -> str:
        """The canonical source text, ownership checked."""
        ...

    async def delete(self, user_id: str, job_id: str) -> None: ...

    async def next_position(self, user_id: str, folder_id: str | None) -> int:
        """Next append position among the folder's live job children."""
        ...

    # ── system scope (scheduler only; never reachable from a handler) ───────

    async def summaries_all(self, *, include_deleted: bool = False) -> list[JobSummary]: ...

    async def get_any(self, job_id: str, *, include_deleted: bool = False) -> Job | None: ...

    async def planned_chunks(self) -> list[ChunkRecord]:
        """Dispatchable chunks across every job, current takes only.

        Superseded takes, stale plan generations, trashed jobs and paused jobs
        are excluded, because the scheduler can never act on them.
        """
        ...

    async def rendering_chunks(self) -> list[ChunkRecord]:
        """In-flight chunks across every job (the active batch)."""
        ...

    async def source_text_any(self, job_id: str) -> str:
        """Source text without an ownership check (scheduler planning only)."""
        ...


@runtime_checkable
class JobSourceRepository(Protocol):
    async def get(self, job_id: str) -> str | None: ...

    async def put(self, job_id: str, text: str) -> None: ...


@runtime_checkable
class ProgressRepository(Protocol):
    async def add(self, progress: JobProgress) -> None: ...

    async def get(self, user_id: str, job_id: str) -> JobProgress | None: ...

    async def list(self, user_id: str) -> list[JobProgress]: ...

    async def save(self, progress: JobProgress) -> None: ...

    async def delete(self, user_id: str, job_id: str) -> None: ...

    async def delete_many(self, user_id: str, job_ids: Iterable[str]) -> None: ...


@runtime_checkable
class TrashRepository(Protocol):
    async def add(self, entry: TrashEntry) -> None: ...

    async def get(self, user_id: str, entry_id: str) -> TrashEntry | None: ...

    async def list(self, user_id: str) -> list[TrashEntry]: ...

    async def delete(self, user_id: str, entry_id: str) -> None: ...


@runtime_checkable
class UnitOfWork(Protocol):
    """One transaction's view of the database."""

    users: UserRepository
    sessions: SessionRepository
    folders: FolderRepository
    jobs: JobRepository
    sources: JobSourceRepository
    progress: ProgressRepository
    trash: TrashRepository

    async def commit(self) -> None: ...

    async def rollback(self) -> None: ...

    async def __aenter__(self) -> UnitOfWork: ...

    async def __aexit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        tb: TracebackType | None,
    ) -> None:
        """Commit on success, roll back on an exception. Never suppresses it."""


@runtime_checkable
class Database(Protocol):
    def transaction(self) -> UnitOfWork:
        """Open a unit of work. Used as `with database.transaction() as uow:`."""
        ...

    async def get_user(self, user_id: str) -> User | None:
        """Read a user outside a transaction.

        Identity lookup is not part of any business write, so it stays a plain
        method instead of forcing every request dependency to open a unit of
        work just to resolve the caller.
        """
        ...

    async def get_user_by_username(self, username: str) -> User | None: ...

    async def close(self) -> None: ...


__all__ = [
    "Database",
    "FolderRepository",
    "JobRepository",
    "JobSourceRepository",
    "ProgressRepository",
    "SessionRepository",
    "TrashRepository",
    "UnitOfWork",
    "UserRepository",
]
