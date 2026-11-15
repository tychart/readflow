"""Postgres storage adapter (SQLAlchemy Core, no ORM entities)."""

from __future__ import annotations

from app.db.postgres.database import PostgresDatabase, PostgresUnitOfWork

__all__ = ["PostgresDatabase", "PostgresUnitOfWork"]
