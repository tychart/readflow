"""In-memory implementation of the storage boundary.

This is a real little database, not a dictionary wrapper: it has users, folders,
jobs, listening progress and trash, with explicit inserts/updates/deletes and
transactions. It is also the development and test adapter, so it behaves like
the SQL adapter we will add later:

- instances are shared (an identity map), which is what lets a service load a
  row, mutate it, and save it;
- `add` / `save` / `delete` are journaled, so an exception inside a transaction
  undoes them;
- in-place attribute edits are *not* snapshotted. Services validate before they
  mutate, and every mutation ends with `save()`, which is what a real database
  will need. Do not add a code path that relies on rolling back half-applied
  field assignments.

Writes are applied immediately (read-your-writes) instead of being staged; the
unit of work exists to give services a transaction boundary and a rollback path,
not to emulate MVCC.
"""

from __future__ import annotations

from collections.abc import Callable, Iterable

from app.core.identity import DEFAULT_USER_DISPLAY_NAME, DEFAULT_USER_ID
from app.core.time import utc_now
from app.db.models import Session, User
from app.db.protocols import (
    FolderRepository,
    JobRepository,
    JobSourceRepository,
    ProgressRepository,
    SessionRepository,
    TrashRepository,
    UnitOfWork,
    UserRepository,
)
from app.jobs.models import ChunkRecord, ChunkStatus, Job, JobStatus, JobSummary
from app.library.models import Folder, JobProgress, TrashEntry

Journal = list[Callable[[], None]]


class _RowTable[RowT]:
    """Shared insert/save/delete + undo bookkeeping for one in-memory table."""

    def __init__(
        self,
        rows: dict[object, RowT],
        journal: Journal,
        *,
        key: Callable[[RowT], object],
        label: str,
    ) -> None:
        self._rows = rows
        self._journal = journal
        self._key = key
        self._label = label

    def add(self, row: RowT) -> None:
        row_key = self._key(row)
        if row_key in self._rows:
            raise ValueError(f"{self._label} '{row_key}' already exists")
        self._rows[row_key] = row
        self._journal.append(lambda: self._drop_if(row_key, row))

    def save(self, row: RowT) -> None:
        """Persist an already-loaded row (SQL `UPDATE`)."""
        row_key = self._key(row)
        previous = self._rows.get(row_key)
        if previous is None:
            raise KeyError(f"Cannot save unknown {self._label.lower()} '{row_key}'")
        self._rows[row_key] = row
        self._journal.append(lambda: self._restore_if(row_key, row, previous))

    def delete(self, row_key: object) -> None:
        row = self._rows.pop(row_key, None)
        if row is not None:
            self._journal.append(lambda: self._restore(row_key, row))

    def get(self, row_key: object) -> RowT | None:
        return self._rows.get(row_key)

    def values(self) -> list[RowT]:
        return list(self._rows.values())

    def _restore(self, row_key: object, row: RowT) -> None:
        self._rows.setdefault(row_key, row)

    def _drop_if(self, row_key: object, row: RowT) -> None:
        if self._rows.get(row_key) is row:
            del self._rows[row_key]

    def _restore_if(self, row_key: object, replaced: RowT, previous: RowT) -> None:
        if self._rows.get(row_key) is replaced:
            self._rows[row_key] = previous


class MemoryUserRepository:
    def __init__(self, users: dict[object, User], journal: Journal) -> None:
        self._table: _RowTable[User] = _RowTable(
            users, journal, key=lambda user: user.id, label="User"
        )

    def add(self, user: User) -> None:
        self._table.add(user)

    def save(self, user: User) -> None:
        self._table.save(user)

    def get(self, user_id: str) -> User | None:
        return self._table.get(user_id)

    def get_by_username(self, username: str) -> User | None:
        # Unique in the real schema; the first match is enough here because the
        # auth service checks for a duplicate before inserting.
        wanted = username.strip().lower()
        return next(
            (user for user in self._table.values() if user.username.lower() == wanted),
            None,
        )

    def list(self) -> list[User]:
        return self._table.values()


class MemorySessionRepository:
    def __init__(self, rows: dict[object, Session], journal: Journal) -> None:
        self._table: _RowTable[Session] = _RowTable(
            rows, journal, key=lambda session: session.id, label="Session"
        )

    def add(self, session: Session) -> None:
        self._table.add(session)

    def save(self, session: Session) -> None:
        self._table.save(session)

    def get_by_token_hash(self, token_hash: bytes) -> Session | None:
        return next(
            (row for row in self._table.values() if row.token_hash == token_hash),
            None,
        )

    def delete(self, session_id: str) -> None:
        self._table.delete(session_id)

    def delete_for_user(self, user_id: str) -> None:
        for session in [row for row in self._table.values() if row.user_id == user_id]:
            self._table.delete(session.id)

    def list_for_user(self, user_id: str) -> list[Session]:
        return [row for row in self._table.values() if row.user_id == user_id]


class MemoryFolderRepository:
    def __init__(self, rows: dict[object, Folder], journal: Journal) -> None:
        self._table: _RowTable[Folder] = _RowTable(
            rows, journal, key=lambda folder: folder.id, label="Folder"
        )

    def add(self, folder: Folder) -> None:
        self._table.add(folder)

    def save(self, folder: Folder) -> None:
        self._table.save(folder)

    def get(self, user_id: str, folder_id: str, *, include_deleted: bool = False) -> Folder | None:
        folder = self._table.get(folder_id)
        if folder is None or folder.user_id != user_id:
            return None
        if folder.deleted_at is not None and not include_deleted:
            return None
        return folder

    def list(self, user_id: str, *, include_deleted: bool = False) -> list[Folder]:
        return [
            folder
            for folder in self._table.values()
            if folder.user_id == user_id and (include_deleted or folder.deleted_at is None)
        ]

    def delete(self, user_id: str, folder_id: str) -> None:
        folder = self.get(user_id, folder_id, include_deleted=True)
        if folder is not None:
            self._table.delete(folder_id)

    def next_position(self, user_id: str, parent_id: str | None) -> int:
        return (
            max(
                (folder.position for folder in self.list(user_id) if folder.parent_id == parent_id),
                default=-1,
            )
            + 1
        )


class MemoryJobSourceRepository:
    """The canonical source text, one row per job.

    Kept out of the `Job` aggregate so a list/summary read never materialises
    it. `put` is an upsert (a job's text never changes after creation, but the
    adapter should not care).
    """

    def __init__(self, rows: dict[object, str], journal: Journal) -> None:
        self._rows = rows
        self._journal = journal

    def get(self, job_id: str) -> str | None:
        return self._rows.get(job_id)

    def put(self, job_id: str, text: str) -> None:
        previous = self._rows.get(job_id)
        self._rows[job_id] = text
        self._journal.append(lambda: self._restore(job_id, previous))

    def delete(self, job_id: str) -> None:
        """Drop the row (the SQL adapter gets this from `ON DELETE CASCADE`)."""
        previous = self._rows.pop(job_id, None)
        if previous is not None:
            self._journal.append(lambda: self._rows.__setitem__(job_id, previous))

    def _restore(self, job_id: str, previous: str | None) -> None:
        if previous is None:
            self._rows.pop(job_id, None)
        else:
            self._rows[job_id] = previous


class MemoryJobRepository:
    def __init__(
        self,
        rows: dict[object, Job],
        sources: MemoryJobSourceRepository,
        journal: Journal,
    ) -> None:
        self._table: _RowTable[Job] = _RowTable(rows, journal, key=lambda job: job.id, label="Job")
        # One implementation of the source row, shared with `uow.sources`, so an
        # insert cannot write a row the source repository cannot see.
        self._sources = sources

    def add(self, job: Job, *, source_text: str) -> None:
        self._table.add(job)
        self._sources.put(job.id, source_text)

    def save(self, job: Job) -> None:
        self._table.save(job)

    def get(self, user_id: str, job_id: str, *, include_deleted: bool = False) -> Job | None:
        job = self._table.get(job_id)
        # Ownership is checked at the boundary, never by the caller. A job that
        # belongs to someone else is indistinguishable from a missing one.
        if job is None or job.user_id != user_id:
            return None
        if job.deleted_at is not None and not include_deleted:
            return None
        return job

    def get_any(self, job_id: str, *, include_deleted: bool = False) -> Job | None:
        job = self._table.get(job_id)
        if job is None or (job.deleted_at is not None and not include_deleted):
            return None
        return job

    def list(self, user_id: str, *, include_deleted: bool = False) -> list[Job]:
        return [
            job
            for job in self._table.values()
            if job.user_id == user_id and (include_deleted or job.deleted_at is None)
        ]

    def summaries(self, user_id: str, *, include_deleted: bool = False) -> list[JobSummary]:
        return [
            job.summary()
            for job in self._table.values()
            if job.user_id == user_id and (include_deleted or job.deleted_at is None)
        ]

    def summaries_all(self, *, include_deleted: bool = False) -> list[JobSummary]:
        return [
            job.summary()
            for job in self._table.values()
            if include_deleted or job.deleted_at is None
        ]

    def source_text(self, user_id: str, job_id: str) -> str:
        job = self.get(user_id, job_id, include_deleted=True)
        if job is None:
            raise KeyError(f"Unknown job '{job_id}'")
        return self.source_text_any(job_id)

    def source_text_any(self, job_id: str) -> str:
        text = self._sources.get(job_id)
        if text is None:
            raise KeyError(f"Job '{job_id}' has no source text")
        return text

    def delete(self, user_id: str, job_id: str) -> None:
        job = self.get(user_id, job_id, include_deleted=True)
        if job is not None:
            self._table.delete(job_id)
            self._sources.delete(job_id)

    def next_position(self, user_id: str, folder_id: str | None) -> int:
        return (
            max(
                (job.position for job in self.list(user_id) if job.folder_id == folder_id),
                default=-1,
            )
            + 1
        )

    def planned_chunks(self) -> list[ChunkRecord]:
        return self._system_chunks(ChunkStatus.PLANNED)

    def rendering_chunks(self) -> list[ChunkRecord]:
        return self._system_chunks(ChunkStatus.RENDERING)

    def _system_chunks(self, status: ChunkStatus) -> list[ChunkRecord]:
        """Live chunks in `status` across every job the scheduler may act on."""
        chunks: list[ChunkRecord] = []
        for job in self._table.values():
            if job.deleted_at is not None:
                continue
            if status == ChunkStatus.PLANNED and job.status == JobStatus.PAUSED:
                continue
            chunks.extend(
                chunk
                for chunk in job.chunks
                if chunk.status == status
                and chunk.plan_version == job.plan_version
                and not chunk.deprecated
            )
        return chunks


class MemoryProgressRepository:
    def __init__(self, rows: dict[object, JobProgress], journal: Journal) -> None:
        self._table: _RowTable[JobProgress] = _RowTable(
            rows,
            journal,
            key=lambda progress: (progress.user_id, progress.job_id),
            label="Job progress",
        )

    def add(self, progress: JobProgress) -> None:
        self._table.add(progress)

    def get(self, user_id: str, job_id: str) -> JobProgress | None:
        return self._table.get((user_id, job_id))

    def list(self, user_id: str) -> list[JobProgress]:
        return [progress for progress in self._table.values() if progress.user_id == user_id]

    def save(self, progress: JobProgress) -> None:
        self._table.save(progress)

    def delete(self, user_id: str, job_id: str) -> None:
        self._table.delete((user_id, job_id))

    def delete_many(self, user_id: str, job_ids: Iterable[str]) -> None:
        for job_id in job_ids:
            self.delete(user_id, job_id)


class MemoryTrashRepository:
    def __init__(self, rows: dict[object, TrashEntry], journal: Journal) -> None:
        self._table: _RowTable[TrashEntry] = _RowTable(
            rows, journal, key=lambda entry: entry.id, label="Trash entry"
        )

    def add(self, entry: TrashEntry) -> None:
        self._table.add(entry)

    def get(self, user_id: str, entry_id: str) -> TrashEntry | None:
        entry = self._table.get(entry_id)
        if entry is None or entry.user_id != user_id:
            return None
        return entry

    def list(self, user_id: str) -> list[TrashEntry]:
        return sorted(
            (entry for entry in self._table.values() if entry.user_id == user_id),
            key=lambda entry: entry.created_at,
            reverse=True,
        )

    def delete(self, user_id: str, entry_id: str) -> None:
        if self.get(user_id, entry_id) is not None:
            self._table.delete(entry_id)


class MemoryUnitOfWork:
    """A transaction over the in-memory tables."""

    def __init__(
        self,
        users: dict[object, User],
        sessions: dict[object, Session],
        folders: dict[object, Folder],
        jobs: dict[object, Job],
        sources: dict[object, str],
        progress: dict[object, JobProgress],
        trash: dict[object, TrashEntry],
    ) -> None:
        self._journal: Journal = []
        self.users: UserRepository = MemoryUserRepository(users, self._journal)
        self.sessions: SessionRepository = MemorySessionRepository(sessions, self._journal)
        self.folders: FolderRepository = MemoryFolderRepository(folders, self._journal)
        source_repository = MemoryJobSourceRepository(sources, self._journal)
        self.sources: JobSourceRepository = source_repository
        self.jobs: JobRepository = MemoryJobRepository(jobs, source_repository, self._journal)
        self.progress: ProgressRepository = MemoryProgressRepository(progress, self._journal)
        self.trash: TrashRepository = MemoryTrashRepository(trash, self._journal)
        self._closed = False

    def __enter__(self) -> MemoryUnitOfWork:
        return self

    def __exit__(self, exc_type, exc, tb) -> None:
        if exc_type is None:
            self.commit()
        else:
            self.rollback()

    def commit(self) -> None:
        if self._closed:
            return
        # Attribute edits were applied in place, so there is nothing to flush.
        self._closed = True
        self._journal.clear()

    def rollback(self) -> None:
        if self._closed:
            return
        for undo in reversed(self._journal):
            undo()
        self._journal.clear()
        self._closed = True


class MemoryDatabase:
    """The process-wide in-memory database.

    One instance is created per app process and shared by every service. It is
    seeded with the single local user so `user_id`-scoped queries work in tests
    and development without a login flow.
    """

    def __init__(self, *, seed: bool = True) -> None:
        self._users: dict[object, User] = {}
        self._sessions: dict[object, Session] = {}
        self._folders: dict[object, Folder] = {}
        self._jobs: dict[object, Job] = {}
        self._sources: dict[object, str] = {}
        self._progress: dict[object, JobProgress] = {}
        self._trash: dict[object, TrashEntry] = {}
        if seed:
            self.seed_default_user()

    def transaction(self) -> UnitOfWork:
        return MemoryUnitOfWork(
            self._users,
            self._sessions,
            self._folders,
            self._jobs,
            self._sources,
            self._progress,
            self._trash,
        )

    def get_user(self, user_id: str) -> User | None:
        return self._users.get(user_id)

    def get_user_by_username(self, username: str) -> User | None:
        wanted = username.strip().lower()
        return next(
            (user for user in self._users.values() if user.username.lower() == wanted),
            None,
        )

    def close(self) -> None:
        """Nothing to release for an in-memory database."""

    def seed_default_user(self) -> User:
        existing = self._users.get(DEFAULT_USER_ID)
        if existing is not None:
            return existing
        user = User(
            id=DEFAULT_USER_ID,
            username=DEFAULT_USER_ID,
            display_name=DEFAULT_USER_DISPLAY_NAME,
            created_at=utc_now(),
        )
        self._users[user.id] = user
        return user
