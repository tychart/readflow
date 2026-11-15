"""Migrations must match the metadata, and must be safe to re-run.

A migration that drifts from `app/db/schema.py` is invisible until someone
deploys: the adapter issues statements against the metadata, so a missing column
shows up as a runtime error in production rather than a failing build. These
tests run the real Alembic environment against a real database.
"""

from __future__ import annotations

import asyncio
import os
from pathlib import Path

import pytest
from alembic.config import Config

from alembic import command
from app.core.identity import DEFAULT_USER_ID
from app.db.models import User
from app.db.postgres import PostgresDatabase

DATABASE_URL = os.getenv("READFLOW_TEST_DATABASE_URL")
SERVER_DIR = Path(__file__).resolve().parents[2]

pytestmark = pytest.mark.skipif(DATABASE_URL is None, reason="needs READFLOW_TEST_DATABASE_URL")


def _url() -> str:
    assert DATABASE_URL is not None
    return DATABASE_URL


def _config(monkeypatch: pytest.MonkeyPatch) -> Config:
    # `env.py` reads the same settings object the app does.
    monkeypatch.setenv("READFLOW_DATABASE_URL", _url())
    config = Config(str(SERVER_DIR / "alembic.ini"))
    config.set_main_option("script_location", str(SERVER_DIR / "alembic"))
    return config


async def _truncate(database: PostgresDatabase) -> None:
    from sqlalchemy import text

    async with database.engine.begin() as connection:
        await connection.execute(
            text(
                "TRUNCATE users, sessions, folders, jobs, job_sources, chunks, "
                "job_progress, trash_entries RESTART IDENTITY CASCADE"
            )
        )


def test_upgrade_head_is_idempotent_and_matches_the_metadata(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    config = _config(monkeypatch)

    command.upgrade(config, "head")
    # Re-running an up-to-date database must be a no-op, not an error.
    command.upgrade(config, "head")
    # `check` fails when autogenerate would produce anything, i.e. when the
    # migration and `app.db.schema` disagree.
    command.check(config)


def test_data_survives_an_upgrade_run(monkeypatch: pytest.MonkeyPatch) -> None:
    """A second `upgrade head` must not touch existing rows.

    Synchronous on purpose: alembic's async environment calls `asyncio.run`
    itself, which cannot nest inside pytest-asyncio's loop.
    """
    config = _config(monkeypatch)
    command.upgrade(config, "head")

    async def seed() -> None:
        database = PostgresDatabase(_url())
        try:
            await _truncate(database)
            async with database.transaction() as uow:
                await uow.users.add(
                    User(id=DEFAULT_USER_ID, username="local", display_name="Local user")
                )
        finally:
            await database.close()

    async def read_username() -> str | None:
        database = PostgresDatabase(_url())
        try:
            async with database.transaction() as uow:
                stored = await uow.users.get(DEFAULT_USER_ID)
            return None if stored is None else stored.username
        finally:
            await database.close()

    asyncio.run(seed())
    # Each alembic command owns its own event loop; they must not be nested
    # inside one.
    command.upgrade(config, "head")
    assert asyncio.run(read_username()) == "local"


def test_the_schema_has_every_table_the_adapter_maps() -> None:
    """Every dataclass the adapter persists has a table, and vice versa."""
    from app.db import schema

    expected = {
        "users",
        "sessions",
        "folders",
        "jobs",
        "job_sources",
        "chunks",
        "job_progress",
        "trash_entries",
    }
    assert set(schema.metadata.tables) == expected
