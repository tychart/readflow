"""Identity constants shared by the domain, storage and the dev seed.

`DEFAULT_USER_ID` used to be "the only user". With authentication it is only the
**in-memory development account**: the Postgres adapter starts empty and the
first admin is created through `/api/auth/setup`, while `MemoryDatabase` seeds
this account so unit tests, the diagnostics probe and `scripts/dev.sh --memory`
have somebody to act as.

The password below is deliberate and documented, not a mistake:

- It only exists in the in-memory adapter, whose rows vanish on exit.
- Postgres never seeds it (there is no `seed` call on that adapter), so a
  production install has no default credentials at all.

The hash is precomputed so seeding costs nothing (argon2 takes ~100 ms, and the
test suite builds a database per test).
"""

from __future__ import annotations

DEFAULT_USER_ID = "local"
DEFAULT_USER_USERNAME = "local"
DEFAULT_USER_DISPLAY_NAME = "Local user"

# Password: "readflow-local-dev". Development only; see the module docstring.
DEFAULT_USER_PASSWORD = "readflow-local-dev"
DEFAULT_USER_PASSWORD_HASH = (
    # Split across lines only to respect the line-length rule; argon2 hashes
    # are single opaque strings.
    "$argon2id$v=19$m=65536,t=3,p=4$4N5PYnYvuoqNzPXgnsg37g"
    "$fGbgAxg6FEUVada+f5CJtusGEZc9rdDiCWcKJrtJVS4"
)
