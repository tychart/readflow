"""Per-user create-job defaults.

The model/voice a user picked when they last created a job is remembered so the
create-job form opens with their own choice instead of the global default. It
lives on the user row (`app.db.models.User`) because that is where a SQL adapter
will keep profile data; nothing here is scheduling state.
"""

from __future__ import annotations

from dataclasses import dataclass

from app.core.identity import DEFAULT_USER_ID
from app.db.protocols import Database


@dataclass(frozen=True, slots=True)
class UserPreferences:
    """Remembered create-job selections. `None` means "never chosen"."""

    model_id: str | None = None
    voice_id: str | None = None


class UserPreferencesService:
    """Reads and writes the one user's remembered create-job selection."""

    def __init__(self, database: Database, *, user_id: str = DEFAULT_USER_ID) -> None:
        self._db = database
        self._user_id = user_id

    def get(self) -> UserPreferences:
        with self._db.transaction() as uow:
            user = uow.users.get(self._user_id)
            if user is None:  # pragma: no cover - the adapter seeds it
                raise KeyError(f"Unknown user '{self._user_id}'")
            return UserPreferences(
                model_id=user.preferred_model_id,
                voice_id=user.preferred_voice_id,
            )

    def remember(self, *, model_id: str, voice_id: str) -> UserPreferences:
        """Store the selection the user just made.

        Callers validate the ids (supported model, known voice) before calling:
        this service stores profile data, it does not own the catalogues.
        """
        with self._db.transaction() as uow:
            user = uow.users.get(self._user_id)
            if user is None:  # pragma: no cover - the adapter seeds it
                raise KeyError(f"Unknown user '{self._user_id}'")
            user.preferred_model_id = model_id
            user.preferred_voice_id = voice_id
            uow.users.save(user)
        return UserPreferences(model_id=model_id, voice_id=voice_id)
