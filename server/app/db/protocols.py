"""The storage boundary.

Everything the server would one day keep in PostgreSQL goes through these two
protocols: a `Database` that can open a transaction, and a `UnitOfWork` that
exposes one repository per entity for the duration of that transaction.

The current implementation is `app.db.memory.MemoryDatabase`. A SQL adapter is
expected to implement exactly these protocols; nothing above this layer imports
the in-memory module directly.

Semantics every adapter must provide
------------------------------------
- **User scoping.** Every job lookup is `(user_id, job_id)`; a repository never
  returns another user's rows.
- **Explicit writes.** Reading an entity never writes. Mutations are declared
  with `save()` / `add()` / `delete()`, and `commit()` is the durability point.
- **Aggregate boundaries.** A `Job` is loaded and saved together with its
  `ChunkRecord` list. The adapter decides how that is stored (one row with a
  child table, or diffed child rows).
- **Identity within a transaction.** Repeated reads of the same row in one
  transaction return the same object, so a service can mutate it in place and
  save it at the end.
- **Rollback.** An exception inside `with database.transaction()` must leave no
  structural change behind (added rows are gone, deleted rows are back). The
  in-memory adapter does not snapshot in-place attribute edits; code that must
  be atomic validates before mutating, which is the pattern the services
  already follow.
"""

from __future__ import annotations

from types import TracebackType
from typing import Protocol, runtime_checkable

from app.db.models import User
from app.jobs.models import Job


@runtime_checkable
class UserRepository(Protocol):
    def add(self, user: User) -> None: ...

    def get(self, user_id: str) -> User | None: ...

    def list(self) -> list[User]: ...


@runtime_checkable
class JobRepository(Protocol):
    def add(self, job: Job) -> None:
        """Insert a new job aggregate. Raises if the id already exists."""

    def save(self, job: Job) -> None:
        """Persist the job aggregate (row + chunks) and its current fields."""

    def get(self, user_id: str, job_id: str) -> Job | None: ...

    def list(self, user_id: str) -> list[Job]: ...

    def delete(self, user_id: str, job_id: str) -> None: ...


@runtime_checkable
class UnitOfWork(Protocol):
    """One transaction's view of the database."""

    users: UserRepository
    jobs: JobRepository

    def commit(self) -> None: ...

    def rollback(self) -> None: ...

    def __enter__(self) -> UnitOfWork: ...

    def __exit__(
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

    def get_user(self, user_id: str) -> User | None:
        """Read a user outside a transaction.

        Identity lookup is not part of any business write, so it stays a plain
        method instead of forcing every request dependency to open a unit of
        work just to resolve the caller.
        """
        ...
