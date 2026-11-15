"""Password hashing: one place that hashes, one place that verifies.

argon2id (`pwdlib`'s recommended parameters) because it is memory-hard and the
current recommendation. Two rules beyond "call the library":

- `verify_and_update` returns a fresh hash when the stored one used weaker
  parameters, so a login silently upgrades it.
- The unknown-user path verifies against a **dummy hash** so it costs the same as
  a wrong password. Without that, response timing enumerates usernames.
"""

from __future__ import annotations

from pwdlib import PasswordHash

MIN_PASSWORD_LENGTH = 12
# Not a UX limit, a "do not let the request be a denial-of-service" limit.
MAX_PASSWORD_LENGTH = 1024

_hasher = PasswordHash.recommended()

# A real argon2id hash of a random value, used only to burn the same CPU time
# when the username does not exist.
DUMMY_HASH = _hasher.hash("readflow-dummy-password-for-timing")


class PasswordError(ValueError):
    """A password was rejected by policy (too short, too long)."""


def validate_password(password: str) -> None:
    if len(password) < MIN_PASSWORD_LENGTH:
        raise PasswordError(f"Password must be at least {MIN_PASSWORD_LENGTH} characters")
    if len(password) > MAX_PASSWORD_LENGTH:
        raise PasswordError(f"Password must be at most {MAX_PASSWORD_LENGTH} characters")


def hash_password(password: str) -> str:
    validate_password(password)
    return _hasher.hash(password)


def verify_and_update(password: str, password_hash: str) -> tuple[bool, str | None]:
    """Verify a password, returning (ok, replacement hash when it needs one)."""
    return _hasher.verify_and_update(password, password_hash)


def burn_dummy_verify(password: str) -> None:
    """Spend the same time as a real verification, for an unknown user."""
    _hasher.verify(password, DUMMY_HASH)
