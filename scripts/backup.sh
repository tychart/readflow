#!/usr/bin/env bash
#
# ReadFlow — database backup.
#
# Writes a `pg_dump -Fc` (custom format, restorable with pg_restore) into
# $BACKUP_DIR with a UTC timestamp, then prunes all but the newest
# $BACKUP_RETENTION archives. Built for cron / systemd / a quadlet timer:
#
#   03:30 * * * *   /srv/readflow/scripts/backup.sh >> /var/log/readflow-backup.log 2>&1
#
# Usage:
#   scripts/backup.sh                 # back up using DATABASE_URL / .env
#   scripts/backup.sh --compose       # back up the `pg` service of compose.yml
#                                     # through the container (no local client)
#   scripts/backup.sh --out DIR       # override $BACKUP_DIR for this run
#   scripts/backup.sh --retention N   # override $BACKUP_RETENTION
#   scripts/backup.sh --quiet         # print only the summary line
#
# Exit status: 0 on success, non-zero on any failure (so a timer notices).
#
# Secrets: the password travels in PGPASSWORD (an environment variable), never in
# argv, so `ps` cannot show it. A compose backup passes it through `env -i`.
#
# Restore:
#   pg_restore --clean --if-exists -d readflow readflow-YYYYmmddTHHMMSSZ.dump
# (--clean drops the objects being replaced; run it against a *scratch* database
# first if you are not sure.)

set -euo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"

# `.env` is the one local config file (gitignored): it holds DATABASE_URL and the
# backup settings for both this script and compose.
if [[ -f "$ROOT/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  . "$ROOT/.env"
  set +a
fi

BACKUP_DIR="${BACKUP_DIR:-$ROOT/backups}"
RETENTION="${BACKUP_RETENTION:-14}"
DATABASE_URL="${DATABASE_URL:-postgresql+psycopg://readflow:readflow@127.0.0.1:5432/readflow}"
PG_SERVICE="${READFLOW_PG_SERVICE:-pg}"
compose_mode=0
quiet=0

log() { ((quiet)) || printf '%s\n' "$*"; }
die() { printf '%s\n' "backup failed: $*" >&2; exit 1; }

while (($# > 0)); do
  case "$1" in
    --compose) compose_mode=1; shift ;;
    --out) BACKUP_DIR="${2:?--out needs a directory}"; shift 2 ;;
    --retention) RETENTION="${2:?--retention needs a number}"; shift 2 ;;
    --quiet) quiet=1; shift ;;
    -h | --help) sed -n '2,32p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown option '$1' (try --help)" ;;
  esac
done

[[ $RETENTION =~ ^[0-9]+$ ]] || die "retention must be a number"
((RETENTION >= 1)) || die "retention must be at least 1"

mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"
# One instant, formatted in UTC, used for the filename and the log line.
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
TARGET="$BACKUP_DIR/readflow-$STAMP.dump"

container_engine() {
  if command -v podman >/dev/null 2>&1; then echo podman
  elif command -v docker >/dev/null 2>&1; then echo docker
  fi
}

if ((compose_mode)); then
  engine="$(container_engine)"
  [[ -n $engine ]] || die "no podman or docker found for --compose"
  container=$("$engine" ps --filter "label=com.docker.compose.service=$PG_SERVICE" --format '{{.Names}}' | head -n1)
  [[ -n $container ]] || die "no running '$PG_SERVICE' container; start the stack first"
  # Inside the container the password is already in the environment and the
  # socket is local, so no URL is needed.
  tmp="$TARGET.partial"
  log "dumping $container -> $TARGET"
  if ! "$engine" exec "$container" pg_dump -Fc -U "${POSTGRES_USER:-readflow}" -d "${POSTGRES_DB:-readflow}" >"$tmp"; then
    rm -f "$tmp"
    die "pg_dump in $container failed"
  fi
  mv "$tmp" "$TARGET"
else
  command -v pg_dump >/dev/null 2>&1 || die "pg_dump not found (install postgresql-client, or use --compose)"
  # Parse the SQLAlchemy URL without needing python on the timer's PATH.
  rest="${DATABASE_URL#*://}"
  authority="${rest%%/*}"
  dbname="${rest#*/}"
  dbname="${dbname%%\?*}"
  credentials="${authority%%@*}"
  hostport="${authority##*@}"
  [[ $credentials == "$authority" ]] && credentials=""
  dbuser="${credentials%%:*}"
  dbpass=""
  [[ $credentials == *:* ]] && dbpass="${credentials#*:}"
  dbhost="${hostport%%:*}"
  dbport="5432"
  [[ $hostport == *:* ]] && dbport="${hostport##*:}"
  [[ -n $dbuser ]] || dbuser="${POSTGRES_USER:-readflow}"
  [[ -n $dbname ]] || die "cannot read a database name from DATABASE_URL"

  tmp="$TARGET.partial"
  log "dumping $dbuser@$dbhost:$dbport/$dbname -> $TARGET"
  if ! PGPASSWORD="${dbpass:-$PGPASSWORD:-}" PGCONNECT_TIMEOUT=10 \
      pg_dump -Fc -h "$dbhost" -p "$dbport" -U "$dbuser" -d "$dbname" >"$tmp"; then
    rm -f "$tmp"
    die "pg_dump failed (is the database running? are the credentials right?)"
  fi
  mv "$tmp" "$TARGET"
fi

# 0600: a dump contains every account and every source text.
chmod 600 "$TARGET"
[[ -s $TARGET ]] || die "the dump is empty; refusing to keep it"

# Retention: newest N by filename (the timestamp sorts lexicographically).
mapfile -t archives < <(find "$BACKUP_DIR" -maxdepth 1 -type f -name 'readflow-*.dump' -printf '%f\n' | sort -r)
if ((${#archives[@]} > RETENTION)); then
  for old in "${archives[@]:RETENTION}"; do
    rm -f "$BACKUP_DIR/$old"
    log "pruned $old"
  done
fi

size=$(du -h "$TARGET" | cut -f1)
printf 'backup ok: %s (%s, %d kept in %s)\n' "$TARGET" "$size" "${#archives[@]}" "$BACKUP_DIR"
