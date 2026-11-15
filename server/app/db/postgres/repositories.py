"""Repositories backed by Postgres (SQLAlchemy Core, no ORM).

Every method here is a thin translation between the domain objects and one or
two statements. Two pieces of state make that safe and cheap:

- **An identity map per unit of work.** `Job` is mutable and services mutate it
  in place, so a repeated `get` inside one transaction must hand back the same
  object — otherwise a second read would silently discard the first's edits.
- **A chunk snapshot per loaded job.** A job's chunks are append-only, so `save`
  diffs the mutable fields and only writes the rows that moved. Without the
  snapshot every save would rewrite a whole book's chunk table.

Nothing here decides policy (ownership is checked, but ordering, trash and
progress rules live in the services).
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping, Sequence
from typing import Any, cast

import sqlalchemy as sa
from sqlalchemy.engine import CursorResult
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import schema
from app.db.models import Session, User
from app.db.postgres.mapping import (
    ChunkKey,
    changed_chunks,
    chunk_from_row,
    chunk_row,
    chunk_snapshots,
    folder_from_row,
    folder_row,
    job_from_row,
    job_row,
    job_summary_from_row,
    progress_from_row,
    progress_row,
    session_from_row,
    session_row,
    trash_from_row,
    trash_row,
    user_from_row,
    user_row,
)
from app.jobs.models import ChunkRecord, ChunkStatus, Job, JobStatus, JobSummary
from app.library.models import Folder, JobProgress, TrashEntry


def _rows(result: Any) -> list[Mapping[str, Any]]:
    return list(result.mappings())


class PostgresUserRepository:
    def __init__(self, session: AsyncSession) -> None:
        self._session = session

    async def add(self, user: User) -> None:
        await self._session.execute(sa.insert(schema.users).values(**user_row(user)))

    async def save(self, user: User) -> None:
        values = user_row(user)
        user_id = values.pop("id")
        await self._session.execute(
            sa.update(schema.users).where(schema.users.c.id == user_id).values(**values)
        )

    async def get(self, user_id: str) -> User | None:
        result = await self._session.execute(
            sa.select(schema.users).where(schema.users.c.id == user_id)
        )
        rows = _rows(result)
        return user_from_row(rows[0]) if rows else None

    async def get_by_username(self, username: str) -> User | None:
        result = await self._session.execute(
            sa.select(schema.users).where(
                sa.func.lower(schema.users.c.username) == username.strip().lower()
            )
        )
        rows = _rows(result)
        return user_from_row(rows[0]) if rows else None

    async def list(self) -> list[User]:
        result = await self._session.execute(
            sa.select(schema.users).order_by(schema.users.c.created_at)
        )
        return [user_from_row(row) for row in _rows(result)]


class PostgresSessionRepository:
    def __init__(self, session: AsyncSession) -> None:
        self._session = session

    async def add(self, session: Session) -> None:
        await self._session.execute(sa.insert(schema.sessions).values(**session_row(session)))

    async def save(self, session: Session) -> None:
        values = session_row(session)
        session_id = values.pop("id")
        await self._session.execute(
            sa.update(schema.sessions).where(schema.sessions.c.id == session_id).values(**values)
        )

    async def get_by_token_hash(self, token_hash: bytes) -> Session | None:
        result = await self._session.execute(
            sa.select(schema.sessions).where(schema.sessions.c.token_hash == token_hash)
        )
        rows = _rows(result)
        return session_from_row(rows[0]) if rows else None

    async def delete(self, session_id: str) -> None:
        await self._session.execute(
            sa.delete(schema.sessions).where(schema.sessions.c.id == session_id)
        )

    async def delete_for_user(self, user_id: str) -> None:
        await self._session.execute(
            sa.delete(schema.sessions).where(schema.sessions.c.user_id == user_id)
        )

    async def list_for_user(self, user_id: str) -> list[Session]:
        result = await self._session.execute(
            sa.select(schema.sessions)
            .where(schema.sessions.c.user_id == user_id)
            .order_by(schema.sessions.c.created_at)
        )
        return [session_from_row(row) for row in _rows(result)]


class PostgresFolderRepository:
    def __init__(self, session: AsyncSession) -> None:
        self._session = session

    async def add(self, folder: Folder) -> None:
        await self._session.execute(sa.insert(schema.folders).values(**folder_row(folder)))

    async def save(self, folder: Folder) -> None:
        values = folder_row(folder)
        folder_id = values.pop("id")
        await self._session.execute(
            sa.update(schema.folders).where(schema.folders.c.id == folder_id).values(**values)
        )

    async def get(
        self, user_id: str, folder_id: str, *, include_deleted: bool = False
    ) -> Folder | None:
        query = sa.select(schema.folders).where(
            schema.folders.c.id == folder_id, schema.folders.c.user_id == user_id
        )
        if not include_deleted:
            query = query.where(schema.folders.c.deleted_at.is_(None))
        rows = _rows(await self._session.execute(query))
        return folder_from_row(rows[0]) if rows else None

    async def list(self, user_id: str, *, include_deleted: bool = False) -> list[Folder]:
        query = sa.select(schema.folders).where(schema.folders.c.user_id == user_id)
        if not include_deleted:
            query = query.where(schema.folders.c.deleted_at.is_(None))
        rows = _rows(await self._session.execute(query.order_by(schema.folders.c.position)))
        return [folder_from_row(row) for row in rows]

    async def delete(self, user_id: str, folder_id: str) -> None:
        await self._session.execute(
            sa.delete(schema.folders).where(
                schema.folders.c.id == folder_id, schema.folders.c.user_id == user_id
            )
        )

    async def next_position(self, user_id: str, parent_id: str | None) -> int:
        query = sa.select(sa.func.max(schema.folders.c.position)).where(
            schema.folders.c.user_id == user_id,
            schema.folders.c.deleted_at.is_(None),
        )
        query = query.where(
            schema.folders.c.parent_id.is_(None)
            if parent_id is None
            else schema.folders.c.parent_id == parent_id
        )
        highest = (await self._session.execute(query)).scalar()
        return int(highest) + 1 if highest is not None else 0


class PostgresJobSourceRepository:
    def __init__(self, session: AsyncSession) -> None:
        self._session = session

    async def get(self, job_id: str) -> str | None:
        result = await self._session.execute(
            sa.select(schema.job_sources.c.text).where(schema.job_sources.c.job_id == job_id)
        )
        return result.scalar()

    async def put(self, job_id: str, text: str) -> None:
        await self._session.execute(
            sa.delete(schema.job_sources).where(schema.job_sources.c.job_id == job_id)
        )
        await self._session.execute(sa.insert(schema.job_sources).values(job_id=job_id, text=text))

    async def delete(self, job_id: str) -> None:
        await self._session.execute(
            sa.delete(schema.job_sources).where(schema.job_sources.c.job_id == job_id)
        )


class PostgresJobRepository:
    def __init__(
        self,
        session: AsyncSession,
        *,
        identity_map: dict[str, Job],
        snapshots: dict[str, dict[ChunkKey, tuple[Any, ...]]],
    ) -> None:
        self._session = session
        self._identity = identity_map
        self._snapshots = snapshots

    # ── loading ─────────────────────────────────────────────────────────────

    async def _load(self, job_id: str, *, include_deleted: bool) -> Job | None:
        cached = self._identity.get(job_id)
        if cached is not None:
            if cached.deleted_at is not None and not include_deleted:
                return None
            return cached
        query = sa.select(schema.jobs).where(schema.jobs.c.id == job_id)
        if not include_deleted:
            query = query.where(schema.jobs.c.deleted_at.is_(None))
        rows = _rows(await self._session.execute(query))
        if not rows:
            return None
        job = job_from_row(rows[0], await self._chunks_for([job_id]))
        self._identity[job_id] = job
        self._snapshots[job_id] = chunk_snapshots(job.chunks)
        return job

    async def _chunks_for(self, job_ids: Sequence[str]) -> list[ChunkRecord]:
        if not job_ids:
            return []
        result = await self._session.execute(
            sa.select(schema.chunks)
            .where(schema.chunks.c.job_id.in_(job_ids))
            .order_by(schema.chunks.c.index, schema.chunks.c.version)
        )
        return [chunk_from_row(row) for row in _rows(result)]

    async def _load_many(self, query: Any) -> list[Job]:
        job_rows = _rows(await self._session.execute(query))
        chunks_by_job: dict[str, list[ChunkRecord]] = {}
        for chunk in await self._chunks_for([row["id"] for row in job_rows]):
            chunks_by_job.setdefault(chunk.job_id, []).append(chunk)
        jobs: list[Job] = []
        for row in job_rows:
            job = job_from_row(row, chunks_by_job.get(row["id"], []))
            self._identity[job.id] = job
            self._snapshots[job.id] = chunk_snapshots(job.chunks)
            jobs.append(job)
        return jobs

    # ── writes ──────────────────────────────────────────────────────────────

    async def add(self, job: Job, *, source_text: str) -> None:
        await self._session.execute(sa.insert(schema.jobs).values(**job_row(job)))
        await self._session.execute(
            sa.insert(schema.job_sources).values(job_id=job.id, text=source_text)
        )
        if job.chunks:
            await self._session.execute(
                sa.insert(schema.chunks), [chunk_row(chunk) for chunk in job.chunks]
            )
        self._identity[job.id] = job
        self._snapshots[job.id] = chunk_snapshots(job.chunks)

    async def save(self, job: Job) -> None:
        values = job_row(job)
        job_id = values.pop("id")
        result = cast(
            CursorResult[Any],
            await self._session.execute(
                sa.update(schema.jobs).where(schema.jobs.c.id == job_id).values(**values)
            ),
        )
        if result.rowcount == 0:
            # A save of a row that does not exist is a lost write, not a no-op:
            # the in-memory adapter raises KeyError here and the contract says
            # both must behave the same way.
            raise KeyError(f"Cannot save unknown job '{job_id}'")
        updates, inserts = changed_chunks(self._snapshots.get(job.id, {}), job.chunks)
        if updates:
            for chunk in updates:
                key = (
                    (schema.chunks.c.job_id == chunk.job_id)
                    & (schema.chunks.c.index == chunk.index)
                    & (schema.chunks.c.version == chunk.version)
                )
                await self._session.execute(
                    sa.update(schema.chunks).where(key).values(**chunk_row(chunk))
                )
        if inserts:
            await self._session.execute(
                sa.insert(schema.chunks), [chunk_row(chunk) for chunk in inserts]
            )
        self._identity[job.id] = job
        self._snapshots[job.id] = chunk_snapshots(job.chunks)

    # ── user-scoped reads ───────────────────────────────────────────────────

    async def get(self, user_id: str, job_id: str, *, include_deleted: bool = False) -> Job | None:
        job = await self._load(job_id, include_deleted=include_deleted)
        if job is None or job.user_id != user_id:
            # Ownership is checked at the boundary: another user's job is
            # indistinguishable from a missing one.
            return None
        return job

    async def list(self, user_id: str, *, include_deleted: bool = False) -> list[Job]:
        query = sa.select(schema.jobs).where(schema.jobs.c.user_id == user_id)
        if not include_deleted:
            query = query.where(schema.jobs.c.deleted_at.is_(None))
        return sorted(
            await self._load_many(query),
            key=lambda job: job.submitted_at,
            reverse=True,
        )

    async def summaries(self, user_id: str, *, include_deleted: bool = False) -> list[JobSummary]:
        query = sa.select(schema.jobs).where(schema.jobs.c.user_id == user_id)
        if not include_deleted:
            query = query.where(schema.jobs.c.deleted_at.is_(None))
        return [job_summary_from_row(row) for row in _rows(await self._session.execute(query))]

    async def summaries_all(self, *, include_deleted: bool = False) -> list[JobSummary]:
        query = sa.select(schema.jobs)
        if not include_deleted:
            query = query.where(schema.jobs.c.deleted_at.is_(None))
        return [job_summary_from_row(row) for row in _rows(await self._session.execute(query))]

    async def list_all(self, *, include_deleted: bool = False) -> list[Job]:
        query = sa.select(schema.jobs)
        if not include_deleted:
            query = query.where(schema.jobs.c.deleted_at.is_(None))
        return await self._load_many(query)

    async def source_text(self, user_id: str, job_id: str) -> str:
        owned = (
            await self._session.execute(
                sa.select(schema.jobs.c.id).where(
                    schema.jobs.c.id == job_id, schema.jobs.c.user_id == user_id
                )
            )
        ).scalar()
        if owned is None:
            raise KeyError(f"Unknown job '{job_id}'")
        return await self.source_text_any(job_id)

    async def source_text_any(self, job_id: str) -> str:
        text = (
            await self._session.execute(
                sa.select(schema.job_sources.c.text).where(schema.job_sources.c.job_id == job_id)
            )
        ).scalar()
        if text is None:
            raise KeyError(f"Job '{job_id}' has no source text")
        return text

    async def delete(self, user_id: str, job_id: str) -> None:
        # `chunks`, `job_sources` and `job_progress` cascade from this row.
        await self._session.execute(
            sa.delete(schema.jobs).where(
                schema.jobs.c.id == job_id, schema.jobs.c.user_id == user_id
            )
        )
        self._identity.pop(job_id, None)
        self._snapshots.pop(job_id, None)

    async def exists(self, user_id: str, job_id: str) -> bool:
        result = await self._session.execute(
            sa.select(schema.jobs.c.id).where(
                schema.jobs.c.id == job_id,
                schema.jobs.c.user_id == user_id,
                schema.jobs.c.deleted_at.is_(None),
            )
        )
        return result.scalar() is not None

    async def next_position(self, user_id: str, folder_id: str | None) -> int:
        query = sa.select(sa.func.max(schema.jobs.c.position)).where(
            schema.jobs.c.user_id == user_id,
            schema.jobs.c.deleted_at.is_(None),
        )
        query = query.where(
            schema.jobs.c.folder_id.is_(None)
            if folder_id is None
            else schema.jobs.c.folder_id == folder_id
        )
        highest = (await self._session.execute(query)).scalar()
        return int(highest) + 1 if highest is not None else 0

    # ── system-scoped reads ─────────────────────────────────────────────────

    async def get_any(self, job_id: str, *, include_deleted: bool = False) -> Job | None:
        return await self._load(job_id, include_deleted=include_deleted)

    async def _system_chunks(
        self, status: ChunkStatus, *, exclude_paused: bool
    ) -> list[ChunkRecord]:
        query = (
            sa.select(schema.chunks)
            .join(schema.jobs, schema.jobs.c.id == schema.chunks.c.job_id)
            .where(
                schema.chunks.c.status == str(status),
                schema.chunks.c.plan_version == schema.jobs.c.plan_version,
                schema.chunks.c.deprecated.is_(False),
                schema.jobs.c.deleted_at.is_(None),
            )
            .order_by(schema.chunks.c.job_id, schema.chunks.c.index)
        )
        if exclude_paused:
            query = query.where(schema.jobs.c.status != str(JobStatus.PAUSED))
        return [chunk_from_row(row) for row in _rows(await self._session.execute(query))]

    async def planned_chunks(self) -> list[ChunkRecord]:
        return await self._system_chunks(ChunkStatus.PLANNED, exclude_paused=True)

    async def rendering_chunks(self) -> list[ChunkRecord]:
        return await self._system_chunks(ChunkStatus.RENDERING, exclude_paused=False)


class PostgresProgressRepository:
    def __init__(self, session: AsyncSession) -> None:
        self._session = session

    async def add(self, progress: JobProgress) -> None:
        await self._session.execute(sa.insert(schema.job_progress).values(**progress_row(progress)))

    async def save(self, progress: JobProgress) -> None:
        values = progress_row(progress)
        await self._session.execute(
            sa.update(schema.job_progress)
            .where(
                schema.job_progress.c.user_id == progress.user_id,
                schema.job_progress.c.job_id == progress.job_id,
            )
            .values(**values)
        )

    async def get(self, user_id: str, job_id: str) -> JobProgress | None:
        result = await self._session.execute(
            sa.select(schema.job_progress).where(
                schema.job_progress.c.user_id == user_id,
                schema.job_progress.c.job_id == job_id,
            )
        )
        rows = _rows(result)
        return progress_from_row(rows[0]) if rows else None

    async def list(self, user_id: str) -> list[JobProgress]:
        result = await self._session.execute(
            sa.select(schema.job_progress).where(schema.job_progress.c.user_id == user_id)
        )
        return [progress_from_row(row) for row in _rows(result)]

    async def delete(self, user_id: str, job_id: str) -> None:
        await self._session.execute(
            sa.delete(schema.job_progress).where(
                schema.job_progress.c.user_id == user_id,
                schema.job_progress.c.job_id == job_id,
            )
        )

    async def delete_many(self, user_id: str, job_ids: Iterable[str]) -> None:
        job_ids = list(job_ids)
        if not job_ids:
            return
        await self._session.execute(
            sa.delete(schema.job_progress).where(
                schema.job_progress.c.user_id == user_id,
                schema.job_progress.c.job_id.in_(job_ids),
            )
        )


class PostgresTrashRepository:
    def __init__(self, session: AsyncSession) -> None:
        self._session = session

    async def add(self, entry: TrashEntry) -> None:
        await self._session.execute(sa.insert(schema.trash_entries).values(**trash_row(entry)))

    async def get(self, user_id: str, entry_id: str) -> TrashEntry | None:
        rows = _rows(
            await self._session.execute(
                sa.select(schema.trash_entries).where(
                    schema.trash_entries.c.id == entry_id,
                    schema.trash_entries.c.user_id == user_id,
                )
            )
        )
        return trash_from_row(rows[0]) if rows else None

    async def list(self, user_id: str) -> list[TrashEntry]:
        rows = _rows(
            await self._session.execute(
                sa.select(schema.trash_entries)
                .where(schema.trash_entries.c.user_id == user_id)
                .order_by(schema.trash_entries.c.created_at.desc())
            )
        )
        return [trash_from_row(row) for row in rows]

    async def delete(self, user_id: str, entry_id: str) -> None:
        await self._session.execute(
            sa.delete(schema.trash_entries).where(
                schema.trash_entries.c.id == entry_id,
                schema.trash_entries.c.user_id == user_id,
            )
        )
