# ReadFlow: Postgres + multi-user + auth — implementation plan

Status: **approved plan, not yet implemented.** This document is the contract between
phases and between agents. If this file and the code disagree during implementation, stop
and fix whichever is wrong before continuing — do not silently diverge.

Audience: the executing agent team. Each phase lists its goal, its file ownership, its
acceptance criteria and its review gate. The main agent commits and pushes after every
phase, and **before starting the next phase** runs the review gate with an agent that did
not write that phase's code.

---

## 0. Locked decisions

| Area | Decision |
|---|---|
| Storage | Postgres 18 in a container, `postgresql+psycopg` (psycopg3) async driver, SQLAlchemy 2.0 **Core** + Alembic. **No ORM entities.** |
| Service layer | Fully async (services, repositories, memory adapter, all call sites, all tests). |
| Read model | `JobSummary` (flat job row) for list endpoints; aggregate (`Job` + chunks) only where real work happens; source text in its own `job_sources` row; derived numbers stored as rollups. |
| User model | Username + password (argon2id). No email, no SMTP. First user becomes admin; everything else is admin-created. |
| Sessions | Server-side sessions table, hashed token, HttpOnly + SameSite=Lax `(+Secure when HTTPS)` cookie, 30-day absolute / 7-day idle, rotation on login, revocation on logout/password change/disable. |
| Live events | Hub fans out per user (authenticated WS handshake); system/admin events go to admins only. No client-side filtering. |
| Admin reach | Admin manages users, config, model lifecycle, backups and sees queue/metric metadata for all jobs. **Chunk text and source text remain owner-only.** A database backup is the one artifact that contains everything, by definition; it is admin-only, written 0600, never logged. |
| Persistence | Jobs, folders, progress, trash and sessions persist. Rendered audio lives on a named volume and is kept until the user purges it. Startup reconciliation requeues interrupted chunks. |
| Time | Instants are stored **UTC** (`timestamptz`, connection pinned to `UTC`), carried as unix-epoch floats in the domain, exposed as **ISO-8601 with an explicit `Z`**, and rendered in the viewer's own timezone by the browser. Durations and positions stay `double precision` floats. |
| Dev modes | `scripts/dev.sh` uses `DATABASE_URL` from `.env` (auto-starting a Podman Postgres if the URL is local and nothing is listening); `--memory` runs the whole stack in memory. Memory adapter stays a first-class, tested mode. |
| Hardening (now) | argon2id, session rotation/expiry/revocation, generic login errors, per-IP+per-account login throttle, Origin/Host check on state-changing requests, admin-only registration, min 12-char passwords. Deferred: 2FA, email reset, audit log. |
| Backup | `pg_dump -Fc` (custom format). `scripts/backup.sh` for cron/systemd/quadlet timers, plus admin-only `GET /api/admin/backup` that streams a dump. Retention = keep N most recent. |
| TTS seam | Formalise `SynthesisProvider` as the engine contract; move Qwen-specific ids/knobs behind a provider module + model catalog. Adding an engine must not touch the scheduler, API or DB. |
| Tests | Adapter contract suite on real Postgres, rollup invariants, Hypothesis property tests, migration + security tests, query-budget guards, Playwright auth e2e. |

### Deliberately out of scope (do not build)

2FA/TOTP, email verification or reset, audit log, OAuth/OIDC, JWT, row-level security in
Postgres, read replicas, pgbouncer, WAL archiving, audio retention daemons, ORM, generic
repository base classes, an event bus, a DI container, a plugin system, per-user GPU
quotas, multi-node scheduling, deleting users (disable instead), Postgres extensions
beyond none.

### Simplicity rules that must survive the implementation

1. One adapter interface (`app/db/protocols.py`), two implementations. No abstraction above it.
2. Rollups live on the job row. There is no separate read-model table, no materialized view.
3. One auth module (`app/auth/`), one place that hashes, one place that sets cookies.
4. One place decides event routing (`WebSocketHub`); call sites only say *who*.
5. If a change needs a new concept to be explained, prefer changing the shape of the existing one.
6. Every derived value has exactly one writer. If two code paths can set it, that is a bug.

---

## 1. Target architecture

```
                    ┌──────────────────────────────────────────┐
 HTTP / WS  ───────►│ app/api/*  (thin translators, auth-gated) │
                    └───────────────┬──────────────────────────┘
                                    │ user-scoped services, built per request
                    ┌───────────────▼──────────────────────────┐
                    │ UserServices: jobs / library / progress / │
                    │ preferences   (all async, user_id bound)  │
                    └───────────────┬──────────────────────────┘
                                    │
   scheduler loop ──────────────────┤  system-scoped JobManager (user_id=None)
   (system scope)                   │
                    ┌───────────────▼──────────────────────────┐
                    │ app/db/protocols.py  (async Database/UoW) │
                    └───────┬───────────────────────┬──────────┘
                            │                       │
                 MemoryDatabase            PostgresDatabase
                 (dev / tests)             (containers, prod)
```

Three scopes, and they must not blur:

- **System scope** — the scheduler and worker. Sees every user's jobs, because one GPU
  serves the whole machine. Constructed once at startup.
- **User scope** — everything reachable from a request. Bound to the authenticated user at
  construction; a foreign id is indistinguishable from a missing one.
- **Content scope** — job source text and chunk text belong to their owner. Admin APIs may
  read plumbing (status, counts, priority, queue depth), never content.

---

## 2. Frozen interfaces

These are fixed in Phase 1 and other phases code against them. Signatures are async
(`async def`, `async with`) unless marked otherwise.

### 2.1 Domain: `app/jobs/models.py`

`ChunkRecord` is unchanged except one addition:

```python
@dataclass(slots=True)
class ChunkRecord:
    ...                       # existing fields unchanged
    @property
    def char_count(self) -> int: ...   # len(self.text)
```

`Job` changes:

```python
@dataclass(slots=True)
class Job:
    # identity / ownership
    id: str
    title: str | None
    source_kind: str
    user_id: str
    # source text is NOT on the aggregate any more; it lives in job_sources.
    source_char_count: int = 0
    ...
    # existing fields unchanged except source_text (removed) and rollups below
    written_seconds: float = 0.0          # sum of duration over live WRITTEN takes (gaps included)
    last_written_index: int | None = None # highest live WRITTEN index, else None
    unfinished_chunks: int = 0            # live takes in UNFINISHED_CHUNK_STATUSES
    unwritten_chars: int = 0              # sum of len(text) over live takes not WRITTEN
    pending_chunks: int = 0               # live takes, current plan_version, PENDING_CHUNK_STATUSES

    def summary(self) -> JobSummary: ...
    def apply_playback_report(self, position_seconds: float, is_playing: bool, now: float) -> None: ...
```

`apply_playback_report` is the exact body of today's `JobManager.update_playback` job-side
section: terminal jobs only track `is_active_listening`/`last_event_at`; otherwise set
position/playing/`last_event_at`, `completed_seconds = max(...)`,
`buffered_seconds = max(0, contiguous_written_seconds - position)`, and set
`is_active_listening = True` + status `PLAYING` when playing and not `PAUSED`.

`JobSummary` is a frozen, flat projection of the job row (no chunks, no source text):

```python
@dataclass(frozen=True, slots=True)
class JobSummary:
    id: str
    title: str | None
    status: JobStatus
    voice_id: str
    model_id: str
    language: str
    user_id: str
    folder_id: str | None
    position: int
    deleted_at: float | None
    trash_entry_id: str | None
    plan_version: int
    audio_epoch: int
    is_active_listening: bool
    render_to_end: bool
    submitted_at: float
    updated_at: float
    planner_cursor: PlannerCursor          # frozen copy
    next_chunk_index: int
    active_chunk_version: Mapping[int, int]
    buffered_seconds: float
    completed_seconds: float
    total_chunks_completed: int
    contiguous_written_seconds: float
    written_seconds: float
    last_written_index: int | None
    unfinished_chunks: int
    unwritten_chars: int
    pending_chunks: int
    source_char_count: int
    playback_state: PlaybackState          # frozen copy
    failed_reason: str | None
```

`Job.summary()` is generated from an explicit `SUMMARY_FIELDS` tuple so a renamed field
cannot silently disappear; a unit test asserts the tuple matches `JobSummary`'s dataclass
fields and that summary-derived answers equal job-derived answers on a rich fixture.

### 2.2 Rollup definitions (the only writer is `JobManager._refresh_derived`)

Computed over **live takes only** (`not chunk.deprecated`):

| Field | Definition |
|---|---|
| `total_chunks_completed` | count of `WRITTEN` |
| `contiguous_written_seconds` | durations from index 0 until the first non-`WRITTEN` (unchanged) |
| `written_seconds` | sum of `duration_seconds` over all `WRITTEN` (gaps included) |
| `last_written_index` | max index among `WRITTEN`, else `None` |
| `unfinished_chunks` | count with status in `UNFINISHED_CHUNK_STATUSES` |
| `unwritten_chars` | sum of `len(text)` for non-`WRITTEN` takes |
| `pending_chunks` | count with status in `PENDING_CHUNK_STATUSES` **and** `plan_version == job.plan_version` |

Remaining-audio estimate (pure function, no chunk access):

```python
def remaining_seconds(job_or_summary, heard_seconds: float, *, chars_per_second: float) -> float:
    unplanned = 0 if planner_cursor.exhausted else max(0, source_char_count - planner_cursor.offset)
    return max(0.0, written_seconds + (unwritten_chars + unplanned) / chars_per_second - heard_seconds)
```

This is numerically identical to today's per-chunk sum; a test pins old-vs-new on a fixture
with gaps, unwritten chunks and unplanned tail.

### 2.3 Progress: `app/library/models.py`

```python
@dataclass(slots=True)
class JobProgress:
    user_id: str
    job_id: str
    position_seconds: float = 0.0
    audio_epoch: int = 0
    heard: dict[int, int] = field(default_factory=dict)
    heard_seconds: float = 0.0        # NEW: sum of durations of currently-valid heard takes
    updated_at: float = field(default_factory=time)
```

`heard_seconds` is recomputed in the same transaction that changes `heard`, the epoch, or a
chunk's duration, so `remaining_seconds` stays exact without loading chunks.

### 2.4 Storage: `app/db/protocols.py`

```python
class UnitOfWork(Protocol):
    users: UserRepository
    sessions: SessionRepository
    folders: FolderRepository
    jobs: JobRepository
    sources: JobSourceRepository
    progress: ProgressRepository
    trash: TrashRepository
    async def commit(self) -> None: ...
    async def rollback(self) -> None: ...
    async def __aenter__(self) -> UnitOfWork: ...
    async def __aexit__(self, exc_type, exc, tb) -> None: ...   # commit on success, rollback otherwise

class Database(Protocol):
    def transaction(self) -> UnitOfWork: ...          # async context manager
    async def get_user(self, user_id: str) -> User | None: ...
    async def get_user_by_username(self, username: str) -> User | None: ...
    async def close(self) -> None: ...
```

Repository surface (user-scoped unless suffixed):

```python
class UserRepository(Protocol):
    async def add(user) ; async def save(user) ; async def get(user_id)
    async def get_by_username(username) ; async def list()

class SessionRepository(Protocol):
    async def add(session) ; async def save(session) ; async def get_by_token_hash(hash) -> Session | None
    async def delete(session_id) ; async def delete_for_user(user_id) ; async def list_for_user(user_id)

class FolderRepository(Protocol):
    async def add(f) ; async def save(f) ; async def get(user_id, folder_id, *, include_deleted=False)
    async def list(user_id, *, include_deleted=False) ; async def delete(user_id, folder_id)
    async def next_position(user_id, parent_id) -> int

class JobRepository(Protocol):
    # user scope
    async def add(job, *, source_text: str)                 # row + job_sources + chunks
    async def save(job)                                     # row + changed chunks (diffed)
    async def get(user_id, job_id, *, include_deleted=False) -> Job | None
    async def list(user_id, *, include_deleted=False) -> list[Job]
    async def summaries(user_id) -> list[JobSummary]
    async def source_text(user_id, job_id) -> str
    async def delete(user_id, job_id)
    async def next_position(user_id, folder_id) -> int
    # system scope (scheduler only; never reachable from a request handler)
    async def get_any(job_id, *, include_deleted=False) -> Job | None
    async def summaries_all() -> list[JobSummary]
    async def planned_chunks() -> list[ChunkRecord]
    async def rendering_chunks() -> list[ChunkRecord]
    async def source_text_any(job_id) -> str

class JobSourceRepository(Protocol):
    async def get(job_id) -> str | None
    async def put(job_id, text) -> None

class ProgressRepository(Protocol):
    async def add(p) ; async def save(p) ; async def get(user_id, job_id)
    async def list(user_id) ; async def delete(user_id, job_id) ; async def delete_many(user_id, job_ids)

class TrashRepository(Protocol):
    async def add(e) ; async def get(user_id, entry_id) ; async def list(user_id) ; async def delete(user_id, entry_id)
```

Documented semantics (the contract suite enforces all of them):

1. User scoping: every user-scoped lookup is `(user_id, id)`; foreign == missing.
2. Explicit writes: reads never write; mutations end in `add`/`save`/`delete`; `commit()` is
   the durability point.
3. Aggregate boundary: `Job` loads and saves together with its `ChunkRecord` list. Chunks are
   append-only; a superseded take is `deprecated`, never deleted. `save()` must persist only
   the entities whose fields changed.
4. Identity within a transaction: repeated reads of the same row return the same object, so
   services can mutate in place and save at the end.
5. Rollback: an exception inside `async with database.transaction()` leaves no structural
   change. Attribute-only edits are not rolled back — services validate before mutating.
6. Numbers are IEEE-754 doubles end to end (`double precision` in Postgres). **Instants are the
   exception**: they are `timestamptz` in Postgres and epoch-second floats in the domain. See
   §2.9 for the complete time contract.
7. `active_chunk_version` round-trips with integer keys (Postgres JSONB keys are strings;
   the adapter converts in both directions).

### 2.5 Schema: `app/db/schema.py` (SQLAlchemy Core `MetaData`)

Single source of truth for Alembic autogenerate. Eight tables.

Timestamps are `timestamptz` (instants, UTC — see §2.9); durations, positions, buffers and
windows are `double precision` (they are not instants and must never be timestamps).

```
users(id text pk, username text unique not null, display_name text not null,
      password_hash text not null, is_admin bool not null default false,
      is_active bool not null default true, created_at timestamptz not null,
      preferred_model_id text null, preferred_voice_id text null)

sessions(id text pk, user_id text not null references users(id) on delete cascade,
         token_hash bytea unique not null, created_at timestamptz not null,
         last_seen_at timestamptz not null, expires_at timestamptz not null)
  index sessions_user_id_idx (user_id)

folders(id text pk, user_id text not null, name text not null, parent_id text null
        references folders(id) on delete restrict, position int not null,
        created_at timestamptz not null, updated_at timestamptz not null,
        deleted_at timestamptz null, trash_entry_id text null)
  index folders_user_live_idx (user_id, deleted_at, parent_id, position)

jobs(id text pk, user_id text not null, title text null, source_kind text not null,
     source_char_count int not null, folder_id text null references folders(id) on delete restrict,
     position int not null, deleted_at timestamptz null, trash_entry_id text null,
     plan_version int not null, audio_epoch int not null, status text not null,
     is_active_listening bool not null, render_to_end bool not null,
     model_id text not null, voice_id text not null, language text not null,
     submitted_at timestamptz not null, updated_at timestamptz not null,
     planner_offset int not null, planner_chunks_emitted int not null,
     next_chunk_index int not null, active_chunk_version jsonb not null default '{}'::jsonb,
     buffered_seconds double precision not null, completed_seconds double precision not null,
     total_chunks_completed int not null, contiguous_written_seconds double precision not null,
     written_seconds double precision not null, last_written_index int null,
     unfinished_chunks int not null, unwritten_chars int not null, pending_chunks int not null,
     playback_current_time_seconds double precision not null,
     playback_is_playing bool not null, playback_last_event_at timestamptz not null,
     failed_reason text null)
  index jobs_user_live_idx (user_id, deleted_at, folder_id, position)
  index jobs_user_submitted_idx (user_id, submitted_at desc)

job_sources(job_id text pk references jobs(id) on delete cascade, text text not null)

chunks(job_id text not null references jobs(id) on delete cascade,
       index int not null, version int not null, text text not null,
       voice_id text not null, language text not null, plan_version int not null,
       char_start int not null, char_end int not null, status text not null,
       start_seconds double precision not null, duration_seconds double precision not null,
       segment_path text null, wav_path text null, error text null,
       parent_chunk_index int null, deprecated bool not null, reprocessing bool not null,
       attempts int not null, created_at timestamptz not null, updated_at timestamptz not null,
       primary key (job_id, index, version))
  index chunks_job_idx (job_id, index)
  index chunks_planned_idx (status) where status = 'planned'
  index chunks_rendering_idx (status) where status = 'rendering'

job_progress(user_id text not null references users(id) on delete cascade,
             job_id text not null references jobs(id) on delete cascade,
             position_seconds double precision not null, audio_epoch int not null,
             heard jsonb not null default '{}'::jsonb, heard_seconds double precision not null,
             updated_at timestamptz not null, primary key (user_id, job_id))

trash_entries(id text pk, user_id text not null, kind text not null, root_id text not null,
              name text not null, parent_id text null, job_count int not null,
              created_at timestamptz not null)
  index trash_user_idx (user_id, created_at desc)
```

`job_progress.user_id` references `users(id) on delete cascade`. `jobs.user_id` too.
`folders.parent_id` and `jobs.folder_id` use `on delete restrict` on purpose: moving and
trash semantics are service decisions, not cascade accidents.

### 2.6 Auth contract (`app/auth/`)

Payloads (all JSON, `snake_case`):

```jsonc
// User
{"id": "...", "username": "...", "display_name": "...", "is_admin": false, "created_at": 1.0}

// GET /api/auth/status            (public)
{"needs_setup": false, "authenticated": true, "user": {...} | null}

// POST /api/auth/setup            (public; 409 once a user exists)
{"username": "...", "password": "...", "display_name": "..."}  → 201 {"user": {...}} + cookie

// POST /api/auth/login            (public; 401 generic; 429 throttled)
{"username": "...", "password": "..."}                          → 200 {"user": {...}} + cookie

// POST /api/auth/logout           (auth; idempotent)             → 204
// GET  /api/auth/me               (auth)                         → 200 {"user": {...}}
// POST /api/auth/password         (auth) {current_password,new_password} → 204
//      revokes every OTHER session for that user

// admin only (403 otherwise)
GET    /api/admin/users                    → {"users": [User, ...]}
POST   /api/admin/users   {username,password,display_name,is_admin}  → 201 {"user": {...}}
PATCH  /api/admin/users/{id} {is_active?, is_admin?, display_name?, password?} → 200 {"user": {...}}
GET    /api/admin/backup                   → 200 application/octet-stream (pg_dump -Fc)
```

Cookie: name `readflow_session`, value = opaque token (`secrets.token_urlsafe(32)`), stored
server-side as `sha256(token)`. Flags: `HttpOnly`, `SameSite=Lax`, `Path=/`,
`Secure` when the request is HTTPS (or `READFLOW_COOKIE_SECURE=always`), `Max-Age` = absolute
expiry. Login rotates (deletes the presented session if any, creates a new one).

Auth failures: `401 {"detail": "Not authenticated"}` with `WWW-Authenticate: Session`;
never distinguishes unknown user from wrong password; unknown-user and bad-password paths
both perform an argon2 verify (dummy hash) so timing does not enumerate.

CSRF: for every non-GET/HEAD/OPTIONS request, if an `Origin` header is present its host must
match `Host` or be listed in `READFLOW_ALLOWED_ORIGINS` (comma separated; `.env` provides
`HOST_URL`). Missing `Origin` (curl, tests) is allowed. SameSite=Lax stays as the primary
defence.

Throttle: in-process sliding window keyed by `(client_ip, username_lower)`; 5 failures in
5 minutes → 429 with `Retry-After`, exponential up to 15 minutes. Single-instance only;
documented as such.

Passwords: `pwdlib[argon2]` (`PasswordHash.recommended()`), min 12 chars, max 1024,
verified with `verify_and_update` so parameters can be upgraded on login.

Sessions: `ABSOLUTE_SESSION_SECONDS = 30 days`, `IDLE_SESSION_SECONDS = 7 days`. A session is
valid when `now < expires_at` and `now - last_seen_at < idle`; `last_seen_at` is refreshed at
most once per 60 s per session to avoid a write per request.

Bootstrap: when `users` is empty, `GET /api/auth/status` reports `needs_setup: true` and only
`/api/auth/setup` and `/health` are reachable unauthenticated. `setup` is one transaction that
re-checks emptiness, so a race cannot create two admins.

### 2.7 Event routing (`app/core/hub.py`)

```python
class WebSocketHub:
    async def connect(websocket, *, user_id: str, is_admin: bool) -> None
    async def disconnect(websocket) -> None
    async def send_to_user(user_id: str, payload: dict) -> None
    async def broadcast_to_admins(payload: dict) -> None
```

Ownership table — call sites pass the owner; they never filter:

| Event | Recipients |
|---|---|
| `job_created`, `job_updated`, `chunk_ready`, `job_completed`, `job_progress`, `library_changed` | the job's `user_id` |
| `scheduler_state`, `memory_stats`, `model_state`, `telemetry` | admins |

`telemetry` is no longer sent to a socket on connect for non-admins; the admin view fetches
it over the (admin-gated) HTTP endpoint as it already does.

### 2.8 Provider seam (`app/synthesis/`)

- `SynthesisProvider` stays the contract (already a `Protocol`); add `PROVIDER_NAME: str`
  class attr and `capabilities` (supported languages/voices-model pairing if needed later).
- `app/synthesis/catalog.py`: `TTSModelSpec(model_id, display_name, kind="small"|"large",
  codec_tokens_per_second, supports_flash_attention, provider)`; `MODEL_CATALOG` and
  `get_model_spec(model_id)` replacing hardcoded `CODEC_TOKENS_PER_SECOND` / "small model"
  conditionals.
- `app/synthesis/registry.py`: `build_provider(settings) -> SynthesisProvider` selecting by
  `READFLOW_TTS_PROVIDER`; `provider.py` keeps `QwenProvider` + `FakeQwenProvider`.
- Rules: nothing outside `app/synthesis/` may import `qwen_tts`, torch, or reference a Qwen
  model id literal. `RuntimeConfig.default_model_id` reads from the catalog. Scheduler batch
  candidates are selected by `spec.kind`, not by string comparison.
- Test: a `ContractProvider` test asserts the fake provider satisfies every
  `SynthesisProvider` method (protocol conformance) and that `MODEL_CATALOG` covers every id
  referenced in `RuntimeConfig`/voices.

### 2.9 Time and timezone contract

One rule per layer, and no exceptions:

- **Storage is UTC.** Every instant column is `timestamptz`; the adapter opens its
  connections with `options=-c timezone=UTC`, so `psql`, `pg_dump` output and
  `pg_restore` all read as UTC regardless of the host's zone. The contract suite asserts
  `SHOW TimeZone` is `UTC`.
- **The domain carries instants as unix-epoch seconds (`float`)**, which are UTC by
  definition and carry no timezone state. They come from `app/core/time.utc_now()`; nothing
  outside that module calls `time.time()`. The adapter is the only layer that converts
  between epoch floats and `timestamptz` (`to_datetime` / `from_datetime`).
- **Intervals are not instants.** `time.monotonic()` stays for scheduler stalls, recovery
  backoff and throttle windows, and is never persisted. `duration_seconds`,
  `start_seconds`, `position_seconds`, `buffered_seconds`, `completed_seconds`,
  `contiguous_written_seconds`, `written_seconds`, `heard_seconds`, `*_timeout_seconds` and
  `*_tick_seconds` are durations/positions and stay floats. Only `*_at` names are instants.
- **The wire format is ISO-8601 with an explicit `Z`** for every instant
  (`2026-11-15T18:04:11Z`), never a bare number and never a zone-less string. Duration
  fields stay numbers. `app/core/time.to_iso()` is the only formatter.
- **The browser renders local time.** `web/src/lib/time.ts` exposes
  `formatDateTime(iso)` (`Intl.DateTimeFormat`, browser locale *and* zone — no explicit
  `timeZone`) and `formatAgeSeconds(n)` for relative ages. No `getUTC*`, no
  `.toISOString().slice()`, no `new Date("...")` on a zone-less string anywhere in `web/src`.
- **Server-side text is UTC**: log lines, backup filenames (`readflow-YYYYMMDDTHHMMSSZ.dump`)
  and any operator-facing output.
- Tests: the same stored instant round-trips identically while the process `TZ` is
  `Pacific/Kiritimati` and `UTC`; the API emits `Z`; the browser helper renders a different
  wall-clock string under a forced non-UTC zone (vitest `TZ`), and a Playwright spec with
  `timezoneId: "America/New_York"` proves an end-to-end local render.

---

## 3. Phases

Each phase ends with: `ruff check`, `ruff format --check`, `pyright`, `biome ci`, `pytest`,
`vitest run`, (e2e where relevant) all green, **the review gate**, one commit, one push.

### Phase 0 — scaffolding (serial, small)

Files: `Makefile`, `.env.example`, `.gitignore`, `scripts/diagnostics/hot_path_probe.py`,
this document.

- `scripts/diagnostics/hot_path_probe.py`: the measurement harness used to justify this plan.
  Builds services against the memory adapter with N jobs, wraps the database to count
  transaction/read calls and bytes, runs `run_once` N times, prints per-tick figures. Must be
  runnable with `uv run python scripts/diagnostics/hot_path_probe.py --jobs 8`.
- Makefile: `db-up`, `db-down`, `db-reset`, `migrate`, `test-db`, `test-fast`.
- `.env.example`: `DATABASE_URL`, `POSTGRES_USER/PASSWORD/DB`, `READFLOW_COOKIE_SECURE`,
  `READFLOW_ALLOWED_ORIGINS`, `HOST_URL`, `BACKUP_DIR`, `BACKUP_RETENTION`.
- Record baseline numbers in the PR description: per-tick transactions, full-aggregate loads,
  bytes read (today: ~680 transactions, ~670 aggregate loads, ~170 MiB/tick at 8×223 KB jobs).

Gate: probe runs; suite still green; no behaviour change.

### Phase 1 — domain, read model and the source split (serial, one writer)

Goal: the data model the rest of the work needs, with the memory adapter still in place.

Files: `app/jobs/models.py`, `app/library/models.py`, `app/library/progress.py`,
`app/library/playback.py`, `app/library/tree.py`, `app/db/models.py`,
`app/db/protocols.py`, `app/db/memory.py`, `app/jobs/manager.py`,
`app/jobs/recovery.py` (new), `app/library/progress_service.py`, `app/api/mappers.py`,
`app/schemas/api.py`, `app/schemas/library.py`, `app/api/router.py`, `app/core/app.py`,
`app/media/store.py`, `web/src/lib/api.ts`, tests.

1. `Job` loses `source_text`; gains `source_char_count` + the five rollups.
   `JobManager.create_job` computes `source_char_count` and writes the source through
   `uow.sources.put(job_id, text)`; `JobManager.source_text(job_id)` reads it back.
   `_refresh_derived` is the only writer of the rollups (formulas in §2.2).
2. `JobSummary`, `SUMMARY_FIELDS`, `Job.summary()`, `Job.apply_playback_report`.
3. `JobProgress.heard_seconds`; recomputed whenever heard marks, epoch or chunk durations
   change (`ProgressService` + `JobManager.mark_chunk_written` path via the progress row).
4. Pure derivations move to the summary-friendly shape: `progress.py` takes a
   `ProgressSource` protocol (fields from §2.1/§2.2) satisfied by both `Job` and
   `JobSummary`; `playback.py`/`tree.py` take `FolderJob` (id, folder_id, position,
   submitted_at, deleted_at, title, is_active_listening, contiguous_written_seconds).
   `estimated_remaining_seconds` is replaced by `remaining_seconds` (§2.2).
5. Read paths: `job_summaries_response`, `library_response`, `library.snapshot`,
   `job_detail_response`'s folder context use summaries. `job_to_summary(summary)`.
   `job_to_detail(job, source_text)` takes the text explicitly.
6. Playback single command: delete `JobManager.update_playback`, `POST /jobs/{id}/playback`,
   `PlaybackUpdateRequest`, and `api.updatePlayback` in `web/src/lib/api.ts`.
   `ProgressService.record(job_id, position_seconds, is_playing, heard_chunk_indexes)` is the
   single entry point: one transaction, `job.apply_playback_report`, progress merge, save both.
   Both the HTTP `/progress` route and the WS `playback_sync` message call it.
7. Startup recovery: `app/jobs/recovery.py` holds a **pure** plan function
   (`plan_startup_recovery(job, audio_exists) -> RecoveryPlan`) and
   `JobManager.recover_after_restart(audio_exists=None) -> RecoveryResult` applies it in one
   transaction per job. Rules: `RENDERING` → `PLANNED` (attempts unchanged); `WRITTEN` whose
   audio is missing → `PLANNED` with media paths/duration cleared; clear
   `is_active_listening`, `playback_state.is_playing`; `_settle_status`; `_refresh_derived`.
   Idempotent. Wired into the lifespan **before** the scheduler autostarts, with
   `MediaStore.chunk_files_exist` as `audio_exists`.
8. `MediaStore.chunk_files_exist(chunk) -> bool`.
9. Time contract (`app/core/time.py` + wire format):
   - New `app/core/time.py`: `utc_now() -> float`, `to_datetime(epoch) -> datetime`
     (always `timezone.utc`), `from_datetime(dt) -> float` (rejects naive datetimes),
     `to_iso(epoch) -> str` (always `...Z`), `from_iso(text) -> float`. Unit-tested under two
     different process `TZ` values to prove zone independence.
   - Replace the 56 `time()` call sites in `app/` with `utc_now()`. `monotonic()` call sites
     are untouched.
   - API schemas expose instants as ISO strings: `JobSummaryResponse`/`JobDetailResponse`
     times if present, `QueueBatch.started_at`, `SchedulerLiveness.last_tick_at`,
     `AdminQueueResponse.generated_at`, chunk `created_at`/`updated_at`, and
     `TrashEntryResponse.created_at` (`app/schemas/api.py`, `app/schemas/library.py`). Some
     already exist as floats; they all become `str`.
   - Browser side: new `web/src/lib/time.ts` with `formatDateTime(iso)` and
     `formatAgeSeconds(n)`; `TrashPage` uses `formatDateTime(entry.created_at)` (replacing
     `new Date(x * 1000).toLocaleString()`), `QueueInspector` parses `started_at` with
     `Date.parse` for elapsed time; `web/src/types/api.ts` timestamp fields become `string`.

Tests added (unit unless noted):
- `test_summary.py`: `SUMMARY_FIELDS` matches `JobSummary`; summary-derived and job-derived
  answers agree for progress fraction, read status, remaining seconds, folder ordering,
  upcoming warming; rollup invariants recomputed from chunks across a fixture with a gap, a
  reprocessed take, a take switch, a failed chunk and a voice change.
- `test_remaining_seconds.py`: new formula equals the old per-chunk sum on that fixture.
- `test_recovery.py`: crash simulation (RENDERING left behind), missing-audio case,
  idempotence, terminal jobs untouched, playback flags cleared.
- `test_progress_service.py`: single-transaction playback report (one `save` per entity,
  position/heard/`heard_seconds` consistent, terminal job freezes position).
- `test_time.py`: `utc_now` monotonic-ish sanity, ISO round-trip with `Z`, naive-datetime
  rejection, and identical results under `TZ=Pacific/Kiritimati` vs `TZ=UTC`.
- `web/src/lib/time.test.ts`: a fixed instant (`2026-11-15T18:04:11Z`) renders differently
  under `TZ=America/New_York` and `TZ=UTC`, and an ISO string with `Z` is required (a
  zone-less string is rejected or documented as unsupported).
- integration: `/progress` and WS `playback_sync` produce the same state; `/playback` is gone
  (404); reader detail still returns the exact source text.

Gate: existing 377 tests pass (adapted), plus the new ones. Probe must show that
`GET /api/library` no longer loads source text (assert via the counting wrapper).

### Phase 2 — async conversion (serial, mechanical, no behaviour change)

Goal: the entire service and storage layer becomes async so the Postgres driver can be async.

Files: `app/db/protocols.py` (async signatures), `app/db/memory.py`,
`app/jobs/manager.py`, `app/library/service.py`, `app/library/progress_service.py`,
`app/users/preferences.py`, `app/api/*`, `app/core/*`, `app/scheduler/service.py`,
`app/synthesis/*`, `tests/**`, `web/src/lib/api.ts` (unchanged shape).

Rules:
- `async with database.transaction() as uow:` everywhere; `MemoryUnitOfWork.__aenter__/__aexit__`.
- Memory repositories become `async def` wrappers over the existing synchronous bodies
  (do **not** add `asyncio.sleep(0)`; the contract suite must pass identically).
- Every service method becomes `async def`; every call site awaits. Pyright is the safety net —
  run it after each file group, not at the end.
- `renderable_chunks`/iterables: convert generators to `async def ... -> list[...]` returns.
  No async generators (they complicate cancellation and `async for`).
- Tests: `async def test_*` (pytest-asyncio auto mode already on); add `await` at ~416 call
  sites. Where a test used a helper built on a service, make the helper async too.
- Add `tests/unit/test_api_async.py`: iterates `app.routes` and asserts every non-public route
  dependency graph resolves to `UserServices` (structural guard against un-awaited or
  unauthenticated handlers).

Gate: full suite green; `hot_path_probe` still runs; no `async def`/`await` warnings under
`-W error::RuntimeWarning` (guards forgotten awaits that silently create dangling coroutines).

### Phase 3 — scheduler read model (serial)

Goal: one consistent read per scheduler pass; no N+1 job loads; one source read per job per
process lifetime.

Files: `app/scheduler/service.py`, `app/scheduler/source_cache.py` (new),
`app/jobs/manager.py` (read methods), `app/scheduler/recovery.py` (untouched),
`app/api/mappers.py`, `app/api/library.py`, `app/api/router.py`, tests.

1. `JobManager` gains `summaries()`, `summaries_all()`, `planned_chunks()`,
   `rendering_chunks()`, `source_text()` (cached), `source_text_any()`.
2. `app/scheduler/source_cache.py`: bounded LRU of immutable job source text, keyed by job id,
   budget in characters (`READFLOW_SOURCE_CACHE_CHARS`, default 64 MiB), evict-on-oversize,
   explicit `forget(job_id)` on delete/purge. Unit-tested for eviction and immutability.
3. `run_once` reads summaries **once** and threads them through: `_refresh_up_next`,
   `_ensure_planned_chunks`, `queue_depth` (sum of `pending_chunks`), `has_renderable_chunks`,
   `_rank_renderable_chunks`, `_active_batch`, `_broadcast_scheduler_state`. The
   freshness-sensitive broadcast after a batch rebuilds the summaries once.
4. `_ensure_planned_chunks` plans from `source_text(job.id)` and tracks the planned count
   locally (no re-read per added chunk). `_unplanned_chars` uses `source_char_count`.
5. `_ordered_for_dispatch`, `_group_chunks`, `_group_key`, `_choose_group_key`,
   `_select_next_batch` take an explicit `jobs: Mapping[str, JobSummary]`. **No `get_job`
   inside a sort key or generator.**
6. `expire_stale_listeners` selects candidates from summaries, then one transaction per
   affected job.
7. `queue_snapshot` uses summaries for job metadata; it may load aggregates for the jobs it
   displays (admin-only, bounded), documented in AGENTS.md as the one heavy read.
8. Delete now-dead helpers (`renderable_chunks` if unused, `list_jobs` if unused by API).

Tests:
- `test_scheduler_reads.py`: with a counting wrapper, a tick performs exactly one
  `summaries_all` (plus one refresh), one `planned_chunks`, one `rendering_chunks`, and no
  `source_text_any` beyond a planning job; **zero** `jobs.get` for jobs that need no write.
- Query-budget integration test: `GET /api/library` and `GET /api/jobs` issue a constant
  number of repository calls regardless of job count (3 and 10 jobs).
- Existing scheduler tests pass with summaries substituted.

Gate: probe numbers recorded before/after. Expected: transactions/tick from ~680 to ~15,
aggregate loads to 0, bytes read from ~170 MiB to <1 MiB (8 jobs).

### Phase 4 — parallel workstreams (after Phase 3 is green and pushed)

Three workstreams with disjoint file ownership. Each runs in its own worktree; the main agent
merges in the order A → B → C, running the full suite after each merge.

#### 4A — Postgres adapter (new files only)

Owns: `app/db/postgres/**` (new), `app/db/schema.py` (already added in Phase 1),
`alembic/**` (new), `alembic.ini`, `server/pyproject.toml`, `server/Dockerfile`,
`tests/contract/**`, `tests/unit/test_diff.py`, `tests/properties/test_diff_properties.py`,
`app/core/config.py` (database settings only).

- Dependencies: `sqlalchemy[asyncio]>=2.0`, `psycopg[binary]>=3.2`, `alembic>=1.13`; dev extra
  unchanged otherwise. **Do not touch torch/flash-attn pins.**
- `PostgresDatabase(url, *, pool_size=5, max_overflow=5, pool_pre_ping=True, echo=False)`:
  `create_async_engine`, `async_sessionmaker`. `transaction()` returns a `PostgresUnitOfWork`
  whose repositories share one `AsyncSession`.
- Identity map: per-UoW `dict[str, Job]`; `get`/`get_any` return the same instance on repeat.
- Dirty diff (`app/db/postgres/mapping.py`): on load, take a snapshot of each chunk's mutable
  fields; on `save(job)`, UPDATE only changed chunks, INSERT new ones, and UPDATE the job row.
  Pure function `changed_chunks(snapshot, chunks) -> (updates, inserts)` unit- and
  property-tested (Hypothesis: any random mutation sequence yields exactly the mutated rows).
- `active_chunk_version` JSONB: stringify keys on write, int them on read; tested.
- `heard` JSONB in progress: same conversion.
- Time conversion lives here and nowhere else: `to_datetime(epoch)` / `from_datetime(dt)` from
  `app/core/time.py`, applied to every `*_at` column. `options=-c timezone=UTC` on the engine.
  Contract assertions: `SHOW TimeZone` is `UTC`; an instant written and re-read is identical
  under a process `TZ` of `Pacific/Kiritimati`; epoch → `timestamptz` → epoch round-trips
  within 1µs (microsecond storage resolution is the only loss, and is asserted so it cannot
  silently become a second).
- `summaries`/`summaries_all`: one `SELECT` of job columns, no joins, no chunk access.
- `planned_chunks`/`rendering_chunks`: one joined `SELECT` (`chunks JOIN jobs`) filtered by
  status, `plan_version = jobs.plan_version`, `NOT deprecated`, `jobs.deleted_at IS NULL`,
  and (planned only) `jobs.status <> 'paused'`.
- `add(job, source_text)`: INSERT job + `job_sources` + chunks in one transaction.
- `source_text`/`source_text_any`: `SELECT text FROM job_sources WHERE job_id = $1`.
- Alembic: `alembic/env.py` uses `run_async_migrations` and `target_metadata = schema.metadata`;
  initial revision generated with `--autogenerate`, then hand-checked. `alembic upgrade head`
  is idempotent.
- Selection: `build_services` uses `DATABASE_URL` when set, else `MemoryDatabase`;
  `Settings.database_url: str | None = None`, `settings.is_postgres`.
- Contract suite: `tests/contract/test_database_contract.py` parameterised over
  `[MemoryDatabase, PostgresDatabase]`; Postgres runs only when
  `READFLOW_TEST_DATABASE_URL` is set (skip otherwise) with a `truncate_all` fixture between
  tests. Move the existing `tests/unit/test_db.py` semantics here and extend:
  user scoping, identity per transaction, rollback of structural writes, save-on-mutate,
  summaries equal to aggregate-derived values, source blob isolation, chunk version
  uniqueness, JSONB keys, a foreign user's job being indistinguishable from missing.
- Migration test: `alembic upgrade head` against an empty database then
  `alembic check`/autogenerate compares zero diffs; a second test upgrades a database
  created from the initial revision with seeded rows and asserts data survives.
- `test-serialization`: adapter round-trip of a rich aggregate (every field, unusual values:
  unicode text, empty chunks, negative offsets never, large ints) equals the original.

Gate: contract suite green on real Postgres and on memory; `make test` (no DB) still green.

#### 4B — auth backend

Owns: `app/auth/**` (new), `app/db/models.py` (User fields), `app/core/user_services.py` (new),
`app/api/auth.py`, `app/api/admin_users.py`, `app/api/deps.py` (new), `app/core/hub.py`,
`app/core/app.py`, `app/api/router.py` (dependency wiring + admin gating only),
`app/core/config.py` (auth settings only), `tests/unit/test_passwords.py`,
`tests/unit/test_throttle.py`, `tests/unit/test_auth_service.py`,
`tests/integration/test_auth_api.py`, `tests/integration/test_admin_api.py`,
`tests/integration/test_ws_routing.py`.

- `app/auth/models.py`: `Session`, `AuthError`, `RateLimited`, `SetupAlreadyComplete`.
- `app/auth/passwords.py`: `hash_password`, `verify_and_update(password, hash) -> (ok, new_hash)`,
  `DUMMY_HASH` for constant-time unknown-user path.
- `app/auth/throttle.py`: pure `LoginThrottle` with injectable `now`, `check(key)`,
  `record_failure(key)`, `record_success(key)`; bounded dict (drop expired entries).
- `app/auth/service.py`: `AuthService(database, settings, throttle)` —
  `is_setup_complete`, `setup_first_admin`, `authenticate`, `login` (create session, rotate),
  `resolve(token) -> CurrentSession | None` (validity + idle refresh throttle),
  `logout(token)`, `change_password(user_id, current, new)` (revokes other sessions),
  `list_users`, `create_user`, `update_user` (disable/reset revokes sessions).
- `app/auth/cookies.py`: `set_session_cookie(response, token, secure)`,
  `clear_session_cookie(response)`; secure from `request.url.scheme`/`X-Forwarded-Proto` or
  `READFLOW_COOKIE_SECURE`.
- `app/api/deps.py`: `get_services`, `current_session` (401), `current_user` (401 if
  inactive), `current_admin` (403), `user_services` (builds `UserServices` per request and
  caches it on `request.state`), `ensure_csrf(request)` used by a small middleware or
  dependency for state-changing methods.
- `app/core/user_services.py`: `UserServices` dataclass + `build_user_services(app, user)`;
  `AppServices` loses `current_user/job_manager/library/progress/preferences` and gains
  `scheduler_jobs` (system-scoped `JobManager`), `auth`.
- Scheduler/worker construction uses `scheduler_jobs = JobManager(database, user_id=None)`.
- Every existing router endpoint gains `user: UserServices = Depends(user_services)` and uses
  `user.jobs/...`; admin endpoints gain `Depends(current_admin)`; media segment/peaks/download
  routes stay user-scoped (cookie auth is enough for MSE and `fetch`).
- Hub becomes per-user (§2.7); every broadcast call site passes the owner (job's `user_id`) or
  `broadcast_to_admins`. WS endpoint resolves the session at handshake, closes `1008`
  otherwise, and dispatches `playback_sync` through the connection's `UserServices`.
- `app/core/app.py`: lifespan runs `recover_after_restart`, builds `AuthService`, starts the
  scheduler; `GET /health` stays public. Non-auth routes are unreachable without a session.
- Settings: `cookie_secure: Literal["auto","always","never"]`, `allowed_origins: str = ""`,
  `session_absolute_seconds`, `session_idle_seconds`, `login_throttle_*`,
  `allow_registration: bool = False` (registrations are admin-only regardless).

Tests: password hashing (round-trip, rehash-on-login, min length), throttle (window, lockout,
reset on success, bounded memory), service (setup race, rotation, expiry absolute+idle,
revocation on logout/disable/password change, disabled user cannot log in, no enumeration),
API (status codes for every route with/without session, admin 403 matrix, CSRF origin
mismatch, cookie flags incl. Secure under `X-Forwarded-Proto`), WS (reject without cookie,
per-user event isolation with two connected clients, admin-only events), structural test that
every non-public route has an auth dependency.

Gate: full suite; the 401/403 matrix test enumerates **all** routes (fails if a new route
forgets auth).

#### 4C — frontend auth (web only)

Owns: everything under `web/` **except** `web/src/lib/api.ts`'s download/credentials edit if
4B needs it (coordinate in the phase kickoff; default: 4C owns `web/**` entirely).

- Time rendering: every new screen uses `web/src/lib/time.ts` (created in Phase 1); no
  screen formats a timestamp itself.
- `web/src/app/auth/` (new): `auth-store.ts` (zustand slice or external store),
  `useAuth.ts`, `AuthGate.tsx`, `LoginPage.tsx`, `SetupPage.tsx`, `ChangePasswordDialog.tsx`,
  `UserMenu.tsx`, `AdminUsersTab.tsx` (rendered inside `AdminPage`).
- `App.tsx`: routes `/login` and `/setup` unauthenticated; everything else behind `AuthGate`
  (renders a splash while `GET /api/auth/status` resolves, redirects to `/login?next=...`,
  returns to `next` after login); `/setup` only when `needs_setup`. `/admin` additionally
  requires `is_admin` (redirect home otherwise).
- `lib/api.ts`: `credentials: "same-origin"`, central 401 handler that clears the auth store
  and navigates to `/login` (except `/api/auth/login|status|setup`), plus the new auth/admin
  calls, `logout`, `changePassword`, `adminUsers`, `downloadBackup`.
- `lib/live-client.ts`: connect only when authenticated; treat close code `1008` as
  unauthenticated (no reconnect loop); reconnect with backoff otherwise.
- Navbar: `UserMenu` (display name, Change password, Log out); Admin tab hidden for non-admins.
- Download button and peaks/segment fetches keep same-origin credentials (they are `fetch`
  calls; do not switch to a bare `<a download>` for the authenticated media routes).
- Reader: a 401 during playback clears the player and returns to login without a crash;
  `MiniPlayer` hides when logged out.
- Tests (vitest): auth store transitions, gate redirect + `next` handling, login form errors
  (generic message), setup flow, admin gating, 401 interceptor.
- e2e (Playwright): `e2e/auth.spec.ts` — first-run setup, login/logout, bad password, guard
  redirect, deep-link return, change password revokes other sessions (two contexts), admin
  gating, backup download link presence. `e2e/helpers/session.ts` provides `loginAs()` and
  every existing spec authenticates in `beforeEach` via that helper.
- e2e (Playwright, timezone): a context with `timezoneId: "America/New_York"` opens the trash
  page (or any screen with an absolute time) and asserts the rendered string equals the
  expected *local* wall clock for a server-provided instant, and differs from the UTC
  rendering. This is the only test that can prove the `Z` → local chain end to end.

Gate: existing 27 Playwright tests pass with authentication wired in; new auth spec green.

### Phase 5 — containers, dev stack, backup (serial, needs 4A + 4B)

Files: `compose.yml`, `compose.cpu.yml`, `.env.example`, `scripts/dev.sh`, `scripts/backup.sh`
(new), `server/Dockerfile`, `server/docker-entrypoint.sh` (new), `web/Dockerfile`,
`deploy/quadlet/` (new, docs + example units), `README.md`, admin backup UI in
`web/src/features/admin/AdminPage.tsx`.

- `compose.yml`: `pg` (`docker.io/library/postgres:18`, named volume `pgdata`,
  `POSTGRES_*` from `.env`, `pg_isready` healthcheck, no published port by default), `api`
  (build `./server`, `depends_on: pg: condition: service_healthy`, volume `media`, env
  `DATABASE_URL=postgresql+psycopg://...@pg:5432/readflow`), `web` (build `./web`, depends on
  api). Named volumes `pgdata`, `media`. `api` gets `READFLOW_COOKIE_SECURE` and
  `READFLOW_ALLOWED_ORIGINS` from `.env`.
- `server/Dockerfile`: add `postgresql-client` (for `pg_dump`) and `libpq` runtime deps; copy
  `alembic.ini` + `alembic/`; entrypoint runs `alembic upgrade head` then `uvicorn`.
  Keep the multi-target cuda/cpu structure and the flash-attn wheel logic untouched.
- `scripts/dev.sh`: `DATABASE_URL` from `.env`; `--memory` forces `MemoryDatabase`;
  if `DATABASE_URL` points at localhost and the port is closed, start a Podman `pg` container
  named `readflow-dev-pg` with a named volume, wait for readiness, run `alembic upgrade head`,
  and remember it for `stop`/`status`; `status` prints DB mode + reachability; `stop` leaves
  the pg container alone unless `--with-db`.
- `scripts/backup.sh`: `pg_dump -Fc` via `podman exec` (compose) or direct URL, `0600`, into
  `$BACKUP_DIR` with timestamped names, retention `$BACKUP_RETENTION` (default 14), no secrets
  in argv/logs (`PGPASSWORD` env), exit non-zero on failure, prints one summary line.
- Admin backup endpoint (§2.6) implemented with `asyncio.create_subprocess_exec`, streamed to
  a temp file then `FileResponse`; 503 with a clear message when `pg_dump` is absent; audit log
  line without content.
- Quadlet example units (`readflow-api.container`, `readflow-web.container`,
  `readflow-pg.container`, plus `readflow-backup.timer/.service`) documented in README, not
  wired into CI.
- Docs: restore procedure (`pg_restore -d readflow --clean`), volume layout, what a backup
  contains and who may take one.

Gate: `podman compose up -d` brings up three healthy containers; a job created in the UI
survives `podman compose restart api`; backup file restores into a scratch database; full test
suite and e2e green.

### Phase 6 — docs and final verification (serial)

- `AGENTS.md`: rewrite the storage section (async protocols, read model, rollups, scope
  rules), add auth/session/security section, event routing table, Postgres adapter notes
  (identity map, dirty diff, JSONB keys, double precision), backup/restore, dev modes,
  container topology, and a "sharp edges" list. Delete superseded claims (no database, no
  auth, no accounts, no persistent jobs).
- `README.md`: quickstart with compose, env vars, first-run setup, backups, restore, quadlet.
- Final verification: `make test`, `make lint`, `make typecheck`, `bun run test:e2e`,
  contract suite on real Postgres, probe numbers, a manual real-stack pass (create job →
  listen → restart api → resume → backup → restore), and a `git log` check that each phase is
  one reviewable commit.

---

## 4. Test strategy (the bar)

Layers, all required:

1. **Adapter contract** — one parametric suite, both adapters, real Postgres in CI. Every
   protocol semantic in §2.4. Foreign-user == missing, identity per transaction, structural
   rollback, save-on-mutate, summaries equal aggregate-derived values, source text isolation,
   dirty-diff exactness, JSONB key round-trip.
2. **Rollup invariants** — recompute every stored rollup from chunks and compare; fixtures
   cover gap, reprocess, take switch, voice change, failure, unplanned tail.
3. **Property tests (Hypothesis)** — planner tiling (no gaps/overlaps, cursor monotonic),
   reorder/move validation, dirty diff (random mutation sequences), `remaining_seconds`
   monotonic under appending audio, session expiry arithmetic.
4. **Migrations** — upgrade from empty is a no-op against `--autogenerate`; upgrade with data
   preserves it; downgrade path documented (not necessarily supported).
5. **Security** — argon2 round-trip + rehash, throttle windows, session absolute/idle expiry,
   rotation, revocation (logout, password change, disable), no user enumeration, cookie flags
   (HttpOnly/SameSite/Secure under proxy), CSRF origin rejection, 401/403 matrix generated
   from `app.routes`, WS handshake rejection, per-user event isolation.
6. **Query budget** — constant repository-call counts for `/api/library`, `/api/jobs`, a
   scheduler tick and a reader detail, independent of library size. This is the regression
   guard for the whole read-model effort.
7. **Frontend** — vitest for auth store/gate/forms; Playwright for setup/login/logout/guard/
   deep-link/admin gating/session revocation, with `loginAs()` used by every existing spec.
8. **End-to-end with the fake provider** — the documented real-stack pass, extended with
   restart-then-resume and backup/restore.
9. **Time** — the same instant round-trips under two process `TZ` values; `timestamptz`
   columns read as UTC from `psql`; every API instant ends with `Z`; the browser helper and a
   `timezoneId` Playwright context render local wall-clock time. A structural test walks the
   generated OpenAPI schema and asserts **every** field whose name ends in `_at` is
   `type: string, format: date-time` — so a future endpoint cannot ship a bare epoch number.

Rules:

- No test may depend on another test's data; every suite resets settings and stores in
  `beforeEach` (`resetReaderSettings`, `usePlayerStore`, auth store).
- Async tests must not leak sessions/tasks: after each test assert no pending task warnings
  (`-W error::RuntimeWarning`) and close the database in fixtures.
- The Postgres suite is skipped (not failed) without `READFLOW_TEST_DATABASE_URL`, and CI sets
  it from a `postgres:18` service container with a healthcheck.
- Every bug found during review gets a regression test **in the same phase**, referencing the
  behaviour, not the file.

---

## 5. Review gate (run before starting the next phase)

The reviewer is an agent that did not write the phase. It must:

1. Read every diff hunk. For each: is this the simplest way, and does it match the plan?
2. Check the sharp edges list below against the diff.
3. Run the full required checks itself (not trust the author's output): ruff, format, pyright,
   biome, pytest, vitest, e2e where relevant, contract suite when Postgres is available.
4. Run `scripts/diagnostics/hot_path_probe.py` and compare against the recorded baseline.
5. Exercise behaviour the tests might miss: wrong-user access, double-click/login race,
   disabled user with a live socket, refresh during a session boundary, delete a job while a
   batch is in flight, pause → restart → resume, backup while a batch renders.
6. Write findings as a numbered list; the main agent fixes them, re-runs the gate, and only
   then commits and moves on. **A phase is not done because tests pass.**

### Sharp edges to check specifically

- Awaited everything? No dangling coroutines (`RuntimeWarning`), no sync call left on a
  service.
- Every mutation ends with `save()`/`add()`/`delete()`; nothing relies on SQL implicit flush.
- Rollups: exactly one writer, recomputed where chunks/durations change, and `heard_seconds`
  kept consistent with `heard` and `audio_epoch`.
- `JobSummary` and `Job` cannot drift (SUMMARY_FIELDS test still meaningful).
- Scope leaks: no system-scoped manager reachable from a route; foreign ids 404; media routes
  owner-checked; WS events only to the owner; admin APIs never return chunk/source text.
- JSONB integer keys; `double precision` everywhere a float is stored; no `real`/`numeric`
  rounding surprise.
- Time: every `*_at` column is `timestamptz` and every duration is `double precision`; no
  naive `datetime` reaches the adapter (`from_datetime` rejects it); no `time.time()` outside
  `app/core/time.py`; no `monotonic()` value is ever persisted; every API instant ends in
  `Z`; no frontend code renders a raw timestamp or uses `getUTC*`/`toISOString().slice()`.
- Sort keys/generators: no repository call inside a loop, comparator, or comprehension.
- Alembic revision matches `app/db/schema.py` exactly; `alembic upgrade head` is idempotent.
- Cookie flags under HTTP and HTTPS; logout clears the cookie **and** the session row;
  password change revokes other sessions; disable revokes all.
- CSRF origin check does not break the Vite dev proxy or the reverse proxy (`HOST_URL`,
  `READFLOW_ALLOWED_ORIGINS`), nor curl/tests (absent `Origin`).
- Migration/restore path: `pg_restore` into a scratch DB actually yields a login-able app.
- Docs tell the truth after every phase (AGENTS.md is part of the deliverable, not an
  afterthought).

---

## 6. Recorded baseline (phase 0 evidence)

Memory adapter, 8 jobs × 223 KB source, steady state, 200 ms tick:

- transactions/tick ≈ **680**
- `jobs.get` (full aggregate) calls/tick ≈ **669** — dominated by `get_job` inside sort keys
  (`scheduler/service.py:488, 509, 602, 657`)
- `jobs.list` calls/tick ≈ **11**
- source text + chunk records re-materialised/tick ≈ **170 MiB**

Target after Phase 3: <20 transactions/tick, 0 `jobs.get` reads on the tick path, 1
`summaries_all`, 1 `planned_chunks`, 1 `rendering_chunks`, <1 MiB read.

---

## 7. Commit convention

One commit per phase, prefixed with the phase:

```
phase1: domain read model, source split, playback command, startup recovery
phase2: async storage seam and services
phase3: scheduler read model (one summary read per pass)
phase4a: postgres adapter, schema, migrations, contract suite
phase4b: auth backend, per-user services, event scoping
phase4c: frontend auth surface
phase5: three-container stack, dev orchestration, backups
phase6: documentation and final verification
```

The main agent commits and pushes after each phase's review gate passes. No phase may be
pushed with a red check, a skip added to silence a failure, or a "temporary" workaround that
is not listed in this plan.

## 8. Open items deliberately deferred

- 2FA, email verification/reset, audit log, active-session UI.
- Audio retention/size caps (documented as "keep until purged" for now).
- Multi-node scheduling, per-user GPU quotas, fairness beyond the existing turn-taking.
- Windowed source reads (the source cache covers current scale; revisit above ~64 MiB of
  cached text).
- Deleting users; disable instead. Data orphan cleanup is a documented ops task.
