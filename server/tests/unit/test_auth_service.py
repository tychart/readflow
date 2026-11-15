"""AuthService: setup, login, session validity and revocation.

These are the rules the whole application trusts, so they are tested against the
service rather than through HTTP: setup can only happen once, a bad password
cannot be told apart from an unknown user, a session expires on both its absolute
and idle deadlines, and disabling a user or changing a password kills the
sessions that are already open.
"""

from __future__ import annotations

import pytest

from app.auth.models import AuthError, SetupAlreadyCompleteError
from app.auth.service import LAST_SEEN_REFRESH_SECONDS, AuthService
from app.auth.throttle import LoginThrottle, RateLimitedError
from app.core.config import Settings
from app.db.memory import MemoryDatabase
from app.db.models import User

PASSWORD = "a long enough password"


def _service(**overrides) -> tuple[AuthService, MemoryDatabase]:
    settings = Settings(**overrides)
    database = MemoryDatabase(seed=False)
    throttle = LoginThrottle(
        failures_before_lockout=settings.login_throttle_failures,
        window_seconds=settings.login_throttle_window_seconds,
    )
    return AuthService(database, settings, throttle), database


async def _admin(service: AuthService) -> User:
    return await service.setup_first_admin(
        username="admin", password=PASSWORD, display_name="Admin"
    )


async def test_setup_creates_the_first_admin_once() -> None:
    service, _database = _service()

    assert await service.is_setup_complete() is False
    user = await _admin(service)
    assert user.is_admin is True
    assert user.username == "admin"
    assert await service.is_setup_complete() is True

    with pytest.raises(SetupAlreadyCompleteError):
        await service.setup_first_admin(username="second", password=PASSWORD)


async def test_setup_stores_a_hash_not_the_password() -> None:
    service, database = _service()
    await _admin(service)

    async with database.transaction() as uow:
        stored = await uow.users.get_by_username("admin")
    assert stored is not None
    assert stored.password_hash != PASSWORD
    assert stored.password_hash.startswith("$argon2id$")


async def test_login_succeeds_and_returns_a_token() -> None:
    service, _database = _service()
    user = await _admin(service)

    token, logged_in = await service.login("admin", PASSWORD)

    assert logged_in.id == user.id
    resolved = await service.resolve(token)
    assert resolved is not None
    assert resolved.user.id == user.id


async def test_login_is_case_insensitive_on_the_username() -> None:
    service, _ = _service()
    await _admin(service)
    token, _user = await service.login("ADMIN", PASSWORD)
    assert await service.resolve(token) is not None


@pytest.mark.parametrize(
    ("username", "password"),
    [("admin", "the wrong password"), ("nobody", PASSWORD)],
)
async def test_a_wrong_password_and_an_unknown_user_are_the_same_error(
    username: str, password: str
) -> None:
    service, _ = _service()
    await _admin(service)

    with pytest.raises(AuthError) as exc:
        await service.login(username, password)
    assert str(exc.value) == "Invalid username or password"


async def test_failed_logins_are_throttled() -> None:
    service, _ = _service(login_throttle_failures=3)
    await _admin(service)

    for _ in range(3):
        with pytest.raises(AuthError):
            await service.login("admin", "wrong password")
    with pytest.raises(RateLimitedError):
        await service.login("admin", PASSWORD)


async def test_login_rotates_the_presented_session() -> None:
    service, _ = _service()
    await _admin(service)
    first, _user = await service.login("admin", PASSWORD)

    second, _user = await service.login("admin", PASSWORD, previous_token=first)

    assert await service.resolve(first) is None
    assert await service.resolve(second) is not None


async def test_logout_revokes_the_session_and_is_idempotent() -> None:
    service, _ = _service()
    await _admin(service)
    token, _user = await service.login("admin", PASSWORD)

    await service.logout(token)
    await service.logout(token)

    assert await service.resolve(token) is None


async def test_an_absolute_expiry_ends_the_session(monkeypatch: pytest.MonkeyPatch) -> None:
    service, _ = _service(session_absolute_seconds=10.0)
    await _admin(service)
    token, _user = await service.login("admin", PASSWORD)

    import app.auth.service as auth_service

    real_now = auth_service.utc_now
    monkeypatch.setattr(auth_service, "utc_now", lambda: real_now() + 11)
    assert await service.resolve(token) is None


async def test_an_idle_session_expires(monkeypatch: pytest.MonkeyPatch) -> None:
    service, _ = _service(session_idle_seconds=10.0)
    await _admin(service)
    token, _user = await service.login("admin", PASSWORD)

    import app.auth.service as auth_service

    real_now = auth_service.utc_now
    monkeypatch.setattr(auth_service, "utc_now", lambda: real_now() + 11)
    assert await service.resolve(token) is None


async def test_an_expired_session_row_is_deleted(monkeypatch: pytest.MonkeyPatch) -> None:
    service, database = _service(session_absolute_seconds=10.0)
    user = await _admin(service)
    token, _user = await service.login("admin", PASSWORD)
    resolved = await service.resolve(token)
    assert resolved is not None

    import app.auth.service as auth_service

    real_now = auth_service.utc_now
    monkeypatch.setattr(auth_service, "utc_now", lambda: real_now() + 11)
    await service.resolve(token)

    async with database.transaction() as uow:
        assert await uow.sessions.list_for_user(user.id) == []


async def test_last_seen_is_refreshed_at_most_once_a_minute(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    service, _ = _service()
    await _admin(service)
    token, _user = await service.login("admin", PASSWORD)

    import app.auth.service as auth_service

    original = await service.resolve(token)
    assert original is not None
    base = original.session.last_seen_at

    # A report a few seconds later must not write a row.
    monkeypatch.setattr(auth_service, "utc_now", lambda: base + 5)
    first = await service.resolve(token)
    assert first is not None
    assert first.session.last_seen_at == base

    # Past the refresh interval it does.
    monkeypatch.setattr(auth_service, "utc_now", lambda: base + LAST_SEEN_REFRESH_SECONDS + 1)
    second = await service.resolve(token)
    assert second is not None
    assert second.session.last_seen_at > base


async def test_changing_the_password_revokes_other_sessions() -> None:
    service, _ = _service()
    user = await _admin(service)
    keep, _user = await service.login("admin", PASSWORD)
    other, _user = await service.login("admin", PASSWORD)
    resolved = await service.resolve(keep)
    assert resolved is not None

    await service.change_password(
        user.id,
        current_password=PASSWORD,
        new_password="another long password",
        keep_session_id=resolved.session.id,
    )

    assert await service.resolve(keep) is not None
    assert await service.resolve(other) is None
    with pytest.raises(AuthError):
        await service.login("admin", PASSWORD)
    token, _user = await service.login("admin", "another long password")
    assert await service.resolve(token) is not None


async def test_changing_the_password_requires_the_current_one() -> None:
    service, _ = _service()
    user = await _admin(service)
    resolved = await service.resolve((await service.login("admin", PASSWORD))[0])
    assert resolved is not None

    with pytest.raises(AuthError):
        await service.change_password(
            user.id,
            current_password="wrong",
            new_password="another long password",
            keep_session_id=resolved.session.id,
        )


async def test_a_disabled_user_cannot_log_in_and_loses_live_sessions() -> None:
    service, _ = _service()
    user = await _admin(service)
    token, _user = await service.login("admin", PASSWORD)

    await service.update_user(user.id, is_active=False)

    assert await service.resolve(token) is None
    with pytest.raises(AuthError):
        await service.login("admin", PASSWORD)


async def test_resetting_a_password_revokes_sessions() -> None:
    service, _ = _service()
    user = await _admin(service)
    token, _user = await service.login("admin", PASSWORD)

    await service.update_user(user.id, password="a third long password")

    assert await service.resolve(token) is None


async def test_creating_a_user_rejects_a_duplicate_username() -> None:
    service, _ = _service()
    await _admin(service)

    with pytest.raises(AuthError):
        await service.create_user(username="ADMIN", password=PASSWORD)
    created = await service.create_user(username="reader", password=PASSWORD)
    assert created.is_admin is False


async def test_an_unknown_token_resolves_to_nothing() -> None:
    service, _ = _service()
    assert await service.resolve(None) is None
    assert await service.resolve("not-a-real-token") is None
