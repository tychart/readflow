"""Password hashing: argon2id, rehash-on-login, constant-time misses."""

from __future__ import annotations

import pytest

from app.auth.passwords import (
    DUMMY_HASH,
    MAX_PASSWORD_LENGTH,
    MIN_PASSWORD_LENGTH,
    PasswordError,
    burn_dummy_verify,
    hash_password,
    validate_password,
    verify_and_update,
)


def test_a_password_round_trips_through_argon2id() -> None:
    hashed = hash_password("a long enough password")
    assert hashed.startswith("$argon2id$")
    ok, replacement = verify_and_update("a long enough password", hashed)
    assert ok is True
    # Current parameters: nothing to upgrade.
    assert replacement is None


def test_a_wrong_password_does_not_verify() -> None:
    hashed = hash_password("a long enough password")
    ok, replacement = verify_and_update("a different password", hashed)
    assert ok is False
    assert replacement is None


def test_the_same_password_hashes_differently_each_time() -> None:
    """A per-hash salt, so identical passwords are not comparable in the table."""
    first = hash_password("a long enough password")
    second = hash_password("a long enough password")
    assert first != second
    assert verify_and_update("a long enough password", first)[0] is True
    assert verify_and_update("a long enough password", second)[0] is True


@pytest.mark.parametrize("length", [0, 1, MIN_PASSWORD_LENGTH - 1])
def test_short_passwords_are_rejected(length: int) -> None:
    with pytest.raises(PasswordError):
        validate_password("x" * length)


def test_an_overlong_password_is_rejected_rather_than_hashed() -> None:
    with pytest.raises(PasswordError):
        validate_password("x" * (MAX_PASSWORD_LENGTH + 1))


def test_the_minimum_length_is_accepted() -> None:
    validate_password("x" * MIN_PASSWORD_LENGTH)


def test_the_dummy_hash_is_a_real_argon2_hash_that_nothing_verifies_against() -> None:
    """The unknown-user path must spend real time, not short-circuit."""
    assert DUMMY_HASH.startswith("$argon2id$")
    assert verify_and_update("readflow-local-dev", DUMMY_HASH)[0] is False
    burn_dummy_verify("anything at all")
