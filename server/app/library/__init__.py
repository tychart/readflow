"""Library domain: folders, ordering, listening progress and trash.

`app.library.tree`, `app.library.progress` and `app.library.playback` are pure
and unit-tested. `app.library.service` is the command surface over the storage
seam (`app.db`). The API layer only translates HTTP <-> these calls.
"""

from __future__ import annotations

from app.library.models import Folder, JobProgress, TrashEntry, TrashKind
from app.library.progress import ProgressView, progress_view
from app.library.tree import LibraryError, LibraryItem

__all__ = [
    "Folder",
    "JobProgress",
    "LibraryError",
    "LibraryItem",
    "ProgressView",
    "TrashEntry",
    "TrashKind",
    "progress_view",
]
