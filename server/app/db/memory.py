"""In-memory implementation of the storage boundary.

This is a real little database, not a dictionary wrapper: it has users, a
per-user job table, explicit inserts/updates/deletes, and transactions. It is
also the development and test adapter, so it behaves like the SQL adapter we
will add later:

- instances are shared (an identity map), which is what lets a service load a
  job, mutate it, and save it;
- `add` / `delete` are journaled, so an exception inside a transaction undoes
  them;
- in-place attribute edits are *not* snapshotted. Services validate before they
  mutate (the existing code already does), and every mutation ends with
  `save()`, which is what a real database will need. Do not add a code path
  that relies on rolling back half-applied field assignments.
"""

from __future__ import annotations

from collections.abc import Callable
from time import time

from app.core.identity import DEFAULT_USER_DISPLAY_NAME, DEFAULT_USER_ID
from app.db.models import User
from app.db.protocols import JobRepository, UnitOfWork, UserRepository
from app.jobs.models import Job


class MemoryUserRepository:
    def __init__(self, users: dict[str, User], journal: list[Callable[[], None]]) -> None:
        self._users = users
        self._journal = journal

    def add(self, user: User) -> None:
        if user.id in self._users:
            raise ValueError(f"User '{user.id}' already exists")
        self._users[user.id] = user
        self._journal.append(lambda: self._drop_user(user.id))

    def get(self, user_id: str) -> User | None:
        return self._users.get(user_id)

    def list(self) -> list[User]:
        return list(self._users.values())

    def _drop_user(self, user_id: str) -> None:
        self._users.pop(user_id, None)


class MemoryJobRepository:
    def __init__(self, jobs: dict[str, Job], journal: list[Callable[[], None]]) -> None:
        self._jobs = jobs
        self._journal = journal

    def add(self, job: Job) -> None:
        if job.id in self._jobs:
            raise ValueError(f"Job '{job.id}' already exists")
        self._jobs[job.id] = job
        self._journal.append(lambda: self._drop_if(job.id, job))

    def save(self, job: Job) -> None:
        """Persist an already-loaded aggregate (SQL `UPDATE`)."""
        previous = self._jobs.get(job.id)
        if previous is None:
            raise KeyError(f"Cannot save unknown job '{job.id}'; use add() for inserts")
        self._jobs[job.id] = job
        self._journal.append(lambda: self._restore_if(job.id, job, previous))

    def get(self, user_id: str, job_id: str) -> Job | None:
        job = self._jobs.get(job_id)
        # Ownership is checked at the boundary, never by the caller. A job that
        # belongs to someone else is indistinguishable from a missing one.
        if job is None or job.user_id != user_id:
            return None
        return job

    def list(self, user_id: str) -> list[Job]:
        return [job for job in self._jobs.values() if job.user_id == user_id]

    def delete(self, user_id: str, job_id: str) -> None:
        job = self.get(user_id, job_id)
        if job is None:
            return
        del self._jobs[job_id]
        self._journal.append(lambda: self._restore(job_id, job))

    def _restore(self, job_id: str, job: Job) -> None:
        self._jobs.setdefault(job_id, job)

    def _drop_if(self, job_id: str, job: Job) -> None:
        """Remove a row only if the undo still owns it.

        An unconditional pop would also delete a row that a later operation in
        the same transaction replaced (add → delete → rollback restored it, then
        the add's undo removed it again).
        """
        if self._jobs.get(job_id) is job:
            del self._jobs[job_id]

    def _restore_if(self, job_id: str, replaced: Job, previous: Job) -> None:
        if self._jobs.get(job_id) is replaced:
            self._jobs[job_id] = previous


class MemoryUnitOfWork:
    """A transaction over the in-memory tables."""

    def __init__(self, users: dict[str, User], jobs: dict[str, Job]) -> None:
        self._journal: list[Callable[[], None]] = []
        self.users: UserRepository = MemoryUserRepository(users, self._journal)
        self.jobs: JobRepository = MemoryJobRepository(jobs, self._journal)
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
        # Opening writes immediately also means read-your-writes works without
        # a staging layer.
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
    seeded with the single local user so `user_id`-scoped queries work before
    authentication exists.
    """

    def __init__(self, *, seed: bool = True) -> None:
        self._users: dict[str, User] = {}
        self._jobs: dict[str, Job] = {}
        if seed:
            self.seed_default_user()

    def transaction(self) -> UnitOfWork:
        return MemoryUnitOfWork(self._users, self._jobs)

    def get_user(self, user_id: str) -> User | None:
        return self._users.get(user_id)

    def seed_default_user(self) -> User:
        existing = self._users.get(DEFAULT_USER_ID)
        if existing is not None:
            return existing
        user = User(id=DEFAULT_USER_ID, display_name=DEFAULT_USER_DISPLAY_NAME, created_at=time())
        self._users[user.id] = user
        return user
