#!/usr/bin/env bash
#
# Fast container smoke test for the ReadFlow api image.
#
# Boots the image with the fake provider (no GPU, no model download) and checks
# that it starts, reports healthy, and exposes the built-in voices. This catches
# the failure modes that are invisible in `docker build`: a broken venv, a
# missing voices directory, a bad entrypoint.
#
#   scripts/compose-smoke.sh                       # default published image
#   scripts/compose-smoke.sh readflow-api:flash    # any local image
#   scripts/compose-smoke.sh my-image 18099        # custom host port
#
set -euo pipefail

IMAGE="${1:-${READFLOW_API_IMAGE:-ghcr.io/tychart/readflow-api:latest}}"
PORT="${2:-18099}"
CONTAINER="readflow-smoke-$$"

if command -v docker >/dev/null 2>&1; then
  ENGINE="docker"
elif command -v podman >/dev/null 2>&1; then
  ENGINE="podman"
else
  echo "error: neither docker nor podman is installed" >&2
  exit 1
fi

cleanup() { "$ENGINE" rm -f "$CONTAINER" >/dev/null 2>&1 || true; }
trap cleanup EXIT

echo "==> starting $IMAGE with the fake provider (no GPU)"
"$ENGINE" run -d --name "$CONTAINER" -p "${PORT}:8000" \
  -e READFLOW_TTS_PROVIDER=fake \
  -e READFLOW_SCHEDULER_AUTOSTART=false \
  "$IMAGE" >/dev/null

echo "==> waiting for /health on 127.0.0.1:${PORT}"
for _ in $(seq 1 60); do
  if curl -fsS "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1; then
    break
  fi
  if ! "$ENGINE" ps --quiet --filter "name=^${CONTAINER}$" | grep -q .; then
    echo "error: container exited during startup" >&2
    "$ENGINE" logs "$CONTAINER" >&2 || true
    exit 1
  fi
  sleep 1
done

health="$(curl -fsS "http://127.0.0.1:${PORT}/health")"
echo "    /health -> ${health}"
case "$health" in
  *'"status":"ok"'*) ;;
  *) echo "error: unexpected /health payload" >&2; exit 1 ;;
esac

voices="$(curl -fsS "http://127.0.0.1:${PORT}/api/voices")"
echo "    /api/voices -> ${voices}"
for expected in suzy howard; do
  case "$voices" in
    *"\"$expected\""*) ;;
    *) echo "error: voice '$expected' missing from the image" >&2; exit 1 ;;
  esac
done

echo "==> OK: $IMAGE starts, is healthy, and has the built-in voices"
