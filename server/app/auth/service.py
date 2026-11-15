"""Authentication and session commands.

One service owns every rule about who may act:

- Setup is allowed exactly once, atomically (a second racing request loses).
- Login is throttled per (client, username), never distinguishes an unknown user
  from a wrong password, and rotates the session cookie.
- A session is valid while `now < expires_at` **and** it has been seen within the
  idle window; `last_seen_at` is refreshed at most once a minute so a reader
  polling playback reports does not write a row per report.
- Logout, password change and disabling a user revoke sessions. That is the whole
  revocation story: there is no denylist, because the session row *is* the list.

Nothing here knows about HTTP. Cookies and status codes are the API layer's job.
"""

from __future__ import annotations

import hashlib
import secrets

from app.auth.models import AuthError, CurrentSession, SetupAlreadyCompleteError
from app.auth.passwords import (
    burn_dummy_verify,
    hash_password,
    validate_password,
    verify_and_update,
)
from app.auth.throttle import LoginThrottle, RateLimitedError
from app.core.config import Settings
from app.core.time import utc_now
from app.db.models import Session, User
from app.db.protocols import Database

# How often `last_seen_at` may be written for one session. A reader reports
# playback every ~3s; a write per report would be pure overhead.
LAST_SEEN_REFRESH_SECONDS = 60.0


def _hash_token(token: str) -> bytes:
    return hashlib.sha256(token.encode("utf-8")).digest()


class AuthService:
    def __init__(
        self,
        database: Database,
        settings: Settings,
        throttle: LoginThrottle | None = None,
    ) -> None:
        self._db = database
        self._settings = settings
        self._throttle = throttle or LoginThrottle()

    # ── setup ───────────────────────────────────────────────────────────────

    async def is_setup_complete(self) -> bool:
        async with self._db.transaction() as uow:
            return bool(await uow.users.list())

    async def setup_first_admin(
        self, *, username: str, password: str, display_name: str | None = None
    ) -> User:
        """Create the first user as an admin. Only possible on an empty install."""
        clean_username = username.strip().lower()
        if not clean_username:
            raise AuthError("Username is required")
        password_hash = hash_password(password)
        # Hash outside the transaction: argon2 takes ~100ms and holding a
        # connection for it would serialise every other request.
        async with self._db.transaction() as uow:
            if await uow.users.list():
                # Re-checked inside the transaction, so two racing setups cannot
                # both win.
                raise SetupAlreadyCompleteError("Setup has already been completed")
            user = User(
                id=secrets.token_urlsafe(16),
                username=clean_username,
                display_name=(display_name or username).strip() or clean_username,
                password_hash=password_hash,
                is_admin=True,
                is_active=True,
            )
            await uow.users.add(user)
            return user

    # ── login ───────────────────────────────────────────────────────────────

    async def authenticate(self, username: str, password: str, *, client_key: str = "") -> User:
        """Verify credentials. Raises AuthError for anything wrong."""
        clean_username = username.strip().lower()
        throttle_key = (client_key, clean_username)
        self._throttle.check(throttle_key)

        async with self._db.transaction() as uow:
            user = await uow.users.get_by_username(clean_username)

        if user is None or not user.password_hash:
            # Same cost as a real verification, so timing does not enumerate.
            burn_dummy_verify(password)
            self._throttle.record_failure(throttle_key)
            raise AuthError("Invalid username or password")

        ok, replacement = verify_and_update(password, user.password_hash)
        if not ok:
            self._throttle.record_failure(throttle_key)
            raise AuthError("Invalid username or password")
        if not user.is_active:
            # The password was right, so this is not an enumeration risk; the
            # message is still generic.
            raise AuthError("Invalid username or password")
        if replacement is not None:
            async with self._db.transaction() as uow:
                stored = await uow.users.get(user.id)
                if stored is not None:
                    stored.password_hash = replacement
                    await uow.users.save(stored)
            user.password_hash = replacement

        self._throttle.record_success(throttle_key)
        return user

    async def login(
        self,
        username: str,
        password: str,
        *,
        client_key: str = "",
        previous_token: str | None = None,
    ) -> tuple[str, User]:
        """Authenticate and open a fresh session (rotating any presented one)."""
        user = await self.authenticate(username, password, client_key=client_key)
        if previous_token:
            await self.logout(previous_token)
        token = secrets.token_urlsafe(32)
        now = utc_now()
        session = Session(
            id=secrets.token_urlsafe(16),
            user_id=user.id,
            token_hash=_hash_token(token),
            created_at=now,
            last_seen_at=now,
            expires_at=now + self._settings.session_absolute_seconds,
        )
        async with self._db.transaction() as uow:
            await uow.sessions.add(session)
        return token, user

    # ── session resolution ──────────────────────────────────────────────────

    async def resolve(self, token: str | None) -> CurrentSession | None:
        """Validate a presented token, refreshing the idle deadline if it is valid."""
        if not token:
            return None
        token_hash = _hash_token(token)
        now = utc_now()
        async with self._db.transaction() as uow:
            session = await uow.sessions.get_by_token_hash(token_hash)
            if session is None:
                return None
            if now >= session.expires_at:
                await uow.sessions.delete(session.id)
                return None
            if now - session.last_seen_at > self._settings.session_idle_seconds:
                await uow.sessions.delete(session.id)
                return None
            user = await uow.users.get(session.user_id)
            if user is None or not user.is_active:
                # A disabled user's live sessions stop working immediately.
                await uow.sessions.delete_for_user(session.user_id)
                return None
            if now - session.last_seen_at >= LAST_SEEN_REFRESH_SECONDS:
                session.last_seen_at = now
                await uow.sessions.save(session)
            return CurrentSession(session=session, user=user)

    async def logout(self, token: str | None) -> None:
        """Delete the session behind a token. Idempotent."""
        if not token:
            return
        token_hash = _hash_token(token)
        async with self._db.transaction() as uow:
            session = await uow.sessions.get_by_token_hash(token_hash)
            if session is not None:
                await uow.sessions.delete(session.id)

    # ── password and account management ─────────────────────────────────────

    async def change_password(
        self, user_id: str, *, current_password: str, new_password: str, keep_session_id: str
    ) -> None:
        """Change a password and revoke every other session for that user."""
        validate_password(new_password)
        new_hash = hash_password(new_password)
        async with self._db.transaction() as uow:
            user = await uow.users.get(user_id)
            if user is None:
                raise AuthError("Unknown user")
            ok, _replacement = verify_and_update(current_password, user.password_hash)
            if not ok:
                raise AuthError("Current password is incorrect")
            user.password_hash = new_hash
            await uow.users.save(user)
            for session in await uow.sessions.list_for_user(user_id):
                if session.id != keep_session_id:
                    await uow.sessions.delete(session.id)

    async def list_users(self) -> list[User]:
        async with self._db.transaction() as uow:
            return await uow.users.list()

    async def create_user(
        self,
        *,
        username: str,
        password: str,
        display_name: str | None = None,
        is_admin: bool = False,
    ) -> User:
        clean_username = username.strip().lower()
        if not clean_username:
            raise AuthError("Username is required")
        password_hash = hash_password(password)
        async with self._db.transaction() as uow:
            existing = await uow.users.get_by_username(clean_username)
            if existing is not None:
                raise AuthError("That username is already taken")
            user = User(
                id=secrets.token_urlsafe(16),
                username=clean_username,
                display_name=(display_name or username).strip() or clean_username,
                password_hash=password_hash,
                is_admin=is_admin,
                is_active=True,
            )
            await uow.users.add(user)
            return user

    async def update_user(
        self,
        user_id: str,
        *,
        is_active: bool | None = None,
        is_admin: bool | None = None,
        display_name: str | None = None,
        password: str | None = None,
    ) -> User:
        """Admin edit. Disabling a user or resetting a password revokes sessions."""
        password_hash = hash_password(password) if password is not None else None
        async with self._db.transaction() as uow:
            user = await uow.users.get(user_id)
            if user is None:
                raise AuthError("Unknown user")
            if is_active is not None:
                user.is_active = is_active
            if is_admin is not None:
                user.is_admin = is_admin
            if display_name is not None and display_name.strip():
                user.display_name = display_name.strip()
            if password_hash is not None:
                user.password_hash = password_hash
            await uow.users.save(user)
            if is_active is False or password_hash is not None:
                for session in await uow.sessions.list_for_user(user_id):
                    await uow.sessions.delete(session.id)
            return user


__all__ = ["AuthError", "AuthService", "RateLimitedError", "SetupAlreadyCompleteError"]
