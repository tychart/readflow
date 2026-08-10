# AGENTS.md

This file is the internal handoff document for future agents working in this repository.

When making modifications, these are what the user values:
- Building and fixing in the best practice possible way
- The user values long term maintainability and best practice archetecture
- Simplicity as much as possible, and maintainablity
- Best practice python code and best practice React and typescript

It is intentionally more operational and opinionated than `README.md`. Use it to understand:

- what the user asked for
- what was actually implemented
- which architectural decisions are intentional and should not be "cleaned up" casually
- how to test changes safely
- where the sharp edges are

If this file and the code disagree, the code is the source of truth. If this file and the original product brief disagree, prefer the implemented code plus the latest user instructions.

## Project Identity

Project name: `ReadFlow`

Purpose:

- long-form TTS web app
- single repo
- custom FastAPI backend
- custom React + TypeScript + Vite frontend
- official Qwen3-TTS backend usage
- optimized for a private single-machine setup
- one GPU, one loaded model, one synthesis loop, many queued jobs

Primary design goal order:

1. audio quality
2. keep listeners buffered
3. maintain aggregate throughput through batching
4. keep the system understandable and debuggable

This is **not** designed as a distributed inference platform.

## Non-Negotiable Product Decisions

These came directly from the user and should be preserved unless the user changes direction.

- Single repo with `server/` and `web/`
- No database
- No auth
- No accounts
- No Redis/Celery
- No distributed queue
- No multi-worker GPU contention
- No persistent jobs across restart
- No user-uploaded voices in v1
- No automatic transcription in v1
- No model switching mid-job in v1
- Backend owns chunking and scheduling
- Frontend stays thin and reactive
- Dynamic batching is core behavior, not a later optimization
- Browser-native media buffering via `MediaSource`/`SourceBuffer`
- Built-in server-side voices only
- VRAM should be releasable after idle timeout

## User Preferences That Matter to Future Agents

These are not generic repo facts; they are preferences the user explicitly emphasized during this conversation.

### 1. Tests must be treated as part of implementation

The user explicitly wants tests implemented and executed constantly during development.

Expected behavior for future agents:

- after meaningful backend changes, run targeted backend tests immediately
- after meaningful frontend changes, run targeted frontend tests immediately
- at natural checkpoints, run the fast combined verification path
- do not leave code untested when a relevant test path exists

Practical expectation:

- if you change scheduler/model/backend logic, rerun the affected server tests
- if you change media/playback/frontend behavior, rerun relevant frontend tests and likely Playwright smoke tests
- before calling a feature done, the fast suite should be green if possible

### 2. Be careful with `flash-attn`

The user explicitly warned that `flash-attn` compilation can take nearly an hour on their machine.

Do **not** casually change:

- `flash-attn` version
- Python/runtime assumptions that trigger rebuilds
- the server dependency layout in ways that force a reinstall

If changing the Qwen runtime stack is truly necessary, call that out clearly because it can impose a very expensive rebuild.

### 3. Use the official Qwen usage pattern the user already validated

The user provided working reference scripts outside the repo and explicitly asked that the app follow the same usage style rather than a generic or improvised integration.

That means future agents should preserve the current core Qwen call pattern:

- `Qwen3TTSModel.from_pretrained(...)`
- `create_voice_clone_prompt(ref_audio=..., ref_text=..., x_vector_only_mode=False)`
- `generate_voice_clone(text=[...], language=..., voice_clone_prompt=[...])`

Do not refactor the provider toward some different wrapper abstraction unless the user asks for that.

### 4. Prefer simple, stable playback fixes over clever browser-event guesswork

A lot of the recent work in this repo was about the custom streaming player. The user is explicitly fine with architectural changes during development if they make the system simpler and more reliable.

Practical implication for future agents:

- do not keep layering UI-only conditions on top of flaky media event behavior
- if playback state is wrong, fix it at the player/controller layer first
- treat user intent (`playIntent`) and actual media state as separate but synchronized concerns
- when the browser is inconsistent, prefer explicit local state transitions triggered by known user actions

The user cares more about a stable, debuggable implementation than preserving a previous abstraction.

## Current Architecture Snapshot

## Repo layout

```text
repo/
  server/
    app/
      api/
      chunking/
      core/
      jobs/
      media/
      scheduler/
      schemas/
      synthesis/
      telemetry/
      voices/
    tests/
    voices/
      suzy/
      howard/
    main.py
    pyproject.toml
  web/
    src/
      app/
      features/
      hooks/
      lib/
      state/
      types/
    e2e/
    package.json
    vite.config.ts
  .github/workflows/ci.yml
  Makefile
  README.md
  AGENTS.md
```

## Backend architecture

Key files:

- `server/app/core/app.py`
- `server/app/core/services.py`
- `server/app/core/hub.py` (WebSocketHub)
- `server/app/api/router.py`
- `server/app/scheduler/service.py`
- `server/app/synthesis/provider.py`
- `server/app/synthesis/model_manager.py`
- `server/app/synthesis/worker.py`
- `server/app/media/store.py`
- `server/app/media/mp4.py` (WAV → fragmented MP4 packaging)
- `server/app/voices/registry.py`

Core services:

- `JobManager`
- `ChunkPlanner`
- `SchedulerService`
- `ModelManager`
- `SynthesisWorker`
- `VoiceRegistry`
- `MediaStore`
- `TelemetryService`
- `WebSocketHub`

## Frontend architecture

Key files:

- `web/src/app/App.tsx`
- `web/src/features/jobs/JobsPage.tsx`
- `web/src/features/jobs/JobCreateForm.tsx`
- `web/src/features/reader/ReaderPage.tsx`
- `web/src/features/admin/AdminPage.tsx`
- `web/src/hooks/useAppBootstrap.ts`
- `web/src/lib/api.ts`
- `web/src/lib/transport.ts`
- `web/src/lib/media-source.ts`
- `web/src/state/store.ts`
- `web/src/types/api.ts`, `events.ts`, `player.ts`

Frontend stack:

- React 19
- TypeScript
- Vite
- Tailwind CSS v4
- Zustand

## Reader / Player Architecture

This became one of the most iterated parts of the codebase. Future agents should understand the intended split before touching it.

Key files:

- `web/src/features/reader/ReaderPage.tsx`
- `web/src/lib/media-source.ts`
- `web/src/features/reader/timeline.ts`
- `web/src/components/WaveformTimeline.tsx`
- `web/src/components/Playbar.tsx`
- `web/src/hooks/useChunkWaveforms.ts`
- `server/app/media/peaks.py`

Current architecture:

- `ReaderPage` owns reader-level state, user intent, timeline interactions, and server synchronization
- `useMediaSourcePlayer` owns the hidden `<audio>` element, `MediaSource`, `SourceBuffer`, append queue, and low-level playback state
- the visible player is fully custom; the native audio controls are hidden

Important design rules:

- the browser keeps one appendable MSE stream per active job/anchor
- the custom UI should not depend solely on browser `waiting`/`ended` behavior to decide what the player is doing
- `playIntent` is user intent, not identical to "the browser is currently making sound"
- real playback state comes from the hook and must stay synchronized with the custom controls

### Static waveform playbar (replaces the old live analyser)

The waveform is **static** — it never vibrates with playback. It is built from
backend-computed peaks, not live audio analysis.

How it works:

- `server/app/media/peaks.py` computes per-chunk max-amplitude peaks (256 bins,
  normalized per chunk) from the WAV during packaging and writes a small JSON
  file next to each `.m4s` segment
- each chunk response carries `peaks_url`, served by the router
- `useChunkWaveforms` fetches peaks per written chunk (keyed by `index:version`;
  reprocessing bumps the version and re-fetches) and exposes a
  `Map<chunkIndex, Float32Array>`
- `WaveformTimeline` renders thin pill bars at a px-based resolution that adapts
  to the container width; playback progress is the amber fill sweeping
  left-to-right as the playhead passes
- chunks without peaks yet (or unrendered) render a dim deterministic
  placeholder; missing/failed chunks keep the broken-signal pattern

Styling knobs (`BAR_WIDTH_PX`, `BAR_GAP_PX`, `MIN_BAR_HEIGHT`, …) live in a
single tunable constants block at the top of `WaveformTimeline.tsx`.

Do **not** reintroduce a live Web Audio analyser for the playbar visualization —
`useWaveformAnalyser.ts` was intentionally deleted. If playback visuals drift,
the fix belongs in the peaks pipeline or the timeline rendering, not in live
capture.

### Playhead coordinate rule (protect against a seek-position bug)

`WaveformTimeline` renders slots in **job-timeline coordinates** (0 = start of
the first slot). Its playhead prop (`playheadSeconds`) and playable-range prop
(`renderedDurationSeconds`) MUST be passed in those same coordinates.

The player's `currentTimeSeconds`/`renderedDurationSeconds` are
**stream-normalized** — the media stream resets to 0 at the playback anchor —
so they must be shifted by `anchorOffset` before reaching the timeline.
`ReaderPage` owns this conversion: `displayTimeSeconds` (clock + timeline
playhead) and `displayRenderedDurationSeconds` (timeline playhead maximum).

Historical bug this protects against: when a stream-normalized position leaked
into the timeline, any seek to a later chunk made the amber fill jump to the
beginning of the timeline and sweep from the left, because the playhead was
compared against wrong coordinates. Do not "fix" playhead drift by re-deriving
positions inside `WaveformTimeline`; the coordinate conversion belongs in
`ReaderPage`/`Playbar`.

Drag-seeking commits exactly one `onSeek` on pointer-up; while dragging, the
fill previews the pointer position via local `dragPreviewSeconds` (standard
scrubber behavior). Do not add per-pointer-move `onSeek` calls — that used to
trigger a backend activation HTTP call on every drag frame.

### Pending-seek ownership (player hook, not the reader)

Applying a timeline seek is owned by `useMediaSourcePlayer` via the
`pendingSeekSeconds` option (stream-normalized target) + `onSeekApplied`
callback. `ReaderPage` only converts the click position (original coords →
stream coords via `anchorOffset`) and clears its `seekOverride` state when the
hook reports the seek applied.

Historical bug this protects against: the seek application previously lived in
a `ReaderPage` effect that ran in the **same commit** as the player's
stream-reset effect (anchor change = stream rebuild). The reader's effect read
stale state from the old stream (primed + buffered), applied the seek against
the new, not-yet-opened MediaSource (clamped to 0), and consumed the pending
seek — so the first click on a different chunk always landed at the start of
that chunk, and only a second click landed at the real position.

The hook avoids this by gating the pending seek on `isStreamPrimedRef` /
`bufferedUntilRef`, which the stream-reset effect updates **synchronously**
(state closures are stale within the same effect flush; refs are not). The
pending-seek effect is defined after the stream-setup effect so it always runs
after the reset within a commit. Do not move seek application back into
`ReaderPage`; cross-component effect ordering cannot guarantee this.

While a seek is pending the stream is rebuilding and `currentTimeSeconds` is
stale (reset to 0 at the new anchor), so `ReaderPage` shows the seek target
itself as the display playhead (`displayTimeSeconds = seekOverride ??
currentTimeSeconds + anchorOffset`). Do not "simplify" that back to always
`currentTimeSeconds + anchorOffset` — it makes the fill snap to the start of
the anchored chunk on release and then jump to the seeked position once the
seek applies.

### Two historical bugs worth protecting against

1. **Never define a component inside `ReaderPage`.** `ReaderContent` was once
   defined inline, giving it a new identity on every render; during playback
   the reader re-renders ~20×/s, so React unmounted/remounted the whole content
   subtree (including the sidebar toggle button) on every tick, swallowing
   clicks. It now lives at module scope and takes props. If you add a new
   sub-render, keep it a module-level component.

2. **A finished terminal job must converge to "ended" without a browser
   `ended` event.** MSE does not always fire `ended` at the end of the stream.
   `useMediaSourcePlayer.updatePlaybackState` reconciles this: for a terminal
   job whose playhead is frozen at the end of the fully-buffered stream
   (within `TERMINAL_END_EPSILON_SECONDS`), it pauses the audio and clears
   `isActuallyPlaying`/`isWaitingForData`, which lets `ReaderPage` reset
   `playIntent` and clears the stuck spinner. Do not gate this on extra UI
   conditions in `Playbar` — fix it in the player/controller layer.

### Gap-aware playback model

The frontend intentionally supports the backend finishing chunks out of order.

Implemented behavior:

- timeline can show later written chunks even if earlier chunks are still missing
- automatic playback only follows the contiguous written run from the current playback anchor
- if chunks `1,2,3,6` exist, normal playback stops after `3` and waits for `4`
- chunks `4` and `5` show as expected-but-missing
- chunk `6` shows as ready-after-gap, but is not auto-played
- clicking a later ready chunk is allowed and creates a new playback anchor

This is intentional. Do not "simplify" it back to auto-skipping gaps unless the user explicitly asks.

### Timeline rendering model

The user strongly preferred the more continuous-looking playbar over the earlier equal-width chunk-slot version.

Current visual behavior:

- written chunks use real duration-based sizing
- missing/unrendered chunks use fixed placeholder sizing
- the bar should still feel like one continuous timeline rather than a row of disconnected boxes
- seeking within a playable chunk is granular and based on exact click/drag position

If changing the playbar, preserve that overall feel unless the user asks for a redesign.

### Completed-job local playback rules

Completed jobs behave differently from in-progress jobs.

Implemented behavior:

- completed jobs are local-only from the reader's perspective
- play/pause/playback heartbeats should not keep talking to the backend for completed jobs
- download remains available
- local playback after completion still needs to keep the custom play/pause button honest

Important historical lesson:

- reaching the end of a completed job should be treated as a real ended/paused state
- if the user then seeks on the timeline, that explicit seek may need to re-arm local playback intent immediately rather than waiting for inconsistent browser follow-up events

If you see bugs where the hidden audio plays but the button still says `Play`, or where the button says `Pause` after ending, look at the synchronization between:

- terminal-job audio events in `ReaderPage`
- `playIntent`
- explicit timeline seek handlers

## How the system works

High-level pipeline:

1. User creates a job from pasted text or `.txt` upload.
2. `JobManager` stores the source text and job state in memory.
3. `ChunkPlanner` lazily emits startup/safety/steady-state chunks.
4. `SchedulerService` ranks renderable chunks across all jobs.
5. `SynthesisWorker` requests a batch for one model/language/voice/length bucket.
6. `QwenProvider` loads the model if needed and performs batched synthesis.
7. `MediaStore` packages WAV output into fragmented MP4 AAC segments via `ffmpeg`.
8. Backend serves a manifest plus init/media segment URLs.
9. Frontend appends segments with `MediaSource`.
10. WebSocket events keep the jobs page, reader, and admin views live.

## Job, scheduler, and playback policy

Important behavior:

- jobs are containers; chunk tasks are what actually get scheduled
- paused jobs are excluded from future scheduling
- active listening jobs are prioritized above inactive queued jobs
- scheduling is buffer-aware
- per-job prebuffer is capped
- batch size is dynamic
- VRAM soft limit influences batch downshifting
- on OOM, worker records telemetry and retries with a smaller batch once

Current batch grouping dimensions:

- `model_id`
- `language`
- `voice_id`
- rough chunk length bucket

That `voice_id` grouping is deliberate. It was added to keep the real Qwen provider aligned with the user's proven benchmark pattern: one voice-clone prompt shape repeated across a batch.

## Exact Qwen Integration Contract

This is one of the most important parts of the repo.

The current implementation in `server/app/synthesis/provider.py` is intentionally shaped around the user's working scripts.

### Model loading

Current real load path:

- model id: `Qwen/Qwen3-TTS-12Hz-0.6B-Base`
- `device_map="cuda:0"`
- `dtype=torch.bfloat16`
- `attn_implementation`: resolved at load time - `flash_attention_2` when `flash_attn` is installed,
  otherwise `sdpa` (SDPA fallback for development / non-CUDA machines)

The `attn_implementation` is resolved once via `_resolve_attn_implementation()` which attempts
an import of `flash_attn`. This makes the provider work without flash-attn on dev machines while
still using the fastest path in production containers.

### Voice prompt creation

Current prompt build path:

- `model.create_voice_clone_prompt(ref_audio=..., ref_text=..., x_vector_only_mode=False)`

Voice prompts are cached by `voice_id`.

### Batch generation

Current batch generation path:

- `model.generate_voice_clone(text=text_batch, language=language, voice_clone_prompt=prompt_batch)`

The provider intentionally requires:

- all chunks in a batch share one language
- all chunks in a batch share one voice
- prompt list shape follows the validated benchmark usage

If you change this behavior, do it only with clear justification and updated tests.

### Fake provider

The fake provider exists for fast deterministic tests and CI.

Do not remove it unless the user asks. It is a major part of the development/testing story.

## Voice System

Voice discovery is strict and folder-driven.

Voice folders must exist under:

- `server/voices/suzy`
- `server/voices/howard`

Each voice must contain:

- `ref.wav`
- `ref.txt`
- `meta.json`

The registry fails fast if:

- the voice directory is missing
- a required file is missing
- `ref.txt` is empty
- no voices are found

Important historical note:

- legacy `male_default` references were intentionally removed
- current built-in voices are `suzy` and `howard`

Do not reintroduce `male_default` into the public contract.

## Model Lifecycle Rules

Implemented via `ModelManager`.

States:

- `unloaded`
- `loading`
- `warm_idle`
- `busy`
- `evicting`

Important behavior:

- model loads lazily
- model can be manually warmed
- model can be manually evicted
- idle unload timeout defaults to 300 seconds
- unload clears live model refs and prompt cache, then runs GC and CUDA cache cleanup

This is important because reclaiming VRAM requires dropping live references, not just emptying cache.

## Media Delivery

Implemented via `MediaStore`.

Current media format:

- fragmented MP4
- AAC audio
- init segment plus `.m4s` media segments

Packaging path:

1. provider returns WAV bytes
2. temp WAV is written
3. `ffmpeg` converts WAV to fragmented MP4
4. MP4 is split into init/media segments
5. temp WAV/MP4 intermediates are deleted

Temp storage is under:

- `/tmp/<temp_dir_name>/jobs/<job-id>/chunks/`

There is no retention cleanup daemon yet.

## Frontend Behavior and Current Caveat

Frontend uses relative API URLs:

- `/api/...` (HTTP)
- `/api/ws` (WebSocket)

Transport layer: `web/src/lib/transport.ts` (HTTP client), `web/src/lib/live-client.ts` (WebSocket).

Current dev-server behavior:

- `web/vite.config.ts` defines an HTTP proxy for `/api`
- `web/vite.config.ts` defines a WebSocket proxy for `/api/ws`
- local dev is intended to work as a same-origin frontend talking to the backend through Vite

Important caveat:

- if proxy behavior changes, remember that HTTP and WS proxying are both required
- do not "fix" WS problems by hardcoding backend URLs into the frontend runtime unless the user explicitly wants that
- the preferred architecture is relative frontend paths with proxy/reverse-proxy ownership of upstream routing

## Testing Strategy and Expectations

This repo was built with testing as a first-class requirement.

## Root commands

Use these first:

```bash
make test
make lint
make typecheck
make test-real-model
```

What they mean:

- `make test`: web tests + mocked server tests
- `make lint`: ESLint + Ruff lint + Ruff format check
- `make typecheck`: TypeScript + Pyright
- `make test-real-model`: opt-in real Qwen tests

## Server tests

Important files:

- `server/tests/conftest.py`
- `server/tests/integration/test_api.py`
- `server/tests/integration/test_real_model.py`
- `server/tests/unit/test_provider.py`
- `server/tests/unit/test_scheduler.py`
- `server/tests/unit/test_config.py`
- `server/tests/unit/test_voices.py`
- `server/tests/unit/test_jobs.py`
- `server/tests/unit/test_planner.py`

Note: `server/app/jobs/test_manager.py` and `server/app/jobs/test_models.py` are in-app test
modules (not in the pytest directory) — they test versioning and reprocessing logic.

Important testing decisions:

- normal tests force `READFLOW_TTS_PROVIDER=fake`
- normal tests force `READFLOW_SCHEDULER_AUTOSTART=false`
- real-model tests are gated behind `READFLOW_ENABLE_REAL_MODEL_TESTS=1`

### Important historical lesson: do not reintroduce `TestClient`

During this conversation, backend tests initially hung due to a bad interaction between the current stack and `FastAPI TestClient` / sync dependency execution / lifespan behavior under Python 3.13.

The fix was:

- build services inside the app lifespan
- make the router dependency `async def services()`
- use `httpx.AsyncClient` with `ASGITransport`
- use `app.router.lifespan_context(app)` directly in tests

This was not theoretical. It was found by reproducing hangs and tracing live stacks.

Future agents should preserve this test harness unless there is a very good reason to change it.

## Real-model tests

The real-model suite is intentionally small and gated.

It currently validates:

- real provider startup
- real prompt creation
- real batched synthesis
- app-level manifest and segment serving through the real provider path

Important operational note:

- the real-model suite will fail immediately if `torch.cuda.is_available()` is false in the launching shell
- that failure is expected and correct
- do not "fix" that by weakening validation unless the user explicitly asks

## CI

GitHub Actions currently runs:

- `web-ci`
- `server-ci`
- `e2e`

It does **not** run real GPU-backed model tests.

That is intentional.

## Commands Agents Should Commonly Use

### Install

```bash
cd server
uv sync --extra dev

cd web
npm ci
```

### Run backend

```bash
cd server
uv run uvicorn main:app --reload --host 0.0.0.0 --port 8000
```

### Run backend in fake mode

```bash
cd server
READFLOW_TTS_PROVIDER=fake uv run uvicorn main:app --reload --host 0.0.0.0 --port 8000
```

### Run frontend

```bash
cd web
npm run dev -- --host 0.0.0.0 --port 5173
```

## Important Environment Variables

Current useful env vars:

- `READFLOW_TTS_PROVIDER=qwen|fake`
- `READFLOW_SCHEDULER_AUTOSTART=true|false`
- `READFLOW_TEMP_DIR_NAME=<name>`
- `READFLOW_VOICES_DIR=<relative path>`

Runtime defaults live in:

- `server/app/core/config.py`

## Known Pitfalls

These are the main things future agents should know before making changes.

### 1. `flash-attn` rebuild cost is huge

This was explicitly called out by the user.

Do not casually perturb:

- Python version assumptions
- `flash-attn` pin
- build dependency configuration
- Qwen runtime dependency graph

**`flash-attn` is now an optional dependency (`[project.optional-dependencies] cuda`)**.
Normal `uv sync` does not pull it. The QwenProvider falls back to SDPA when it is absent.
This means daily development, testing, and CI do not trigger a flash-attn compile.

Production / GPU installs use either:
- `uv sync --extra cuda` on a compatible machine (GCC ≤ 14)
- `docker build -f server/Dockerfile` which compiles flash-attn inside a CUDA 12.8 + Ubuntu 24.04 container with GCC 13

The Docker build targets SM 86 (RTX 30xx) via `FLASH_ATTN_CUDA_ARCHS=86` to minimize compile time.
It only recompiles flash-attn when `pyproject.toml`, `uv.lock`, or the CUDA base image changes.

Fedora 44 ships GCC 15+, which CUDA 12.8 does not support — use the Docker build, not a native install.

Do not remove or significantly change `server/Dockerfile` without understanding:
- the builder stage uses `nvidia/cuda:12.8.1-devel-ubuntu24.04`
- `FLASH_ATTN_CUDA_ARCHS=86` pins compilation to Ampere
- The layer cache strategy means pyproject.toml/uv.lock changes are the only thing that triggers flash-attn rebuild

### 2. CUDA visibility can differ by shell/session

At one point in this conversation:

- mocked test/lint/typecheck all passed
- gated real-model tests failed
- the reason was simply `torch.cuda.is_available()` being `False` in that execution environment

Do not immediately assume the provider code is broken if real-model tests fail. Check CUDA visibility first.

### 3. WebSocket and transport ownership matter

The frontend transport layer went through several iterations.

Important lessons:

- keep frontend API and WS URLs relative (`/api/...`, `/api/ws`)
- let Vite or the eventual reverse proxy own upstream routing
- avoid hardcoded backend-origin fallbacks in frontend runtime code
- keep WebSocket connection ownership centralized rather than scattering socket lifecycles across components

If debugging WS issues, inspect:

- `web/vite.config.ts`
- `web/src/hooks/useAppBootstrap.ts`
- `web/src/lib/live-client.ts`

### 4. Runtime state is ephemeral

Jobs, telemetry, and runtime admin changes are in memory only.

Do not assume restart persistence.

### 5. Voice switching semantics are versioned and one-way

Voice changes affect future not-yet-started chunks only.

The implemented behavior is:

- bump `plan_version`
- mark queued/planned future chunks stale
- leave already written chunks alone

Do not mutate completed audio retroactively unless the user explicitly wants a new model.

### 6. MSE/player bugs are often state-model bugs, not codec bugs

Recent playback bugs were often caused by stale or mismatched state, not by the media container itself.

Examples:

- waiting/loading UI not appearing because the hook only trusted browser media events
- completed-job seek/play button drift because local playback restarted without re-arming `playIntent`
- waiting state staying visible after completion because terminal transition cleanup was incomplete

Before assuming ffmpeg/MSE packaging is broken, inspect the interaction between:

- `playerState`
- `playIntent`
- `isWaitingForData`
- `isActuallyPlaying`
- `currentTimeSeconds`
- terminal/completed-job transitions

## Current User-Facing Pages

Jobs page:

- create jobs from text or `.txt`
- view job list
- see status and chunk counts
- open reader view

Reader page:

- view source text
- play/pause
- monitor buffer progress
- switch future voice
- inspect chunk statuses
- use a custom segmented timeline
- support gap-aware playback and manual jump-to-later-ready chunks
- allow download of rendered contiguous audio

Admin page:

- change runtime knobs
- warm model
- evict model
- inspect queue depth and model state
- view recent batch telemetry
- view model lifecycle state

## What Was Added During This Conversation

Future agents should know that the following were created or materially changed in this conversation:

- real Qwen provider implementation
- strict voice registry
- default real-provider runtime config
- exact Qwen model id and language defaults
- `howard` replacing old `male_default` contract
- server-side real-model test suite
- async `httpx`/ASGI server test harness
- root `README.md`
- current `Makefile` testing workflow
- Vite HTTP/WS proxy for same-origin local dev
- custom streaming reader/player with gap-aware playback
- static backend-computed waveform playbar (replaces the live Web Audio analyser)
- server-side `.m4a` export for contiguous rendered audio
- completed-job local-only playback behavior

## Agent Workflow Checklist

When making changes, use this checklist.

### If you change backend business logic

- run targeted server tests first
- then run `make test`
- then `make lint`
- then `make typecheck`

### If you change frontend logic

- run targeted web tests first
- then run `make test`
- then `make lint`
- then `make typecheck`
- if playback/media behavior changed, also run `npm run test:e2e` in `web/`

### If you change Qwen/provider/model/runtime logic

- rerun provider and scheduler tests immediately
- rerun mocked server suite
- if CUDA is available in the current environment, rerun `make test-real-model`
- be explicit in your summary about whether real-model verification was actually executed

### If you touch dependency/runtime setup

- be extremely careful with `flash-attn`
- explain any change that could force a rebuild
- do not surprise the user with a long compile unless it is necessary

## Roadmap Direction

Likely next steps, unless the user changes direction:

1. persist jobs and chunk metadata
2. add temp media cleanup/retention
3. improve admin telemetry depth
4. continue hardening reader/player edge cases
5. expand deployment story for a single-host install (Docker is now in place)
6. add a better documented GPU validation workflow

## Bottom Line for Future Agents

If you only remember a few things, remember these:

- preserve the boring, centralized architecture
- keep backend scheduling/chunking logic on the server
- keep the frontend thin
- keep the official Qwen integration aligned with the user's validated scripts
- `flash-attn` is optional — provider falls back to SDPA when absent
- the Docker build (`server/Dockerfile`) is the canonical production path
- keep tests green and run them often
- do not undo the async server test harness without very good reason
