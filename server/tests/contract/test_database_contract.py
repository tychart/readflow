"""The adapter contract: one suite, every implementation.

Anything that satisfies `app.db.protocols` must behave the same way, and the
differences that matter are invisible in ordinary service tests:

- ownership (another user's row is indistinguishable from a missing one),
- identity within a transaction (so a service can mutate in place and save),
- rollback of structural writes (and the honest limit: attribute edits are not
  rolled back, which is why services validate before mutating),
- explicit writes (a save is what persists a mutation),
- summaries that agree with the aggregates they project,
- the source text living in its own row, isolated from the aggregate,
- integer keys surviving a JSONB round trip,
- instants that stay UTC and doubles that stay doubles.

Postgres runs only when `READFLOW_TEST_DATABASE_URL` is set (CI provides one);
without it the suite still covers the in-memory adapter.
"""

from __future__ import annotations

import os
from collections.abc import AsyncIterator, Callable

import pytest
from sqlalchemy.exc import IntegrityError

from app.core.identity import DEFAULT_USER_ID
from app.core.time import to_iso
from app.db.memory import MemoryDatabase
from app.db.models import Session, User
from app.db.protocols import Database
from app.jobs.models import ChunkRecord, ChunkStatus, Job, JobStatus

POSTGRES_URL = os.getenv("READFLOW_TEST_DATABASE_URL")

MODEL = "Qwen/Qwen3-TTS-12Hz-0.6B-Base"


def _memory() -> Database:
    return MemoryDatabase()


def _postgres() -> Database:
    from app.db.postgres import PostgresDatabase

    assert POSTGRES_URL is not None
    return PostgresDatabase(POSTGRES_URL, pool_size=2, max_overflow=0)


FACTORIES: list[Callable[[], Database]] = [_memory]
if POSTGRES_URL:
    FACTORIES.append(_postgres)


@pytest.fixture(params=FACTORIES, ids=lambda factory: factory.__name__)
async def database(request: pytest.FixtureRequest) -> AsyncIterator[Database]:
    adapter = request.param()
    if POSTGRES_URL and not isinstance(adapter, MemoryDatabase):
        await _truncate(adapter)
        await _seed_users(adapter)
    yield adapter
    if POSTGRES_URL and not isinstance(adapter, MemoryDatabase):
        await _truncate(adapter)
    await adapter.close()


async def _truncate(database: Database) -> None:
    from sqlalchemy import text

    engine = getattr(database, "engine", None)
    assert engine is not None
    async with engine.begin() as connection:
        await connection.execute(
            text(
                "TRUNCATE users, sessions, folders, jobs, job_sources, chunks, "
                "job_progress, trash_entries RESTART IDENTITY CASCADE"
            )
        )


async def _seed_users(database: Database) -> None:
    async with database.transaction() as uow:
        await uow.users.add(User(id=DEFAULT_USER_ID, username="local", display_name="Local user"))
        await uow.users.add(User(id="someone-else", username="other", display_name="Someone else"))


def _job(
    job_id: str = "job-1",
    *,
    user_id: str = DEFAULT_USER_ID,
    title: str = "Job",
    folder_id: str | None = None,
    status: JobStatus = JobStatus.QUEUED,
) -> Job:
    return Job(
        id=job_id,
        title=title,
        source_kind="text",
        source_char_count=len("Hello there."),
        model_id=MODEL,
        voice_id="suzy",
        user_id=user_id,
        folder_id=folder_id,
        status=status,
    )


def _chunk(
    job_id: str,
    index: int,
    *,
    version: int = 0,
    status: ChunkStatus = ChunkStatus.PLANNED,
    text: str = "chunk text",
    duration: float = 0.0,
) -> ChunkRecord:
    chunk = ChunkRecord(
        job_id=job_id,
        index=index,
        text=text,
        voice_id="suzy",
        plan_version=1,
        char_start=index * 10,
        char_end=index * 10 + 10,
        version=version,
        status=status,
        duration_seconds=duration,
    )
    return chunk


# ── user scoping ────────────────────────────────────────────────────────────


async def test_a_foreign_users_job_is_indistinguishable_from_a_missing_one(
    database: Database,
) -> None:
    async with database.transaction() as uow:
        await uow.jobs.add(_job("theirs", user_id="someone-else"), source_text="Theirs.")

    async with database.transaction() as uow:
        assert await uow.jobs.get(DEFAULT_USER_ID, "theirs") is None
        assert await uow.jobs.get(DEFAULT_USER_ID, "never-existed") is None
        # The system scope is the only place it is visible.
        visible = await uow.jobs.get_any("theirs")
    assert visible is not None


async def test_listing_is_user_scoped(database: Database) -> None:
    async with database.transaction() as uow:
        await uow.jobs.add(_job("mine"), source_text="Mine.")
        await uow.jobs.add(_job("theirs", user_id="someone-else"), source_text="Theirs.")

    async with database.transaction() as uow:
        assert [job.id for job in await uow.jobs.list(DEFAULT_USER_ID)] == ["mine"]
        assert {summary.id for summary in await uow.jobs.summaries(DEFAULT_USER_ID)} == {"mine"}
        assert {summary.id for summary in await uow.jobs.summaries_all()} == {"mine", "theirs"}


async def test_another_users_job_cannot_be_read_as_a_source(database: Database) -> None:
    async with database.transaction() as uow:
        await uow.jobs.add(_job("theirs", user_id="someone-else"), source_text="Secret.")

    async with database.transaction() as uow:
        with pytest.raises(KeyError):
            await uow.jobs.source_text(DEFAULT_USER_ID, "theirs")
        assert await uow.jobs.source_text_any("theirs") == "Secret."


# ── identity and writes ─────────────────────────────────────────────────────


async def test_repeated_reads_in_one_transaction_return_the_same_instance(
    database: Database,
) -> None:
    async with database.transaction() as uow:
        await uow.jobs.add(_job(), source_text="Hello there.")

    async with database.transaction() as uow:
        first = await uow.jobs.get(DEFAULT_USER_ID, "job-1")
        second = await uow.jobs.get(DEFAULT_USER_ID, "job-1")
    assert first is second


async def test_a_mutation_is_only_persisted_by_save(database: Database) -> None:
    async with database.transaction() as uow:
        await uow.jobs.add(_job(), source_text="Hello there.")

    if not isinstance(database, MemoryDatabase):
        # The in-memory adapter shares instances, so an unsaved edit is visible
        # there (documented in `app.db.protocols`). A real database must not:
        # this is the difference that makes `save()` mandatory.
        async with database.transaction() as uow:
            job = await uow.jobs.get(DEFAULT_USER_ID, "job-1")
            assert job is not None
            job.title = "Renamed"
        async with database.transaction() as uow:
            stored = await uow.jobs.get(DEFAULT_USER_ID, "job-1")
        assert stored is not None
        assert stored.title == "Job"

    async with database.transaction() as uow:
        job = await uow.jobs.get(DEFAULT_USER_ID, "job-1")
        assert job is not None
        job.title = "Renamed"
        await uow.jobs.save(job)
    async with database.transaction() as uow:
        stored = await uow.jobs.get(DEFAULT_USER_ID, "job-1")
    assert stored is not None
    assert stored.title == "Renamed"


async def test_chunk_changes_are_persisted_with_the_aggregate(database: Database) -> None:
    job = _job()
    job.chunks = [_chunk("job-1", 0)]
    job.next_chunk_index = 1
    async with database.transaction() as uow:
        await uow.jobs.add(job, source_text="Hello there.")

    async with database.transaction() as uow:
        stored = await uow.jobs.get(DEFAULT_USER_ID, "job-1")
        assert stored is not None
        chunk = stored.chunks[0]
        chunk.status = ChunkStatus.WRITTEN
        chunk.duration_seconds = 4.5
        chunk.segment_path = "/tmp/0.m4s"
        chunk.wav_path = "/tmp/0.wav"
        stored.total_chunks_completed = 1
        await uow.jobs.save(stored)

    async with database.transaction() as uow:
        stored = await uow.jobs.get(DEFAULT_USER_ID, "job-1")
    assert stored is not None
    assert stored.chunks[0].status == ChunkStatus.WRITTEN
    assert stored.chunks[0].duration_seconds == 4.5
    assert stored.chunks[0].segment_path == "/tmp/0.m4s"
    assert stored.total_chunks_completed == 1


async def test_a_new_take_is_inserted_and_the_old_one_survives(database: Database) -> None:
    job = _job()
    job.chunks = [_chunk("job-1", 0, status=ChunkStatus.WRITTEN, duration=3.0)]
    job.next_chunk_index = 1
    job.active_chunk_version = {0: 0}
    async with database.transaction() as uow:
        await uow.jobs.add(job, source_text="Hello there.")

    async with database.transaction() as uow:
        stored = await uow.jobs.get(DEFAULT_USER_ID, "job-1")
        assert stored is not None
        stored.chunks.append(_chunk("job-1", 0, version=1, status=ChunkStatus.PLANNED))
        stored.chunks[0].deprecated = True
        stored.active_chunk_version[0] = 1
        await uow.jobs.save(stored)

    async with database.transaction() as uow:
        stored = await uow.jobs.get(DEFAULT_USER_ID, "job-1")
    assert stored is not None
    assert [(chunk.index, chunk.version) for chunk in stored.chunks] == [(0, 0), (0, 1)]
    assert stored.chunks[0].deprecated is True
    assert stored.active_chunk_version == {0: 1}


async def test_rollback_undoes_structural_writes(database: Database) -> None:
    async with database.transaction() as uow:
        await uow.jobs.add(_job("existing"), source_text="Existing.")

    with pytest.raises(RuntimeError):
        async with database.transaction() as uow:
            await uow.jobs.add(_job("discarded"), source_text="Discarded.")
            await uow.jobs.delete(DEFAULT_USER_ID, "existing")
            raise RuntimeError("abort")

    async with database.transaction() as uow:
        assert await uow.jobs.get(DEFAULT_USER_ID, "existing") is not None
        assert await uow.jobs.get(DEFAULT_USER_ID, "discarded") is None


async def test_adding_a_duplicate_job_id_is_rejected(database: Database) -> None:
    async with database.transaction() as uow:
        await uow.jobs.add(_job("duplicate"), source_text="One.")
    # The adapters report a duplicate differently (the in-memory table raises
    # ValueError, Postgres raises IntegrityError); what the contract requires is
    # that it is rejected, not silently merged.
    with pytest.raises((ValueError, IntegrityError)):
        async with database.transaction() as uow:
            await uow.jobs.add(_job("duplicate"), source_text="Two.")


async def test_saving_an_unknown_job_is_rejected(database: Database) -> None:
    with pytest.raises(KeyError):
        async with database.transaction() as uow:
            await uow.jobs.save(_job("never-added"))


# ── source text ─────────────────────────────────────────────────────────────


async def test_the_source_text_is_its_own_row(database: Database) -> None:
    long_text = "One sentence. " * 500
    job = _job()
    job.source_char_count = len(long_text)
    async with database.transaction() as uow:
        await uow.jobs.add(job, source_text=long_text)
        assert await uow.sources.get("job-1") == long_text
        assert await uow.jobs.source_text(DEFAULT_USER_ID, "job-1") == long_text

    # A summary carries the length, never the text.
    async with database.transaction() as uow:
        summaries = await uow.jobs.summaries(DEFAULT_USER_ID)
    assert summaries[0].source_char_count == len(long_text)


async def test_deleting_a_job_deletes_its_source_text(database: Database) -> None:
    async with database.transaction() as uow:
        await uow.jobs.add(_job(), source_text="Hello there.")

    async with database.transaction() as uow:
        await uow.jobs.delete(DEFAULT_USER_ID, "job-1")
        assert await uow.sources.get("job-1") is None


# ── summaries ───────────────────────────────────────────────────────────────


async def test_summaries_agree_with_the_aggregates(database: Database) -> None:
    job = _job()
    job.chunks = [
        _chunk("job-1", 0, status=ChunkStatus.WRITTEN, duration=4.0),
        _chunk("job-1", 1, status=ChunkStatus.PLANNED),
    ]
    job.next_chunk_index = 2
    job.active_chunk_version = {0: 0, 1: 0}
    job.recompute_derived()
    async with database.transaction() as uow:
        await uow.jobs.add(job, source_text="Hello there.")

    async with database.transaction() as uow:
        aggregate = await uow.jobs.get(DEFAULT_USER_ID, "job-1")
        summary = (await uow.jobs.summaries(DEFAULT_USER_ID))[0]
    assert aggregate is not None
    assert summary == aggregate.summary()


# ── system scope ────────────────────────────────────────────────────────────


async def test_planned_and_rendering_chunks_exclude_what_the_scheduler_cannot_use(
    database: Database,
) -> None:
    planned_job = _job("planned", status=JobStatus.QUEUED)
    planned_job.chunks = [
        _chunk("planned", 0),
        # A superseded take must never be dispatched.
        _chunk("planned", 1, version=0, status=ChunkStatus.PLANNED),
        _chunk("planned", 1, version=1, status=ChunkStatus.PLANNED),
    ]
    planned_job.chunks[1].deprecated = True  # the superseded take of index 1
    planned_job.next_chunk_index = 2
    planned_job.active_chunk_version = {0: 0, 1: 1}

    paused_job = _job("paused", status=JobStatus.PAUSED)
    paused_job.chunks = [_chunk("paused", 0)]
    paused_job.next_chunk_index = 1
    paused_job.active_chunk_version = {0: 0}

    trashed_job = _job("trashed")
    trashed_job.chunks = [_chunk("trashed", 0)]
    trashed_job.next_chunk_index = 1
    trashed_job.active_chunk_version = {0: 0}
    trashed_job.deleted_at = 1.0

    async with database.transaction() as uow:
        await uow.jobs.add(planned_job, source_text="Hello there.")
        await uow.jobs.add(paused_job, source_text="Hello there.")
        await uow.jobs.add(trashed_job, source_text="Hello there.")

    async with database.transaction() as uow:
        planned = await uow.jobs.planned_chunks()
    # The deprecated take of index 1 is excluded, the live take of index 0
    # stays, and nothing from the paused or trashed jobs appears.
    assert {(chunk.job_id, chunk.index, chunk.version) for chunk in planned} == {
        ("planned", 0, 0),
        ("planned", 1, 1),
    }


# ── JSONB keys and numeric types ────────────────────────────────────────────


async def test_integer_keys_survive_a_jsonb_round_trip(database: Database) -> None:
    job = _job()
    job.active_chunk_version = {0: 3, 17: 0}
    job.chunks = [_chunk("job-1", 0, version=3), _chunk("job-1", 17, version=0)]
    job.next_chunk_index = 18
    async with database.transaction() as uow:
        await uow.jobs.add(job, source_text="Hello there.")

    async with database.transaction() as uow:
        stored = await uow.jobs.get(DEFAULT_USER_ID, "job-1")
    assert stored is not None
    assert stored.active_chunk_version == {0: 3, 17: 0}


async def test_progress_round_trips_heard_keys_and_doubles(database: Database) -> None:
    from app.library.models import JobProgress

    async with database.transaction() as uow:
        await uow.jobs.add(_job(), source_text="Hello there.")
        await uow.progress.add(
            JobProgress(
                user_id=DEFAULT_USER_ID,
                job_id="job-1",
                position_seconds=12.345678,
                audio_epoch=2,
                heard={0: 1, 9: 0},
                heard_seconds=7.5,
            )
        )

    async with database.transaction() as uow:
        row = await uow.progress.get(DEFAULT_USER_ID, "job-1")
    assert row is not None
    assert row.heard == {0: 1, 9: 0}
    assert row.position_seconds == pytest.approx(12.345678)
    assert row.heard_seconds == pytest.approx(7.5)
    assert row.audio_epoch == 2


async def test_an_instant_round_trips_and_renders_as_utc(database: Database) -> None:
    instant = 1_763_229_851.0
    job = _job()
    job.submitted_at = instant
    job.updated_at = instant
    job.playback_state.last_event_at = instant
    async with database.transaction() as uow:
        await uow.jobs.add(job, source_text="Hello there.")

    async with database.transaction() as uow:
        stored = await uow.jobs.get(DEFAULT_USER_ID, "job-1")
    assert stored is not None
    assert to_iso(stored.submitted_at) == "2025-11-15T18:04:11Z"
    assert to_iso(stored.playback_state.last_event_at) == "2025-11-15T18:04:11Z"
    # timestamptz keeps microseconds, so the float is preserved within 1µs.
    assert abs(stored.submitted_at - instant) < 1e-6


async def test_nullable_instants_stay_null(database: Database) -> None:
    async with database.transaction() as uow:
        await uow.jobs.add(_job(), source_text="Hello there.")

    async with database.transaction() as uow:
        stored = await uow.jobs.get(DEFAULT_USER_ID, "job-1")
    assert stored is not None
    assert stored.deleted_at is None


async def test_the_postgres_session_timezone_is_utc(database: Database) -> None:
    """Instants are stored UTC regardless of the host's zone."""
    from app.db.postgres import PostgresDatabase

    if not isinstance(database, PostgresDatabase):
        pytest.skip("only a real database has a session timezone")
    assert await database.server_timezone() == "UTC"


# ── trash and folders ───────────────────────────────────────────────────────


async def test_folders_and_trash_are_user_scoped(database: Database) -> None:
    from app.library.models import Folder, TrashEntry, TrashKind

    async with database.transaction() as uow:
        await uow.folders.add(Folder(id="f1", name="Mine", user_id=DEFAULT_USER_ID))
        await uow.folders.add(Folder(id="f2", name="Theirs", user_id="someone-else"))
        await uow.trash.add(
            TrashEntry(
                id="t1",
                user_id=DEFAULT_USER_ID,
                kind=TrashKind.JOB,
                root_id="job-1",
                name="Job",
                job_count=1,
            )
        )

    async with database.transaction() as uow:
        assert await uow.folders.get(DEFAULT_USER_ID, "f2") is None
        assert [folder.id for folder in await uow.folders.list(DEFAULT_USER_ID)] == ["f1"]
        assert await uow.trash.get("someone-else", "t1") is None
        assert [entry.id for entry in await uow.trash.list(DEFAULT_USER_ID)] == ["t1"]
        assert await uow.folders.next_position(DEFAULT_USER_ID, None) == 1


async def test_sessions_are_found_by_token_hash_only(database: Database) -> None:
    token_hash = b"\x01" * 32
    async with database.transaction() as uow:
        await uow.sessions.add(
            Session(id="s1", user_id=DEFAULT_USER_ID, token_hash=token_hash, expires_at=1.0)
        )

    async with database.transaction() as uow:
        assert await uow.sessions.get_by_token_hash(token_hash) is not None
        assert await uow.sessions.get_by_token_hash(b"\x02" * 32) is None
        assert [session.id for session in await uow.sessions.list_for_user(DEFAULT_USER_ID)] == [
            "s1"
        ]
        await uow.sessions.delete_for_user(DEFAULT_USER_ID)
        assert await uow.sessions.get_by_token_hash(token_hash) is None
