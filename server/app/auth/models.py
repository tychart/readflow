"""Auth-layer value types.

`Session` itself (the row) lives in `app.db.models`, because storage owns the row
and must not import the auth rules. Everything here is the *rules*: what a
resolved session is, and the three failures the API has to translate into status
codes.
"""

from __future__ import annotations

from dataclasses import dataclass

from app.db.models import Session, User


@dataclass(frozen=True, slots=True)
class CurrentSession:
    """A validated session: the row that authenticated the request, and its user."""

    session: Session
    user: User


class AuthError(Exception):
    """Authentication failed. The message is deliberately generic."""


class SetupAlreadyCompleteError(Exception):
    """`/api/auth/setup` was called after the first user existed."""


__all__ = ["AuthError", "CurrentSession", "SetupAlreadyCompleteError"]
