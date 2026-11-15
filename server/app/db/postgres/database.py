"""The Postgres adapter: one engine, one session per unit of work.

Three details are load-bearing:

- **`options=-c timezone=UTC` on every connection.** Postgres then stores and
  reports instants in UTC regardless of the host's zone, so `psql`, `pg_dump` and
  `pg_restore` all agree with the application.
- **A per-transaction identity map and chunk snapshot.** Services load a job,
  mutate it and save it in one transaction; the map makes the repeat read return
  the same object, and the snapshot makes the save write only changed chunks.
- **Commit on a clean exit, rollback on an exception.** `__aexit__` never
  suppresses the exception.
"""

from __future__ import annotations

from types import TracebackType
from typing import Any

from sqlalchemy import text
from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)

from app.db.models import User
from app.db.postgres.mapping import ChunkKey
from app.db.postgres.repositories import (
    PostgresFolderRepository,
    PostgresJobRepository,
    PostgresJobSourceRepository,
    PostgresProgressRepository,
    PostgresSessionRepository,
    PostgresTrashRepository,
    PostgresUserRepository,
)
from app.db.protocols import (
    FolderRepository,
    JobRepository,
    JobSourceRepository,
    ProgressRepository,
    SessionRepository,
    TrashRepository,
    UserRepository,
)
from app.jobs.models import Job


class PostgresUnitOfWork:
    """One transaction's view of the database."""

    # Declared here (and assigned in `__aenter__`) so the class structurally
    # satisfies the `UnitOfWork` protocol.
    users: UserRepository
    sessions: SessionRepository
    folders: FolderRepository
    jobs: JobRepository
    sources: JobSourceRepository
    progress: ProgressRepository
    trash: TrashRepository

    def __init__(self, session_factory: async_sessionmaker[AsyncSession]) -> None:
        self._session_factory = session_factory
        self._session: AsyncSession | None = None
        self._identity: dict[str, Job] = {}
        self._snapshots: dict[str, dict[ChunkKey, tuple[Any, ...]]] = {}

    @property
    def session(self) -> AsyncSession:
        if self._session is None:  # pragma: no cover - only outside the context
            raise RuntimeError("The unit of work is not open")
        return self._session

    async def __aenter__(self) -> PostgresUnitOfWork:
        self._session = self._session_factory()
        self.users = PostgresUserRepository(self._session)
        self.sessions = PostgresSessionRepository(self._session)
        self.folders = PostgresFolderRepository(self._session)
        self.sources = PostgresJobSourceRepository(self._session)
        self.jobs = PostgresJobRepository(
            self._session, identity_map=self._identity, snapshots=self._snapshots
        )
        self.progress = PostgresProgressRepository(self._session)
        self.trash = PostgresTrashRepository(self._session)
        return self

    async def __aexit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        tb: TracebackType | None,
    ) -> None:
        if self._session is None:
            return
        try:
            if exc_type is None:
                await self._session.commit()
            else:
                await self._session.rollback()
        finally:
            await self._session.close()
            self._session = None

    async def commit(self) -> None:
        await self.session.commit()

    async def rollback(self) -> None:
        await self.session.rollback()


class PostgresDatabase:
    """The production database adapter."""

    def __init__(
        self,
        url: str,
        *,
        pool_size: int = 5,
        max_overflow: int = 5,
        pool_pre_ping: bool = True,
        echo: bool = False,
    ) -> None:
        self._engine: AsyncEngine = create_async_engine(
            url,
            pool_size=pool_size,
            max_overflow=max_overflow,
            pool_pre_ping=pool_pre_ping,
            echo=echo,
            # UTC at the connection level: the schema stores timestamptz, so the
            # session zone decides what `psql` and `pg_dump` print.
            connect_args={"options": "-c timezone=UTC"},
        )
        self._session_factory = async_sessionmaker(self._engine, expire_on_commit=False)

    @property
    def engine(self) -> AsyncEngine:
        return self._engine

    def transaction(self) -> PostgresUnitOfWork:
        return PostgresUnitOfWork(self._session_factory)

    async def get_user(self, user_id: str) -> User | None:
        async with self.transaction() as uow:
            return await uow.users.get(user_id)

    async def get_user_by_username(self, username: str) -> User | None:
        async with self.transaction() as uow:
            return await uow.users.get_by_username(username)

    async def server_timezone(self) -> str:
        """The session timezone, asserted as UTC by the contract suite."""
        async with self._engine.connect() as connection:
            result = await connection.execute(text("SHOW TimeZone"))
            return str(result.scalar())

    async def ping(self) -> None:
        async with self._engine.connect() as connection:
            await connection.execute(text("SELECT 1"))

    async def close(self) -> None:
        await self._engine.dispose()
