# Library: folders, playlists, read progress, and a persistent player

Status: **M1–M6 implemented** (feature complete)
Date: 2026-11-06

## Context

Two gaps drive this work:

1. **There is no library.** The jobs page is a flat list, jobs cannot be grouped,
   ordered, or played as a sequence, and there is no way to continue a listening
   session after a reload.
2. **All server state is ad-hoc in-memory.** `JobManager` owns dicts of jobs and
   chunks; there is no user, no storage abstraction, and nothing that can be
   swapped for Postgres without rewriting the scheduler.

This plan adds a **library** on top of a **database-shaped storage layer**. The
storage layer runs entirely in memory today, behind repository interfaces, so
Postgres (and a real account system) can be dropped in later without touching
call sites. Every piece of data that will eventually be per-user is stored with
a real `user_id` from day one.

The design is deliberately shaped around four product intents:

- **One concept**: a *folder* is an ordered, nestable, playable group. There is
  no separate "playlist" concept.
- **Control without clutter**: listening state is visible everywhere, but the
  reader stays quiet until you ask for more (menus, bulk actions).
- **Continuous listening**: playback survives navigation, and a folder advances
  itself when a job ends.
- **Cheap to port**: one storage seam, one progress model, no local-first sync
  engine, no ORM.

## Decisions (from the design interview)

### Library model

- **Folders are the only grouping concept.** Ordered, nestable, and playable.
  "Playlist" is not a separate noun; pressing Play on a folder is the playlist.
- **Single parent.** A job lives in exactly one folder. `folder_id = NULL` means
  the root library.
- **Nested folders are organization, not traversal.** A folder's Play action
  plays only its **direct job children**, in their manual order. Sub-folders are
  always rendered at the top of the folder and are never auto-played.
- **Manual order is the order.** Folders and jobs each have their own
  `position`; the UI always shows folders first, then jobs.
- **One "Organize" mode** in a folder enables drag handles, row checkboxes, and
  the bulk action bar. Normal mode is navigation only. This replaces separate
  "edit" and "select" modes.
- **Bulk multi-select** (shift-click ranges, select all) with Move to…,
  Mark read, Mark unread, and Delete.
- **Trash** (soft delete) protects against mistakes: deleting a folder trashes
  its whole subtree as one restore unit, and deleting a job trashes that job.
  Restore puts it back where it was. Trash also supports multi-select Restore /
  Delete forever / Empty trash. A "Delete folder only" action moves children to
  the parent when you want to keep them.
- **Delete is the last item in a row's ⋮ menu**, confirmed by an undo toast
  (trash) rather than a modal.
- **Search + state filter** in the library panel: title search across folders
  and jobs, and All / Unread / In progress / Read. Manual order is preserved;
  filters only narrow the view.
- **New jobs are created into the currently selected folder** (root included)
  at the end of its job order. Job and folder titles are editable from ⋮.
- **Library replaces the Jobs page** at `/`; folders live at `/library/:folderId`.
  The reader keeps `/jobs/:jobId`.
- **Identity**: a seeded default `users` row (`local`) and a `user_id` foreign key
  on every stored entity. A `current_user` dependency resolves it today and
  becomes real auth later.

### Listening state

- **Per-chunk heard flags** are the only source of truth. A chunk becomes heard
  when **real playback** crosses ~90 % of it. Seeking over it does not count.
- **Job progress** = `(highest heard chunk index + 1) ÷ emitted chunk count`.
  The bar never claims more than the ✓ marks show.
- **Job read status**:
  - `read` — the **last playable chunk** (highest emitted index that has audio)
    is heard **and** the planner has finished emitting chunks for the job;
  - `unread` — no chunk heard and no position recorded;
  - `in progress` — everything else.
  A failed or unrendered middle chunk never blocks completion.
- **Mark read** marks every chunk heard and moves the position to the end.
  **Mark unread** clears every heard flag and resets the position. No override
  field, no precedence rules.
- **Per-chunk controls**: a ⋮ in each chunk header (Jump here, Mark heard /
  unheard, Mark from here heard / unheard, Retry when failed), plus bulk actions
  in the reader header.
- **Progress is stored server-side only** (no localStorage mirror). The reader's
  initial detail fetch includes progress, so there is no position flash. A
  backend restart loses progress exactly like it loses the jobs it describes.

### Playback and advance

- **Playback survives navigation.** The player is lifted above the router; a
  mini-player (title, play/pause, ±10 s, progress, click to open reader) appears
  on library and admin pages.
- **Auto-advance** when a job reaches its end: if the job has a parent folder and
  continuous play is on, open the folder's next job in order, restore its
  position, and start playing. If it is not rendered yet, the normal
  "preparing stream / waiting for GPU" states carry it.
- **Strict order.** Auto-advance replays jobs already marked read. "Play folder"
  starts at the first job that is not fully read (at that job's position) — a
  deliberate asymmetry: start where you left off, then follow the order you set.
- **End of folder** stops with an "End of <folder>" card (Replay / Back to
  library). Root jobs have no auto-advance.
- **Up next chip** in the playbar with a continuous-play toggle, and a
  "Jump to next/previous job" stepper (`‹ Job 3 of 8 ›`, `[` / `]`). Both are
  isolated components so the placement can change after real use.
- **Scheduler warming**: while a folder is playing, the folder's *next* job is
  marked up-next and rendered in the medium priority band until it has
  `up_next_prebuffer_seconds` (default 120 s) of contiguous audio. This makes the
  transition a short gap instead of a stall.
- **Repeat** is explicitly out of scope for this round.

### Out of scope

Postgres adapter, real auth/accounts, multi-user sharing, local-first/offline
sync, folder repeat/loop, archive, server-side pagination, drag between library
and reader, and any model/voice/scheduler behavior not listed above.

## Architecture

### 1. Storage seam (`server/app/db/`)

```
server/app/db/
  __init__.py
  unit_of_work.py   # UnitOfWork + Transaction protocols
  repositories.py   # repository protocols (folders, jobs, chunks, texts,
                    # progress, heard, trash, users)
  memory.py         # MemoryDatabase: tables + deep-copy semantics + version stamp
  seed.py           # default user
```

- **Rows are the existing domain dataclasses.** `Job`, `ChunkRecord` and the new
  `Folder`, `JobProgress`, `TrashEntry`, `User` are plain Python objects.
  Repositories own serialization; there is no ORM and no duplicate "row" model.
- **Unit of work, explicit writes.** Handlers do:

  ```python
  with database.transaction() as uow:
      job = uow.jobs.get(user_id, job_id)
      job.status = JobStatus.RENDERING
      uow.jobs.save(job)
      uow.chunks.save(chunk)
  ```

  Reads inside a transaction see its own staged writes; `commit()` applies all
  staged writes; an exception discards them. This is the semantics Postgres will
  have, so the call sites do not change.
- **Deep-copy semantics in memory.** `get()` returns a detached copy and `save()`
  stores a copy, so an un-saved mutation is *lost* today exactly as it would be
  with a real database. A repository **contract test suite** runs against any
  adapter, so the Postgres adapter reuses every guarantee.
- **A job is one aggregate** (`uow.jobs.get/add/save/delete`): the job and its
  chunk list are loaded and saved together, and the adapter owns the storage
  strategy (one row now; a child table with diffed writes when it matters).
  This keeps call sites free of chunk-level persistence details and avoids a
  second source of truth for the chunk list.
- **`Job.source_text` stays on the aggregate for now.** It is immutable after
  creation, so a SQL adapter can move it to its own TOAST column/table without
  touching call sites; doing that split before there is a SQL adapter would add
  a hydration path for no present benefit.
- **`JobManager` keeps its behavior and becomes a command service over the
  unit of work.** Every public method opens a transaction. `SchedulerService`
  gets a read-model helper that loads the renderable jobs in one transaction.
- **Per-user state is real.** Playback becomes a `PlaybackRegistry`
  (`user_id → {job_id, position, is_playing, updated_at}`) instead of the
  job-level `is_active_listening` boolean, which becomes derived
  (`any listener on this job`). Expiry moves with it
  (`active_listener_timeout_seconds` unchanged).

### 2. Schema (as it will exist in Postgres)

```sql
users(id, display_name, created_at)

folders(
  id, user_id, parent_id NULL, name, position,
  created_at, updated_at, deleted_at NULL
)

jobs(
  id, user_id, folder_id NULL, title, position,
  status, model_id, voice_id, language, plan_version, audio_epoch,
  render_to_end, submitted_at, updated_at, deleted_at NULL,
  -- everything already on Job except source_text and chunks
)

-- job_texts(job_id PK, text)  — deferred; see the aggregate note above

chunks(
  job_id, index, version, text, voice_id, plan_version,
  char_start, char_end, status, start_seconds, duration_seconds,
  segment_path, wav_path, error, parent_chunk_index,
  deprecated, reprocessing, attempts, created_at, updated_at,
  PRIMARY KEY (job_id, index, version)
)

job_progress(
  user_id, job_id, position_seconds, updated_at,
  PRIMARY KEY (user_id, job_id)
)

chunk_heard(
  user_id, job_id, chunk_index, heard_at,
  PRIMARY KEY (user_id, job_id, chunk_index)
)

trash(
  id, user_id, kind ('folder' | 'job'), root_id, name,
  parent_id NULL, item_count, created_at
)
```

Indexes to note now (they are cheap in memory and free in Postgres):
`folders(user_id, parent_id, position)`, `jobs(user_id, folder_id, position)`,
`chunks(job_id, index)`, `chunk_heard(user_id, job_id)`.

Rules:

- `position` is a per-parent integer order. Reordering writes a dense sequence
  in one transaction (folders and jobs reorder independently).
- Moving a folder into its own descendant is rejected with 422.
- A trashed folder marks its whole subtree `deleted_at` and creates **one**
  trash entry. Restore clears the subtree's `deleted_at`; permanent delete
  removes it and frees media.
- Trashed jobs are excluded from dispatch (rendering stops) but keep their
  rendered audio so Restore is instant. `DELETE forever` calls
  `MediaStore.remove_job`.

### 3. Read model and API

New/changed endpoints (all user-scoped through `current_user`):

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/library` | Flat snapshot: folders, job summaries, trash count |
| `POST` | `/api/folders` | Create folder `{name, parent_id}` |
| `PATCH` | `/api/folders/{id}` | Rename, move, or set position |
| `PATCH` | `/api/jobs/{id}` | Rename, move, or set position |
| `POST` | `/api/library/reorder` | `{parent_id, folder_ids, job_ids}` |
| `POST` | `/api/library/move` | `{items: [{kind, id}], folder_id}` |
| `POST` | `/api/library/delete` | Trash `{items}` (subtree semantics) |
| `POST` | `/api/library/read` | `{items, read}` bulk mark |
| `GET` | `/api/trash` | Trash entries |
| `POST` | `/api/trash/restore` | `{ids}` |
| `POST` | `/api/trash/purge` | `{ids}` or `{empty: true}` |
| `POST` | `/api/jobs/{id}/progress` | `{position_seconds, is_playing, heard_chunk_indexes}` |
| `POST` | `/api/jobs/{id}/read` | `{from_chunk?, read}` (whole job or from a chunk) |
| `POST` | `/api/jobs/{id}/chunks/{i}/heard` | `{heard}` |
| `DELETE` | `/api/jobs/{id}` | Move to trash (204), kept for compatibility |

- **Progress reports replace the separate playback ping.** The reader already
  syncs playback ~5 s; that payload gains `heard_chunk_indexes` (additive; the
  server unions them). Flush immediately on pause, seek, chunk completion, job
  end, and `visibilitychange → hidden`.
- **Derived fields** are computed server-side and shipped in `JobSummary`/
  `JobDetail`: `read_status` (`unread`/`in_progress`/`read`),
  `progress_fraction`, `heard_chunks`, `estimated_remaining_seconds`, plus
  `folder` (id, name, path), `previous_job_id`, `next_job_id` on detail.
  The frontend never re-derives read status.
- **WebSocket**: `library_changed` (coalesced) after any mutation, and a compact
  `job_progress` event (job id + fraction + status, throttled) so a second tab
  stays live without refetching the library every 5 s. Progress events never
  carry chunk text.
- **Scheduler warming**: `SchedulerService` derives `up_next` job ids each tick
  from playing jobs' folder successors (no stored flag). Those jobs are clamped
  into band 1 until `contiguous_written_seconds >= up_next_prebuffer_seconds`.
  `up_next_prebuffer_seconds` becomes an Admin knob (default 120).

### 4. Frontend

New modules:

```
web/src/features/library/
  LibraryPage.tsx          # route shell: tree + pane (or trash)
  LibraryTree.tsx          # nested, keyboard-navigable, counts
  LibraryPane.tsx          # breadcrumb, toolbar, folder + job rows
  LibraryRow.tsx           # progress, state word, ▶, ⋮, drag/checkbox
  LibraryToolbar.tsx       # Organize, Select all, Play folder, New, Search
  BulkActionBar.tsx
  FolderDialog.tsx         # create/rename
  MoveDialog.tsx           # destination tree picker
  TrashView.tsx
  library-model.ts         # pure: tree build, ordering, filters, aggregates
  library-api.ts           # thin client for the endpoints above
web/src/player/
  PlayerProvider.tsx       # app-level player + current job + manifest/anchor
  player-context.ts
  MiniPlayer.tsx
  UpNextChip.tsx
  JobStepper.tsx
web/src/features/reader/
  ChunkMenu.tsx            # per-chunk ⋮
  ReaderHeaderActions.tsx  # bulk mark read/unread
web/src/features/settings/
  SettingsDialog.tsx       # one hub: Playback | Reader | Library
```

- **State**: library snapshot + filters + organize-mode selection live in a
  `state/library.ts` store (zustand, same pattern as `store.ts`). Reader device
  preferences stay in `state/reader-settings.ts` (localStorage is correct for
  UI preferences; content state is server-owned).
- **Player lift** is behavior-preserving first: `PlayerProvider` hosts
  `useMediaSourcePlayer`, the current job id/manifest, anchor, `playIntent`,
  `seekOverride`, progress reporting, and auto-advance. `ReaderPage` becomes a
  consumer and keeps document loading, text layout, and UI state. The pending-seek
  ownership rules and the anchor-coordinate conversions in AGENTS.md must be
  preserved verbatim; the existing `media-source.test.tsx` and `ReaderPage.test.tsx`
  cases are the guard.
- **Guard for autoplay**: advancing happens after a user gesture in the same
  document, so `play()` is allowed; if the browser still refuses, show a
  "Tap to continue" pill instead of silently pausing.
- **Settings hub**: `SettingsDialog` sections — Playback (speed, motion,
  continuous play), Reader (conveyor, jump buttons, chunk marks), Library (row
  detail, confirmations, skip-read-on-play-folder). Extensible by design, since
  preferences will shift after real use.
- **Responsive**: on `<md`, the tree is a drawer, the pane is full width, the
  mini-player sits above the safe-area inset, and Organize mode uses long-press
  plus checkboxes.

### 5. Reader integration

- Heard chunks: dimmed (as today) plus a quiet ✓ beside the chunk number, driven
  by the server's `heard_chunks`, not by transient playback.
- Chunk ⋮ menu in the block header; bulk actions in the reader header.
- Folder breadcrumb + job stepper in the playbar's folder row, collapsing to
  `‹ ›` on scroll; up-next chip in the metadata row.
- Auto-advance on terminal end: `next_job_id` → `player.open(nextJobId)` +
  navigate, restoring position and playing.
- "End of <folder>" card at the end of the last job.

## Milestones

Each milestone is independently shippable with the full suite green.

**M1 — Storage seam (no user-visible change). DONE.**
`app/db/` protocols + in-memory adapter + `tests/unit/test_db.py` contract
tests; `JobManager` is user-scoped and runs every command as one unit of work;
`Job.user_id`/`folder_id` added; seeded local user (`app/core/identity.py`);
`AppServices.database` injected from `build_services`.

What M1 deliberately did *not* include (moved into M2): `PlaybackRegistry`,
because it is only needed once the library can say "this folder is playing".
The job-level `is_active_listening` flag stays until then.

Verification: `uv run pytest` (280 passed, 2 skipped), `ruff check`,
`ruff format --check`, `pyright` all clean.

**M2 — Library domain + API + progress. DONE.**
`Folder`, `TrashEntry`, `JobProgress` entities + repositories; `app/library`
(pure tree/progress/playback + `LibraryService` + `ProgressService`); library,
trash and progress endpoints; derived read fields on summaries/details; WS
`library_changed` / `job_progress`; folder-aware scheduler warming with the
`up_next_prebuffer_seconds` knob.

Deviations from the first draft:
- **No `PlaybackRegistry`.** Up-next is derived per tick from jobs already loaded
  by the scheduler, so there is no second source of truth for "who is playing".
- **`DELETE /api/jobs/{id}` stays permanent** (existing tests/tooling use it);
  trashing is `POST /api/library/delete`.
- `JobProgress.heard` is keyed by chunk **version** and carries `audio_epoch`, so
  reprocessing/re-rendering invalidates marks without cross-service cleanup.

Verification: 353 server tests (incl. new contract, tree, progress, playback,
library service, API and scheduler-warming suites), ruff, pyright clean.

**M3 — Player lift + mini-player (behavior-preserving). DONE.**
`web/src/player/`: `player-store` (inputs/outputs/actions), `PlayerProvider`
(owns `ShadowAudio` + `useMediaSourcePlayer` + playback reporting + terminal
handling), `MiniPlayer`. `ReaderPage` is now a consumer. `App` wraps the shell in
the provider and pads `<main>` while the mini-player is visible.

Design notes:
- `openJob` keeps the stream for the same job (remounts/patches) and preserves
  intent expressed before the first job's load effect flushes.
- The provider's `ended` handler uses `audio.currentTime` plus a latest-values
  ref; the mirrored store is one commit behind browser events, and treating that
  lag as "not at the end" used to stop playback on a gap.
- Tests mount the provider; a provider test pins that the same audio element
  survives a child route change. A new Playwright test marks the element, walks
  to the library and asserts it is the same element with a working mini-player.

Verification: 561 web tests, 22 Playwright tests, `bun run lint`, `tsc` clean.

**M4 — Library UI. DONE.**
`web/src/features/library/`: pure `library-model`, `LibraryPage` (route state,
actions, dialogs), `LibraryTree`, `LibraryPane`/`LibraryRow` (progress, read
state, render dot, ⋮ menu), `LibraryDialogs` (prompt/move/new-job), `TrashPage`.
The library replaces the jobs page at `/`; `/library/:folderId` is bookmarkable,
`/trash` is a real route. Organize mode does checkboxes, select-all, drag
reorder (same kind) and the bulk bar; cross-folder moves use a destination
dialog. Search is global with a read-state filter. `?play=1` lets Play folder
start the reader playing. The old `JobsPage` was deleted.

Verification: 581 web tests, 24 Playwright tests, lint/typecheck clean.

**M5 — Reader read state + auto-advance. DONE.**
- Provider-side heard detection (90% of real playback, no seeks) and additive
  reporting with flush on pause/seek/ended/hidden/pagehide; position restore on
  open (anchor + pending seek), with the restore effect ordered after
  `openJob`/`setSource`.
- ReaderText: heard ✓, per-chunk ⋮ (jump / mark heard / mark-from-here), and a
  header ⋮ for mark-all/from-here. Progress responses patch the loaded job.
- Playbar: `JobStepper` (`‹ Job 3 of 8 ›`) and `UpNextChip` with a persistent
  continuous-play toggle (new reader setting, default on). `[` / `]` shortcuts.
- Auto-advance: `web/src/player/auto-advance.ts` (pure) + provider navigation to
  `?play=1`; `ReaderEndCard` with Replay / Back to library at the end of a
  folder. Backend detail now carries folder index/count and neighbour titles.

Verification: 593 web tests, 26 Playwright tests (incl. auto-advance and
continuous-play-off), lint/typecheck clean.

**M6 — Settings hub, docs, polish. DONE.**
- The reader settings panel is now a sectioned hub (Playback / Reading /
  Library / Keyboard), with continuous play under Playback and links to the
  library and trash under Library.
- The `up_next_prebuffer_seconds` warming knob is exposed in Admin → Overview.
- README and AGENTS.md document the storage seam, library model, player lift,
  listening progress, auto-advance, folder warming and the settings hub.
- Final verification: full server and web suites, Playwright, lint, typecheck,
  plus a real-browser pass against the fake backend (folders → job → real audio
  playback → progress → mini-player pause → trash/restore) and an API-level
  end-to-end smoke covering folders, ordering, moves, progress, read marks,
  trash/restore/purge and media serving.

## Testing strategy

- **Repository contract tests** (`server/tests/unit/test_repositories.py`) run
  against the in-memory adapter and are the definition the Postgres adapter must
  satisfy: detached reads, explicit saves, rollback, per-user isolation,
  ordering, soft delete.
- **Pure domain tests**: folder order math, subtree delete/restore, cycle
  rejection, progress derivation (heard → fraction → status, failed-chunk rule),
  auto-advance decision (terminal, folder, next job, continuous-play off).
- **Service/API tests**: every library mutation, bulk move/delete, single-parent
  move, trash restore, `404` after permanent delete, progress union semantics,
  user scoping.
- **Scheduler tests**: up-next job gets band 1 and stops at the prebuffer target;
  a paused/trashed folder's jobs are never warmed.
- **Frontend**: pure model tests (tree, filters, aggregates, reorder math),
  library component tests (organize mode, selection ranges, row states), player
  provider tests (route change keeps audio, auto-advance picks the right job),
  reader tests (heard marks, chunk menu, bulk actions), settings hub tests.
- **Playwright**: create/nest folders, drag reorder, multi-select move/delete,
  trash + restore, Play folder → auto-advance across a job boundary, mini-player
  pause from the library, resume position after reload, phone drawer layout,
  long titles still not widening the page.
- **Gates**: `bun run lint` after every frontend change, `make test`,
  `make lint`, `make typecheck` at each milestone; `bun run test:e2e` for M4–M6.

## Risks and accepted trade-offs

- **The storage refactor touches everything.** M1 must be behavior-preserving
  and is the largest single risk. Mitigation: contract tests first, migrate one
  service at a time, keep the existing server suite as the outer guard, and do
  not combine it with any product change.
- **The player lift touches the most-iterated code in the repo.** Mitigation:
  no new behavior in M3; preserve pending-seek ownership and anchor-coordinate
  rules; the existing media-source/reader tests are the contract.
- **Progress is lost on backend restart.** Accepted: jobs are lost too, so the
  state is consistent by construction. A Postgres adapter is where progress
  becomes durable.
- **Folder order vs. read state asymmetry** is intentional: Play folder resumes
  at the first unread job, then auto-advance follows strict order (including
  already-read jobs).
- **Strict-order advance can land on an unrendered job.** Accepted, mitigated by
  up-next warming; the reader's existing stall banner and "waiting for the GPU"
  states cover the rest.
- **Two position spaces for folders and jobs** keeps folders-first ordering
  simple; dragging a job "above" a folder is therefore not possible, by design.
