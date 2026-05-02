# AGENTS.md

This file is the internal handoff document for future agents working in this repository.

It is intentionally more operational and opinionated than `README.md`. Use it to understand:

- what the user asked for
- what was actually implemented
- which architectural decisions are intentional and should not be “cleaned up” casually
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
- `server/app/api/router.py`
- `server/app/scheduler/service.py`
- `server/app/synthesis/provider.py`
- `server/app/synthesis/model_manager.py`
- `server/app/synthesis/worker.py`
- `server/app/media/store.py`
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
- `web/src/features/reader/ReaderPage.tsx`
- `web/src/features/admin/AdminPage.tsx`
- `web/src/hooks/useAppBootstrap.ts`
- `web/src/lib/api.ts`
- `web/src/lib/media-source.ts`
- `web/src/state/store.ts`

Frontend stack:

- React 19
- TypeScript
- Vite
- Tailwind CSS v4
- Zustand

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

That `voice_id` grouping is deliberate. It was added to keep the real Qwen provider aligned with the user’s proven benchmark pattern: one voice-clone prompt shape repeated across a batch.

## Exact Qwen Integration Contract

This is one of the most important parts of the repo.

The current implementation in `server/app/synthesis/provider.py` is intentionally shaped around the user’s working scripts.

### Model loading

Current real load path:

- model id: `Qwen/Qwen3-TTS-12Hz-0.6B-Base`
- `device_map="cuda:0"`
- `dtype=torch.bfloat16`
- `attn_implementation="flash_attention_2"`

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

- `/api/...`
- `/api/ws`

Important caveat:

- `web/vite.config.ts` does **not** currently define a dev proxy for `/api`

Implication:

- tests pass
- backend can run alone
- frontend can run alone
- but a normal same-origin full-stack browser dev workflow is not yet fully polished

Future agents should not overlook this. It is currently the biggest practical dev-experience gap in the repo.

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
- do not “fix” that by weakening validation unless the user explicitly asks

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

### 2. CUDA visibility can differ by shell/session

At one point in this conversation:

- mocked test/lint/typecheck all passed
- gated real-model tests failed
- the reason was simply `torch.cuda.is_available()` being `False` in that execution environment

Do not immediately assume the provider code is broken if real-model tests fail. Check CUDA visibility first.

### 3. Frontend full-stack dev still needs same-origin help

The repo does not yet include a Vite `/api` proxy.

Do not write docs or status updates implying that `npm run dev` + `uvicorn` automatically gives a working full browser stack without extra setup.

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

Admin page:

- change runtime knobs
- warm model
- evict model
- inspect queue depth and model state
- view recent batch telemetry

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

1. add a Vite `/api` proxy or another same-origin dev solution
2. persist jobs and chunk metadata
3. add temp media cleanup/retention
4. improve admin telemetry depth
5. improve reader UX and chunk highlighting
6. expand deployment story for a single-host install
7. add a better documented GPU validation workflow

## Bottom Line for Future Agents

If you only remember a few things, remember these:

- preserve the boring, centralized architecture
- keep backend scheduling/chunking logic on the server
- keep the frontend thin
- keep the official Qwen integration aligned with the user’s validated scripts
- do not casually trigger a `flash-attn` rebuild
- keep tests green and run them often
- do not undo the async server test harness without very good reason
