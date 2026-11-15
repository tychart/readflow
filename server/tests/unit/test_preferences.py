"""Per-user create-job defaults (the remembered model/voice)."""

from __future__ import annotations

from app.db.memory import MemoryDatabase
from app.db.models import User
from app.users.preferences import UserPreferences, UserPreferencesService


def _service(database: MemoryDatabase, user_id: str = "local") -> UserPreferencesService:
    return UserPreferencesService(database, user_id=user_id)


async def test_no_preference_until_the_user_chooses() -> None:
    """The create form falls back to the resident choice on a fresh install."""
    service = _service(MemoryDatabase())

    assert await service.get() == UserPreferences(model_id=None, voice_id=None)


async def test_remember_persists_the_selection() -> None:
    database = MemoryDatabase()
    service = _service(database)

    remembered = await service.remember(model_id="Qwen/Qwen3-TTS-12Hz-1.7B-Base", voice_id="howard")

    assert remembered == UserPreferences(
        model_id="Qwen/Qwen3-TTS-12Hz-1.7B-Base", voice_id="howard"
    )
    # A fresh service over the same database reads it back: it is stored on the
    # user row, not held in this instance.
    assert (await _service(database).get()) == remembered


async def test_remember_overwrites_the_previous_choice() -> None:
    service = _service(MemoryDatabase())
    await service.remember(model_id="Qwen/Qwen3-TTS-12Hz-0.6B-Base", voice_id="suzy")

    await service.remember(model_id="Qwen/Qwen3-TTS-12Hz-1.7B-Base", voice_id="howard")

    assert await service.get() == UserPreferences(
        model_id="Qwen/Qwen3-TTS-12Hz-1.7B-Base", voice_id="howard"
    )


async def test_preferences_are_per_user() -> None:
    database = MemoryDatabase()
    async with database.transaction() as uow:
        await uow.users.add(User(id="someone-else", display_name="Someone else"))

    await _service(database).remember(model_id="Qwen/Qwen3-TTS-12Hz-1.7B-Base", voice_id="howard")

    assert (await _service(database, user_id="someone-else").get()) == UserPreferences(
        model_id=None, voice_id=None
    )
