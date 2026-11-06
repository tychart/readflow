"""Persistence entities that are not part of the scheduling domain.

`Job` and `ChunkRecord` stay in `app.jobs.models`: they are the scheduler's
working objects and the storage layer persists them as-is. Everything here is
data that only exists to be stored and queried.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from time import time

from app.core.identity import DEFAULT_USER_DISPLAY_NAME, DEFAULT_USER_ID


@dataclass(slots=True)
class User:
    """An owner of jobs and (later) folders, read state and trash.

    There is exactly one real user today (`DEFAULT_USER_ID`) because the app has
    no authentication yet, but every other row already carries a `user_id`, so
    adding accounts is a data-population and API change rather than a schema
    change.
    """

    id: str = DEFAULT_USER_ID
    display_name: str = DEFAULT_USER_DISPLAY_NAME
    created_at: float = field(default_factory=time)
    # Last model/voice picked in the create-job form, so the form can open with
    # the user's own choice instead of the global default. `None` means "never
    # chosen" and the form falls back to the resident (GPU) choice.
    preferred_model_id: str | None = None
    preferred_voice_id: str | None = None
