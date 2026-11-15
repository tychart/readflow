#!/bin/sh
# Container entrypoint: migrate, then run the given command.
#
# Migrations run here (not in a separate job) because this stack is one host with
# one API container: a second container would only add a race. `alembic upgrade
# head` is idempotent and transactional, so a restart is a no-op.
#
# No DATABASE_URL means the in-memory adapter is in use, and there is nothing to
# migrate — the app handles that itself.
set -eu

if [ -n "${DATABASE_URL:-}${READFLOW_DATABASE_URL:-}" ] && [ "${READFLOW_SKIP_MIGRATIONS:-0}" != "1" ]; then
    echo "readflow: applying migrations"
    if ! alembic upgrade head; then
        # Failing loudly beats serving against a half-migrated schema.
        echo "readflow: migration failed; refusing to start" >&2
        exit 1
    fi
else
    echo "readflow: no DATABASE_URL, using the in-memory adapter (no migrations)"
fi

exec "$@"
