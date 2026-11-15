"""Persistence entities that are not part of the scheduling domain.

`Job` and `ChunkRecord` stay in `app.jobs.models`: they are the scheduler's
working objects and the storage layer persists them as-is. Everything here is
data that only exists to be stored and queried.

No behaviour lives in this module. `Session`, in particular, is only the row:
what makes a session valid (absolute and idle expiry, rotation, revocation) is
the auth service's business, in `app/auth/`.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from app.core.identity import DEFAULT_USER_DISPLAY_NAME, DEFAULT_USER_ID
from app.core.time import utc_now


@dataclass(slots=True)
class User:
    """An owner of jobs, folders, listening progress and trash.

    `username` is the login handle and is unique across the install. The first
    user created through `/api/auth/setup` becomes the admin; every later user
    is created by an admin. Users are disabled, never deleted, so their data has
    an owner for as long as it exists.
    """

    id: str = DEFAULT_USER_ID
    username: str = DEFAULT_USER_ID
    display_name: str = DEFAULT_USER_DISPLAY_NAME
    # argon2id encoded hash (see app.auth.passwords). Never logged, never
    # returned by an API.
    password_hash: str = ""
    is_admin: bool = False
    is_active: bool = True
    created_at: float = field(default_factory=utc_now)
    # Last model/voice picked in the create-job form, so the form can open with
    # the user's own choice instead of the global default. `None` means "never
    # chosen" and the form falls back to the resident (GPU) choice.
    preferred_model_id: str | None = None
    preferred_voice_id: str | None = None


@dataclass(slots=True)
class Session:
    """One server-side login session.

    Only the SHA-256 of the presented token is stored, so a database read cannot
    be replayed as a login. `expires_at` is the absolute deadline; `last_seen_at`
    drives the idle deadline and is refreshed at most once a minute.
    """

    id: str
    user_id: str
    token_hash: bytes
    created_at: float = field(default_factory=utc_now)
    last_seen_at: float = field(default_factory=utc_now)
    expires_at: float = 0.0
