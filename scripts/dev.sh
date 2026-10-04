#!/usr/bin/env bash
#
# ReadFlow — one-command local dev stack.
#
# Brings the whole app up from one terminal, both halves hot-reloading:
#   api   FastAPI/uvicorn on http://localhost:8000  (uv, --reload, real Qwen3-TTS
#         by default; the model itself loads lazily on the first synthesis)
#   web   Vite on http://localhost:5173             (bun, HMR, /api proxied to :8000)
#         and on 0.0.0.0, so a phone or tablet on the same network can use it.
#         The api itself stays loopback-only and is reached through Vite's proxy.
#
# ReadFlow has no database — jobs, chunks and telemetry live in memory — so there
# is nothing to migrate, and `stop`/`down` are the same thing.
#
# Usage:
#   scripts/dev.sh [start]     start api + web, then follow logs. Ctrl-C stops both.
#   scripts/dev.sh restart     stop a running stack, then start a fresh one
#   scripts/dev.sh stop        stop the api + web processes started here
#   scripts/dev.sh status      show what is up (ports + how it was started)
#   scripts/dev.sh logs        tail the api + web logs without starting anything
#   scripts/dev.sh test        make test       (web: bun/vitest · server: uv/pytest)
#   scripts/dev.sh test-e2e    make test-e2e   (Playwright)
#   scripts/dev.sh lint        make lint
#   scripts/dev.sh typecheck   make typecheck
#   scripts/dev.sh help
#
# Switches (env-var equivalent in brackets):
#   --fake              boot with READFLOW_TTS_PROVIDER=fake — instant, no GPU,
#                       no model load, deterministic audio            [DEV_PROVIDER=fake]
#   --real              force the real Qwen3-TTS provider (default)   [DEV_PROVIDER=qwen]
#   --localhost         bind the web dev server to loopback only, so nothing
#                       else on the network can reach it         [DEV_WEB_HOST=localhost]
#   --no-follow         start in the background, don't tail logs       [DEV_NO_FOLLOW=1]
#   --no-server         skip the api                                   [DEV_NO_SERVER=1]
#   --no-web            skip the frontend                              [DEV_NO_WEB=1]
#   --access-log        show uvicorn per-request access logs           [DEV_ACCESS_LOG=1]
#   NO_COLOR=1          plain output (also automatic when not a TTY)
#
# The ports are fixed at 8000 (api) and 5173 (web) because Vite's /api proxy is
# compiled against 8000; if either port is taken the script says so and leaves
# that process alone rather than guessing.
#
# Notes:
#   * The web dev server binds 0.0.0.0 by default (opt out with --localhost); the api
#     still binds 127.0.0.1, so LAN clients only reach it through Vite's /api proxy.
#     There is no auth — treat a LAN URL as trusted-network only.
#   * Logs live in .dev-logs/ (gitignored); run state lives in .dev-logs/dev.state.
#     Starting the stack rotates the previous api.log/web.log into
#     .dev-logs/archive/ (newest DEV_LOG_RETENTION=10 kept per stream) so an
#     earlier failure is still diagnosable.
#   * Nothing is ever killed by pattern — only the pids this script recorded, each
#     in its own session so `uvicorn --reload`'s children go with it.
#   * If server/.venv is missing it is created with
#     `uv sync --extra dev --extra utils`. An existing venv is never re-synced
#     implicitly, because a sync prunes undeclared packages — including a locally
#     built flash-attn, which can take ~1h to rebuild. When flash-attn is present
#     the api runs with `uv run --no-sync` for exactly that reason.
set -euo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

LOG_DIR="$ROOT/.dev-logs"
API_LOG="$LOG_DIR/api.log"
WEB_LOG="$LOG_DIR/web.log"
STATE_FILE="$LOG_DIR/dev.state"
# Previous runs are archived here instead of being truncated on start. The
# stable api.log/web.log paths are kept for `logs`/`status`; only the newest
# LOG_RETENTION archives per stream are retained.
LOG_ARCHIVE_DIR="$LOG_DIR/archive"
LOG_RETENTION="${DEV_LOG_RETENTION:-10}"

api_port=8000
web_port=5173
# Serving the web on the LAN by default is what makes the reader usable from a phone
# without any extra setup. Vite proxies /api itself, so the api needs no LAN bind.
web_host="${DEV_WEB_HOST:-0.0.0.0}"
provider="${DEV_PROVIDER:-qwen}"
no_server="${DEV_NO_SERVER:-0}"
no_web="${DEV_NO_WEB:-0}"
no_follow="${DEV_NO_FOLLOW:-0}"
access_log="${DEV_ACCESS_LOG:-0}"
no_sync=0
api_foreign=0
web_foreign=0
api_url="http://localhost:$api_port"
web_url="http://localhost:$web_port"

# --- output ------------------------------------------------------------------
if [[ -t 1 && -z ${NO_COLOR:-} ]]; then
  BOLD=$'\e[1m'; DIM=$'\e[2m'; OFF=$'\e[0m'
  YEL=$'\e[1;33m'
  C_FRAME=$'\e[2;36m'; C_LABEL=$'\e[36m'; C_OK=$'\e[1;32m'; C_BAD=$'\e[1;31m'
  C_API=$'\e[1;36m'; C_WEB=$'\e[1;35m'; C_ACCENT=$'\e[1;33m'
  COLOR=1
else
  BOLD=; DIM=; OFF=; YEL=; C_FRAME=; C_LABEL=; C_OK=; C_BAD=; C_API=; C_WEB=; C_ACCENT=
  COLOR=""
fi

info() { printf '%s\n' "  ${C_ACCENT}▸${OFF} $*"; }
ok() { printf '%s\n' "  ${C_OK}✔${OFF} $*"; }
warn() { printf '%s\n' "  ${YEL}⚠${OFF} $*" >&2; }
die() { printf '%s\n' "  ${C_BAD}✖${OFF} $*" >&2; exit 1; }
hint() { printf '%s\n' "  ${DIM}$*${OFF}"; }

_DASHES='──────────────────────────────────────────────────────────────────────────────────────────'
dashes() { printf '%s' "${_DASHES:0:${1:-0}}"; }

# --- box drawing -------------------------------------------------------------
# Each row is kept twice: a plain copy (for width maths) and a coloured copy.
LABEL_W=9
_box_title=""
_box_plain=()
_box_print=()

box_open() {
  _box_title="$1"
  _box_plain=()
  _box_print=()
}

box_row() {
  local label="$1" plain="$2" printed="${3:-$2}" padded
  padded="$(printf "%-${LABEL_W}s" "$label")"
  _box_plain+=("  $padded $plain")
  _box_print+=("  ${C_LABEL}${padded}${OFF} ${printed}")
}

box_close() {
  local w=0 row
  for row in "${_box_plain[@]:-}"; do ((${#row} > w)) && w=${#row}; done
  ((w += 2))
  local dashes_n=$((w - ${#_box_title} - 3))
  ((dashes_n < 1)) && dashes_n=1
  printf '\n'
  printf '%s╭─ %s%s%s %s╮%s\n' \
    "$C_FRAME" "$BOLD" "$_box_title" "$OFF$C_FRAME" "$(dashes "$dashes_n")" "$OFF"
  local i
  for i in "${!_box_plain[@]}"; do
    printf '%s│%s%*s%s│%s\n' \
      "$C_FRAME" "${_box_print[$i]}" "$((w - ${#_box_plain[$i]}))" "" "$C_FRAME" "$OFF"
  done
  printf '%s╰%s╯%s\n' "$C_FRAME" "$(dashes "$w")" "$OFF"
}

# --- probes ------------------------------------------------------------------
have() { command -v "$1" >/dev/null 2>&1; }

port_open() {
  local p=$1 a
  # `ss` covers IPv4, IPv6 and any bind address in one shot; bash's /dev/tcp only
  # speaks IPv4 literals reliably ("::1" is not parseable there).
  if have ss; then
    if [[ -n $(ss -ltnH "sport = :$p" 2>/dev/null) ]]; then
      return 0
    fi
    return 1
  fi
  for a in 127.0.0.1 ::1; do
    if (exec 3<>"/dev/tcp/$a/$p") 2>/dev/null; then
      exec 3>&- 3<&- 2>/dev/null || true
      return 0
    fi
  done
  return 1
}

http_status() {
  local url=$1
  if have curl; then
    curl -s -o /dev/null -m 2 -w '%{http_code}' "$url" 2>/dev/null || true
    return 0
  fi
  # No curl: speak just enough HTTP/1.0 over bash's /dev/tcp.
  local rest host port path line
  rest=${url#*://}
  host=${rest%%/*}
  path=/${rest#*/}
  [[ $path == "/$rest" ]] && path=/
  port=80
  if [[ $host == *:* ]]; then
    port=${host##*:}
    host=${host%%:*}
  fi
  exec 3<>"/dev/tcp/$host/$port" 2>/dev/null || return 0
  printf 'GET %s HTTP/1.0\r\nHost: %s\r\n\r\n' "$path" "$host" >&3
  read -r line <&3 || true
  exec 3>&- 3<&- 2>/dev/null || true
  printf '%s' "${line##* }"
}

code_2xx() { [[ $1 == 2* ]]; }
api_ready() { code_2xx "$(http_status "$api_url/api/voices")"; }
web_ready() {
  local code
  code="$(http_status "$web_url/")"
  code_2xx "$code" || [[ $code == 3* ]]
}

port_owner() {
  have ss || return 0
  ss -ltnpH "sport = :$1" 2>/dev/null | grep -oE 'pid=[0-9]+' | head -1 | cut -d= -f2
}

# True unless a bind address is loopback-only, i.e. nothing else can reach it.
host_binds_lan() {
  case "${1:-}" in
    "" | localhost | 127.* | "::1" | "[::1]") return 1 ;;
    *) return 0 ;;
  esac
}

# The host's primary LAN address, best-effort. Every probe here can fail (no
# default route, an unusual toolchain) — that just means we print nothing. Each
# probe ends in a pipeline so `set -e` sees awk's status, not the failing tool's.
lan_ip() {
  local ip=""
  if have ip; then
    ip=$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{ for (i = 1; i < NF; i++) if ($i == "src") { print $(i + 1); exit } }')
    if [[ -z $ip ]]; then
      ip=$(ip -4 -o addr show scope global 2>/dev/null | awk 'NR == 1 { split($4, a, "/"); print a[1] }')
    fi
  fi
  if [[ -z $ip ]] && have hostname; then
    ip=$(hostname -I 2>/dev/null | awk '{ print $1 }')
  fi
  printf '%s' "$ip"
  return 0
}

# Prints the web URL other devices can use, or nothing when the server is
# loopback-only or no LAN address is derivable.
lan_url() {
  local host=$1 ip
  host_binds_lan "$host" || return 0
  ip=$(lan_ip)
  [[ -n $ip ]] && printf 'http://%s:%s' "$ip" "$web_port"
  return 0
}

# --- spinner -----------------------------------------------------------------
SPIN_FRAMES='⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'

# wait_ready <label> <timeout-seconds> <predicate…>
wait_ready() {
  local label=$1 timeout=$2
  shift 2
  local frame=0 started=$SECONDS
  while :; do
    if "$@"; then
      [[ -n $COLOR ]] && printf '\r\e[K'
      ok "$label ${DIM}($((SECONDS - started))s)${OFF}"
      return 0
    fi
    if ((SECONDS - started >= timeout)); then
      [[ -n $COLOR ]] && printf '\r\e[K'
      return 1
    fi
    if [[ -n $COLOR ]]; then
      frame=$(((frame + 1) % ${#SPIN_FRAMES}))
      printf '\r  %s %s' "${C_ACCENT}${SPIN_FRAMES:$frame:1}${OFF}" "$label"
    fi
    sleep 0.25
  done
}

# --- run state ---------------------------------------------------------------
state_get() {
  [[ -f $STATE_FILE ]] || return 0
  awk -v k="$1" '$1 == k { sub(/^[^ ]+ /, ""); print; exit }' "$STATE_FILE"
}

state_write() {
  {
    printf 'provider %s\n' "$provider"
    printf 'api_port %s\n' "$api_port"
    printf 'web_port %s\n' "$web_port"
    printf 'web_host %s\n' "$web_host"
    printf 'api_pid %s\n' "$api_pid"
    printf 'web_pid %s\n' "$web_pid"
  } >"$STATE_FILE"
}

alive() { [[ -n ${1:-} ]] && kill -0 "$1" 2>/dev/null; }

# --- process control ---------------------------------------------------------
pids=()
api_pid=""
web_pid=""
proc_pid=""
follow_pid=""

# start_proc <workdir> <logfile> <command…>
# Runs the command in its own session (setsid) so that signalling -pid reaches
# `uv run` *and* the uvicorn reloader child it spawns.
start_proc() {
  local dir=$1 log=$2
  shift 2
  if have setsid; then
    (cd "$dir" && exec setsid "$@") >"$log" 2>&1 &
  else
    (cd "$dir" && exec "$@") >"$log" 2>&1 &
  fi
  proc_pid=$!
  pids+=("$proc_pid")
}

kill_tree() {
  local pid=$1 sig=${2:-TERM}
  [[ -n $pid ]] || return 0
  kill "-$sig" "-$pid" 2>/dev/null || kill "-$sig" "$pid" 2>/dev/null || true
}

stop_pids() {
  local pid i any
  for pid in "$@"; do kill_tree "$pid" TERM; done
  for ((i = 0; i < 30; i++)); do
    any=0
    for pid in "$@"; do alive "$pid" && any=1; done
    ((any)) || return 0
    sleep 0.2
  done
  for pid in "$@"; do
    if alive "$pid"; then
      warn "pid $pid ignored SIGTERM — sending SIGKILL"
      kill_tree "$pid" KILL
    fi
  done
  return 0
}

# --- preflight ---------------------------------------------------------------
preflight() {
  have uv || die "uv is required for the api — https://docs.astral.sh/uv/"
  have bun || die "bun is required for the web — https://bun.sh/"
  have ffmpeg || warn "ffmpeg not found — synthesis will fail while packaging audio"

  local voice f missing=()
  for voice in suzy howard; do
    for f in ref.wav ref.txt meta.json; do
      [[ -f "server/voices/$voice/$f" ]] || missing+=("server/voices/$voice/$f")
    done
  done
  if ((${#missing[@]})); then
    die "voice assets missing: ${missing[*]}"
  fi

  if [[ -x server/.venv/bin/python ]]; then
    # Cheap check (no torch import). Never re-sync an existing venv: a sync
    # would prune a locally built flash-attn, which costs ~1h to rebuild.
    if compgen -G "server/.venv/lib/python*/site-packages/flash_attn" >/dev/null; then
      no_sync=1
    fi
  else
    info "server/.venv missing — running ${BOLD}uv sync --extra dev --extra utils${OFF}"
    (cd server && uv sync --extra dev --extra utils)
  fi

  if [[ ! -x web/node_modules/.bin/vite ]]; then
    info "web dependencies missing — running ${BOLD}bun install${OFF}"
    (cd web && bun install)
  fi
}

# --- stack pieces ------------------------------------------------------------
start_api() {
  if (($no_server)); then
    info "skipping api (DEV_NO_SERVER=1)"
    return 0
  fi
  if port_open "$api_port"; then
    api_foreign=1
    warn "something already listens on :$api_port — leaving it alone"
    local owner; owner=$(port_owner "$api_port")
    [[ -n $owner ]] && hint "port :$api_port belongs to pid $owner — not started by this script"
    return 0
  fi

  local flags=(--reload --port "$api_port" --no-access-log)
  (($access_log)) && flags=(--reload --port "$api_port" --access-log)

  local uv_args=(run)
  ((no_sync)) && uv_args+=(--no-sync)
  uv_args+=(uvicorn main:app "${flags[@]}")

  info "starting api on ${BOLD}$api_url${OFF} ${DIM}(provider: $provider)${OFF}"
  start_proc server "$API_LOG" env "READFLOW_TTS_PROVIDER=$provider" uv "${uv_args[@]}"
  api_pid=$proc_pid
  if ((no_sync)); then
    hint "flash-attn present — running with 'uv run --no-sync' to avoid pruning the CUDA extra"
  fi
  return 0
}

start_web() {
  if (($no_web)); then
    info "skipping web (DEV_NO_WEB=1)"
    return 0
  fi
  if port_open "$web_port"; then
    web_foreign=1
    warn "something already listens on :$web_port — leaving it alone"
    local owner; owner=$(port_owner "$web_port")
    [[ -n $owner ]] && hint "port :$web_port belongs to pid $owner — not started by this script"
    return 0
  fi

  info "starting web on ${BOLD}$web_url${OFF} ${DIM}(host: $web_host)${OFF}"
  start_proc web "$WEB_LOG" bun run dev -- --host "$web_host" --port "$web_port"
  web_pid=$proc_pid
  return 0
}

# --- log following -----------------------------------------------------------
_stream_reader() {
  local line file tag color prev=""
  while IFS= read -r line; do
    if [[ $line == "==> "*" <==" ]]; then
      file=${line#"==> "}
      file=${file%" <=="}
      case "$file" in
        */api.log) tag=api; color=$C_API ;;
        */web.log) tag=web; color=$C_WEB ;;
        *) tag=""; color="" ;;
      esac
      if [[ -n $tag && $tag != "$prev" ]]; then
        printf '\n%s── %s %s%s\n' "$C_FRAME" "$tag" "$(dashes 56)" "$OFF"
        prev=$tag
      fi
      continue
    fi
    if [[ -n $tag ]]; then
      printf '%s[%s]%s %s\n' "$color" "$tag" "$OFF" "$line"
    else
      printf '%s\n' "$line"
    fi
  done
}

follow() {
  local logs=()
  [[ -f $API_LOG ]] && logs+=("$API_LOG")
  [[ -f $WEB_LOG ]] && logs+=("$WEB_LOG")
  ((${#logs[@]})) || die "no logs yet — start the stack first"
  # Backgrounded + `wait` so a signal (Ctrl-C, or a plain `kill` of this script)
  # interrupts the tail immediately; a foreground pipeline would defer the trap
  # until tail exited on its own, which never happens.
  if [[ -n $COLOR ]]; then
    tail -n +1 -F "${logs[@]}" | _stream_reader &
  else
    tail -n +1 -F "${logs[@]}" &
  fi
  follow_pid=$!
  wait "$follow_pid" 2>/dev/null || true
  follow_pid=""
  return 0
}

tail_static() {
  local entry file label
  for entry in "$API_LOG:api" "$WEB_LOG:web"; do
    label=${entry##*:}
    file=${entry%:*}
    [[ -f $file ]] || continue
    printf '\n%s── %s %s%s\n' "$C_FRAME" "$label" "$(dashes 56)" "$OFF"
    tail -n 25 "$file"
  done
}

# --- lifecycle ---------------------------------------------------------------
cleanup() {
  trap - INT TERM EXIT
  [[ -n $COLOR ]] && printf '\r\e[K'
  [[ -n $follow_pid ]] && kill_tree "$follow_pid" TERM
  info "stopping api + web"
  stop_pids "${pids[@]:-}"
  rm -f "$STATE_FILE"
  ok "stopped"
}

# Ctrl-C during startup (before the log follow begins) must not orphan children.
startup_signal() {
  trap - INT TERM
  [[ -n $COLOR ]] && printf '\r\e[K'
  warn "interrupted — stopping what had started"
  stop_pids "${pids[@]:-}"
  rm -f "$STATE_FILE"
  exit 130
}

already_running() {
  local pid
  for pid in "$(state_get api_pid)" "$(state_get web_pid)"; do
    if alive "$pid"; then
      printf '%s' "$pid"
      return 0
    fi
  done
  return 0
}

choose_existing_action() {
  local pid=$1 ans
  existing_action=quit
  if [[ ! -t 0 || ! -t 1 ]]; then
    info "a dev stack is already running (pid $pid) — leaving it alone"
    hint "use: scripts/dev.sh {logs,status,stop}"
    return 0
  fi
  printf '\n'
  info "ReadFlow is already running (pid $pid)"
  printf '%s\n' \
    "  ${BOLD}1${OFF}) attach   follow that instance's logs here" \
    "  ${BOLD}2${OFF}) restart  stop it and start fresh from this terminal" \
    "  ${BOLD}3${OFF}) quit     do nothing"
  while :; do
    printf '  choice [1/2/3, default 1]: '
    IFS= read -r ans || ans=1
    case "$ans" in
      "" | 1) existing_action=attach; return 0 ;;
      2) existing_action=restart; return 0 ;;
      3) existing_action=quit; return 0 ;;
      *) printf '  (pick 1, 2 or 3)\n' ;;
    esac
  done
}

report_failure() {
  local which=$1 log=$2
  warn "$which did not come up — last log lines:"
  printf '\n'
  tail -n 20 "$log" >&2 2>/dev/null || true
  printf '\n'
}

# rotate_logs
# Archives the previous run's logs before a new run truncates them. Uses mv (not
# copy) because nothing else should still be writing to a log at this point, and
# only archives non-empty files so repeated failed starts do not pile up blanks.
rotate_logs() {
  local stamp name log stale stream
  stamp=$(date +%Y-%m-%dT%H-%M-%S)
  mkdir -p "$LOG_ARCHIVE_DIR"
  for name in api web; do
    log="$LOG_DIR/$name.log"
    [[ -s $log ]] || continue
    mv -f "$log" "$LOG_ARCHIVE_DIR/$name.$stamp.log"
  done
  # Keep only the newest LOG_RETENTION archives for each stream.
  for stream in api web; do
    while IFS= read -r stale; do
      rm -f -- "$stale"
    done < <(
      # shellcheck disable=SC2012  # archive names are generated by this script
      ls -1t "$LOG_ARCHIVE_DIR/$stream".*.log 2>/dev/null | tail -n +"$((LOG_RETENTION + 1))"
    )
  done
}

start() {
  mkdir -p "$LOG_DIR"

  local owner
  owner=$(already_running)
  if [[ -n $owner ]]; then
    choose_existing_action "$owner"
    case "$existing_action" in
      quit)
        info "leaving the running instance (pid $owner) alone"
        return 0
        ;;
      attach)
        trap - INT TERM EXIT
        info "attached to the running instance (pid $owner) — Ctrl-C ends only this view"
        follow
        return 0
        ;;
      restart)
        stop
        ;;
    esac
  fi

  api_pid=""
  web_pid=""
  pids=()

  # Preserve the previous run's output: truncating it made a past outage
  # impossible to diagnose. Archives live in .dev-logs/archive/.
  rotate_logs

  printf '\n'
  printf '  %sReadFlow%s %s· local dev%s\n' "$BOLD" "$OFF" "$DIM" "$OFF"
  preflight

  trap startup_signal INT TERM
  start_api
  start_web

  if ((${#pids[@]} == 0)); then
    trap - INT TERM
    warn "nothing started — see the messages above"
    rm -f "$STATE_FILE"
    return 0
  fi
  state_write

  local failed=0
  if ((!no_server)) && [[ -n $api_pid ]]; then
    if alive "$api_pid"; then
      wait_ready "api ready on $api_url" 60 api_ready || {
        failed=1
        report_failure api "$API_LOG"
      }
    else
      failed=1
      report_failure "api (exited immediately)" "$API_LOG"
    fi
  fi
  if ((!no_web)) && [[ -n $web_pid ]]; then
    if alive "$web_pid"; then
      wait_ready "web ready on $web_url" 60 web_ready || {
        failed=1
        report_failure web "$WEB_LOG"
      }
    else
      failed=1
      report_failure "web (exited immediately)" "$WEB_LOG"
    fi
  fi

  if ((failed)); then
    warn "stopping what did start"
    stop_pids "${pids[@]}"
    rm -f "$STATE_FILE"
    die "start failed — fix the error above and rerun scripts/dev.sh"
  fi

  local provider_txt="qwen (real Qwen3-TTS)" provider_shown="${BOLD}qwen${OFF} ${DIM}(real Qwen3-TTS)${OFF}"
  if [[ $provider == fake ]]; then
    provider_txt="fake (no model, instant)"
    provider_shown="${YEL}fake${OFF} ${DIM}(no model, instant)${OFF}"
  fi

  local api_plain="$api_url" web_plain="$web_url" api_txt="${C_OK}● up${OFF}  $api_url" web_txt="${C_OK}● up${OFF}  $web_url"
  if ((no_server)); then
    api_plain=skipped
    api_txt="${DIM}skipped${OFF}"
  elif ((api_foreign)); then
    api_plain="● up  $api_url (already running)"
    api_txt="${YEL}● up${OFF}  $api_url ${DIM}(already running)${OFF}"
  else
    api_plain="● up  $api_url"
  fi
  if ((no_web)); then
    web_plain=skipped
    web_txt="${DIM}skipped${OFF}"
  elif ((web_foreign)); then
    web_plain="● up  $web_url (already running)"
    web_txt="${YEL}● up${OFF}  $web_url ${DIM}(already running)${OFF}"
  else
    web_plain="● up  $web_url"
  fi

  # Only meaningful when this script started the web server: a foreign listener's
  # bind address is not ours to claim. The api needs no row of its own — LAN
  # clients reach it through Vite's proxy.
  local lan_plain="" lan_txt="" lan_addr
  if [[ -n $web_pid ]]; then
    lan_addr=$(lan_url "$web_host")
    if [[ -n $lan_addr ]]; then
      lan_plain="$lan_addr  (other devices)"
      lan_txt="${C_OK}${lan_addr}${OFF}  ${DIM}(other devices)${OFF}"
    fi
  fi

  box_open "ReadFlow dev · running"
  box_row "api" "$api_plain" "$api_txt"
  box_row "web" "$web_plain" "$web_txt"
  [[ -n $lan_plain ]] && box_row "network" "$lan_plain" "$lan_txt"
  box_row "provider" "$provider_txt" "$provider_shown"
  box_row "logs" ".dev-logs/" "${DIM}.dev-logs/${OFF}"
  box_close
  if ((!no_server)) && [[ $provider != fake ]]; then
    hint "the model loads on the first synthesis — watch the api log for progress"
  fi
  hint "commands: status · logs · stop · restart · test · lint · typecheck"

  if [[ ! -t 1 || $no_follow == 1 ]]; then
    trap - INT TERM
    info "running in the background — stop with: scripts/dev.sh stop"
    return 0
  fi

  trap cleanup INT TERM EXIT
  printf '\n'
  info "following logs — Ctrl-C stops api + web"
  follow
  return 0
}

stop() {
  local tracked=() pid p owner
  for pid in "$(state_get api_pid)" "$(state_get web_pid)"; do
    [[ -n $pid ]] && tracked+=("$pid")
  done

  if ((${#tracked[@]} == 0)); then
    info "no tracked processes (no $STATE_FILE)"
    for p in "$api_port" "$web_port"; do
      if port_open "$p"; then
        owner=$(port_owner "$p")
        warn "something still listens on :$p${owner:+ (pid $owner)} — not started by this script, leaving it alone"
      fi
    done
    return 0
  fi

  info "stopping pids: ${tracked[*]}"
  stop_pids "${tracked[@]}"
  rm -f "$STATE_FILE"
  ok "stopped"
  return 0
}

status() {
  local api_up=0 web_up=0 owner tr=""
  local s_api s_web
  s_api=$(state_get api_pid)
  s_web=$(state_get web_pid)
  port_open "$api_port" && api_up=1
  port_open "$web_port" && web_up=1

  # `owner` is whoever is listening; `tracked` is ours. They differ when the
  # port was already held by another process (or by vite's child of `bun run`).
  local api_plain web_plain api_txt web_txt api_note="" web_note=""
  if ((api_up)) && [[ -z $s_api ]]; then api_note=" (not started here)"; fi
  if ((web_up)) && [[ -z $s_web ]]; then web_note=" (not started here)"; fi
  if ((api_up)); then
    owner=$(port_owner "$api_port")
    api_plain="● up   $api_url${owner:+  pid $owner}$api_note"
    api_txt="${C_OK}● up${OFF}   $api_url${owner:+  ${DIM}pid $owner${OFF}}${api_note:+ ${DIM}${api_note# }${OFF}}"
  else
    api_plain="○ down $api_url"
    api_txt="${C_BAD}○ down${OFF} $api_url"
  fi
  if ((web_up)); then
    owner=$(port_owner "$web_port")
    web_plain="● up   $web_url${owner:+  pid $owner}$web_note"
    web_txt="${C_OK}● up${OFF}   $web_url${owner:+  ${DIM}pid $owner${OFF}}${web_note:+ ${DIM}${web_note# }${OFF}}"
  else
    web_plain="○ down $web_url"
    web_txt="${C_BAD}○ down${OFF} $web_url"
  fi

  local overall=stopped
  ((api_up || web_up)) && overall=running

  printf '\n  %sReadFlow%s %s· status%s\n' "$BOLD" "$OFF" "$DIM" "$OFF"
  box_open "ReadFlow dev · $overall"
  box_row "api" "$api_plain" "$api_txt"
  box_row "web" "$web_plain" "$web_txt"
  if ((web_up)) && [[ -n $s_web ]]; then
    local sw_host sw_lan
    sw_host=$(state_get web_host)
    sw_lan=$(lan_url "$sw_host")
    if [[ -n $sw_lan ]]; then
      box_row "network" "$sw_lan  (other devices)" "${C_OK}${sw_lan}${OFF}  ${DIM}(other devices)${OFF}"
    fi
  fi
  if [[ -n $(state_get provider) ]]; then
    local sp; sp=$(state_get provider)
    box_row "provider" "$sp" "${BOLD}$sp${OFF}"
  fi
  if [[ -n $s_api || -n $s_web ]]; then
    tr="api ${s_api:-—} · web ${s_web:-—}"
    box_row "script pids" "$tr" "${DIM}$tr${OFF}"
  fi
  box_close

  if ((!api_up && !web_up)); then
    hint "not running — start it with: scripts/dev.sh"
  elif [[ -n $s_api || -n $s_web ]]; then
    hint "stop it with: scripts/dev.sh stop"
  else
    hint "these ports are held by processes this script did not start"
  fi
  return 0
}

logs() {
  mkdir -p "$LOG_DIR"
  if [[ ! -f $API_LOG && ! -f $WEB_LOG ]]; then
    die "no logs yet — run 'scripts/dev.sh' first"
  fi
  if [[ -t 1 ]]; then
    info "tailing logs — Ctrl-C to stop"
    follow
  else
    info "not a terminal — showing the last lines of each log"
    tail_static
  fi
}

make_target() {
  local target=$1
  have make || die "make is required for '$target'"
  info "running ${BOLD}make $target${OFF}"
  printf '\n'
  make "$target"
}

usage() {
  awk 'NR == 1 { next } /^#/ { sub(/^# ?/, ""); print; next } { exit }' "$0"
  exit 0
}

# --- dispatch ----------------------------------------------------------------
cmd=start
args=("$@")
i=0
while ((i < ${#args[@]})); do
  a="${args[$i]}"
  case "$a" in
    start | up | stop | restart | status | logs | test | test-e2e | lint | typecheck | help | -h | --help)
      cmd="$a"
      ;;
    --fake) provider=fake ;;
    --real) provider=qwen ;;
    --localhost) web_host=localhost ;;
    --no-server) no_server=1 ;;
    --no-web) no_web=1 ;;
    --no-follow) no_follow=1 ;;
    --access-log) access_log=1 ;;
    -*) die "unknown option '$a' — try 'scripts/dev.sh help'" ;;
    *) die "unknown command '$a' — try 'scripts/dev.sh help'" ;;
  esac
  i=$((i + 1))
done

case "$provider" in
  qwen | fake) ;;
  *) die "DEV_PROVIDER must be 'qwen' or 'fake' (got '$provider')" ;;
esac

case "$cmd" in
  start | up) start ;;
  stop) stop ;;
  restart) stop && start ;;
  status) status ;;
  logs) logs ;;
  test) make_target test ;;
  test-e2e) make_target test-e2e ;;
  lint) make_target lint ;;
  typecheck) make_target typecheck ;;
  help | -h | --help) usage ;;
esac
