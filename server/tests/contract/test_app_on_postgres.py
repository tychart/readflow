"""The whole service graph on Postgres.

The adapter contract proves the repositories behave. This proves the *app* works
through them: a job is created, planned, rendered, listened to and listed with a
real database underneath, so a missing FK, a precision loss or a JSONB key
conversion shows up here rather than in production.
"""

from __future__ import annotations

import os
from pathlib import Path

import pytest
from sqlalchemy import text

from app.chunking.planner import ChunkPlan
from app.core.config import RuntimeConfig, Settings
from app.core.identity import DEFAULT_USER_ID
from app.core.services import build_services
from app.core.user_services import build_user_services
from app.db.models import User
from app.db.postgres import PostgresDatabase
from app.jobs.manager import JobManager
from app.jobs.models import JobStatus
from app.library.models import Folder

DATABASE_URL = os.getenv("READFLOW_TEST_DATABASE_URL")
SERVER_DIR = Path(__file__).resolve().parents[2]

pytestmark = pytest.mark.skipif(DATABASE_URL is None, reason="needs READFLOW_TEST_DATABASE_URL")


async def _fresh_database() -> PostgresDatabase:
    assert DATABASE_URL is not None
    database = PostgresDatabase(DATABASE_URL, pool_size=2, max_overflow=0)
    async with database.engine.begin() as connection:
        await connection.execute(
            text(
                "TRUNCATE users, sessions, folders, jobs, job_sources, chunks, "
                "job_progress, trash_entries RESTART IDENTITY CASCADE"
            )
        )
    async with database.transaction() as uow:
        await uow.users.add(User(id=DEFAULT_USER_ID, username="local", display_name="Local user"))
    return database


async def test_a_job_round_trips_through_the_whole_service_graph() -> None:
    database = await _fresh_database()
    try:
        settings = Settings(
            tts_provider="fake",
            scheduler_autostart=False,
            temp_dir_name="readflow-pg-smoke",
            runtime=RuntimeConfig(default_voice_id="suzy"),
        )
        services = await build_services(settings, SERVER_DIR, database=database)
        async with database.transaction() as uow:
            user = await uow.users.get(DEFAULT_USER_ID)
        assert user is not None
        scope = build_user_services(services, user)

        folder = await scope.library.create_folder("Books")
        job = await scope.jobs.create_job(
            source_text="One sentence. Two sentences. Three sentences.",
            source_kind="text",
            model_id=settings.runtime.default_model_id,
            voice_id="suzy",
            folder_id=folder.id,
            title="Postgres job",
        )
        expected_text = "One sentence. Two sentences. Three sentences."
        assert job.source_char_count == len(expected_text)
        assert await scope.jobs.source_text(job.id) == expected_text

        chunk = await scope.jobs.add_planned_chunk(
            job.id, ChunkPlan(text="One sentence.", char_start=0, char_end=13)
        )
        await scope.jobs.mark_chunk_written(
            chunk,
            duration_seconds=3.5,
            segment_path="/tmp/pg-0.m4s",
            wav_path="/tmp/pg-0.wav",
        )
        await scope.jobs.finish_planning(job.id)

        updated, progress = await scope.progress.record(
            job.id, position_seconds=2.5, is_playing=True, heard_chunk_indexes=[0]
        )
        assert updated.status == JobStatus.COMPLETED
        assert progress.heard == {0: 0}
        assert progress.heard_seconds == pytest.approx(3.5)

        # Everything the reader and the library need, read back from Postgres.
        detail = await scope.jobs.get_job(job.id)
        assert detail.total_chunks_completed == 1
        assert detail.written_seconds == pytest.approx(3.5)
        assert detail.chunks[0].segment_path == "/tmp/pg-0.m4s"
        assert detail.active_chunk_version == {0: 0}

        summaries = await scope.jobs.summaries()
        assert [summary.id for summary in summaries] == [job.id]
        assert summaries[0].written_seconds == pytest.approx(3.5)

        snapshot = await scope.library.snapshot()
        assert [folder.id for folder in snapshot.folders] == [folder.id]
        view = await scope.progress.view(summaries[0])
        assert view.read_status == "read"
        assert view.position_seconds == pytest.approx(2.5)

        # A restart of the service graph must see the same rows.
        await build_services(settings, SERVER_DIR, database=database)
        # Per-user scope, exactly what a request would build.
        restarted_jobs = JobManager(database, user_id=DEFAULT_USER_ID)
        reloaded = await restarted_jobs.get_job(job.id)
        assert reloaded.title == "Postgres job"
        assert reloaded.total_chunks_completed == 1
        assert await restarted_jobs.source_text(job.id) == (
            "One sentence. Two sentences. Three sentences."
        )
    finally:
        await database.close()


async def test_folder_ordering_survives_the_round_trip() -> None:
    database = await _fresh_database()
    try:
        settings = Settings(
            tts_provider="fake",
            scheduler_autostart=False,
            temp_dir_name="readflow-pg-order",
            runtime=RuntimeConfig(default_voice_id="suzy"),
        )
        services = await build_services(settings, SERVER_DIR, database=database)
        async with database.transaction() as uow:
            user = await uow.users.get(DEFAULT_USER_ID)
        assert user is not None
        scope = build_user_services(services, user)
        folder = await scope.library.create_folder("Books")
        assert isinstance(folder, Folder)
        job = await scope.jobs.create_job(
            source_text="A short job.",
            source_kind="text",
            model_id=settings.runtime.default_model_id,
            voice_id="suzy",
            folder_id=folder.id,
        )
        async with database.transaction() as uow:
            assert (await uow.jobs.next_position(DEFAULT_USER_ID, folder.id)) == 1
            assert (await uow.jobs.next_position(DEFAULT_USER_ID, None)) == 0
            assert (await uow.folders.next_position(DEFAULT_USER_ID, None)) == 1
            assert (await uow.folders.next_position(DEFAULT_USER_ID, folder.id)) == 0
        assert job.position == 0
    finally:
        await database.close()
