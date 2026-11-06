"""Storage layer: the database seam between services and persistence.

Nothing outside this package should import `MemoryDatabase` directly; services
depend on `Database` / `UnitOfWork` (`app.db.protocols`). Swapping in a SQL
adapter is then a change in `app.core.services`.

`app.jobs.models` and `app.db.models` are the entities this layer persists.
"""

from __future__ import annotations

from app.db.memory import MemoryDatabase
from app.db.models import User
from app.db.protocols import (
    Database,
    FolderRepository,
    JobRepository,
    ProgressRepository,
    TrashRepository,
    UnitOfWork,
    UserRepository,
)

__all__ = [
    "Database",
    "FolderRepository",
    "JobRepository",
    "MemoryDatabase",
    "ProgressRepository",
    "TrashRepository",
    "UnitOfWork",
    "User",
    "UserRepository",
]
