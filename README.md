# ReadFlow

ReadFlow is a single-repo long-form text-to-speech application built around the official Qwen3-TTS backend, a custom FastAPI server, and a custom React/Vite frontend.

The project is optimized for a private single-machine setup where one GPU serves many queued narration jobs through one centralized scheduler and one batched synthesis path.

## What This Repo Is

ReadFlow is intentionally opinionated:

- one backend service
- one frontend app
- one loaded Qwen model at a time
- one GPU synthesis loop
- in-memory jobs and scheduler state
- temp-file-based media output
- no auth, no accounts, no database, no Redis, no Celery

The core design goal is not “lowest single-request latency.” It is:

1. good long-form audio quality
2. enough aggregate throughput to sustain listening via batching
3. predictable GPU behavior
4. simple operations and debuggability

## Current Status

The repo currently contains:

- a FastAPI backend with job management, chunk planning, scheduling, voice registry, model lifecycle management, media packaging, and WebSocket updates
- a React frontend with Jobs, Reader, and Admin pages
- a real Qwen provider using the official SDK usage pattern
- a fake provider for fast deterministic local tests
- unit, integration, browser smoke, lint, and typecheck coverage

The repo does **not** yet contain every production nicety. The biggest current operational caveat is that the frontend uses relative `/api` requests, but `web/vite.config.ts` does not yet define a dev proxy. That means browser-based full-stack local development currently needs either:

- a reverse proxy that serves the frontend and backend under one origin, or
- a small Vite `/api` proxy addition

The backend and frontend test suites work today, but manual full-stack browser development is still a little rough until that same-origin gap is addressed.

## Features

- Create jobs from pasted text or `.txt` upload
- Shared backend queue for all jobs
- Reader view with chunk-by-chunk buffered playback
- WebSocket-driven live job and admin updates
- Built-in server-side voices discovered from `server/voices/`
- Voice switching for future chunks only
- Playback-aware scheduler prioritization
- Dynamic batching with VRAM-aware backoff
- Idle model eviction from VRAM
- Manual warm and evict actions from the admin page
- Temp-file fragmented MP4 media delivery for browser playback
- Fast mocked tests and gated real-model tests

## Main Limitations

- Jobs are in memory only and are lost on restart
- No auth or multi-user isolation
- No persistent storage layer
- No user-uploaded voices in v1
- No model switching mid-job
- No word-level highlighting
- No cleanup daemon for temp media
- The scheduler is single-process and single-model by design
- Real-model tests require CUDA to be visible to PyTorch in the current shell
- The dev frontend does not yet proxy `/api` automatically

## Architecture

### High-level flow

1. A user creates a job from text or a `.txt` upload.
2. `JobManager` stores the job in memory.
3. `ChunkPlanner` lazily emits natural-language chunks.
4. `SchedulerService` ranks renderable chunks across all jobs.
5. `SynthesisWorker` requests a batch from the provider.
6. `QwenProvider` loads the model lazily, builds or reuses voice clone prompts, and calls the official Qwen batch generation path.
7. `MediaStore` packages generated WAV audio into `fMP4 + AAC` segments via `ffmpeg`.
8. The backend exposes a manifest plus chunk URLs.
9. The frontend appends segments through `MediaSource` and updates the UI from live HTTP + WebSocket state.

### Backend construction

The backend lives in `server/` and is centered around [server/app/core/app.py](/home/tychart/projects/readflow/server/app/core/app.py), [server/app/core/services.py](/home/tychart/projects/readflow/server/app/core/services.py), and [server/app/api/router.py](/home/tychart/projects/readflow/server/app/api/router.py).

Important subsystems:

- `JobManager`: owns job lifecycle, chunk state, voice changes, playback progress, and completion state
- `ChunkPlanner`: lazily splits long text into startup, safety, and steady-state chunks
- `SchedulerService`: ranks work by playback urgency and builds the next batch
- `ModelManager`: tracks unloaded/loading/warm/busy/evicting state and handles idle VRAM eviction
- `SynthesisWorker`: runs one batch at a time, retries once on OOM by shrinking the batch, and packages audio for the browser
- `QwenProvider`: uses the official `Qwen3TTSModel.from_pretrained(...)`, `create_voice_clone_prompt(...)`, and `generate_voice_clone(...)` flow
- `VoiceRegistry`: scans `server/voices/<voice_id>/ref.wav`, `ref.txt`, and `meta.json`
- `MediaStore`: writes temp chunk files and produces an init segment plus media segments
- `TelemetryService`: exposes recent batches, queue depth, model state, idle deadline, and OOM count

### Scheduler behavior

The scheduler operates on chunk tasks, not whole jobs.

Today it prioritizes work in this order:

1. active listening jobs under the target buffer
2. active listening jobs with healthy buffer
3. queued inactive jobs
4. paused jobs are excluded

Batch construction is grouped by:

- model id
- language
- voice id
- rough length bucket

That last point matters. The current real Qwen integration intentionally batches only one voice at a time so it can follow the same prompt-reuse shape that was already validated in the external benchmark scripts.

### Model lifecycle

The default provider is the real Qwen provider:

- model: `Qwen/Qwen3-TTS-12Hz-0.6B-Base`
- device map: `cuda:0`
- dtype: `torch.bfloat16`
- attention: `flash_attention_2`

The model is loaded lazily on demand, remains warm while the scheduler is using it, and is evicted after `idle_unload_seconds` of inactivity. The default is 300 seconds.

ReadFlow also exposes manual warm and evict operations in the admin UI and via the admin API.

### Frontend construction

The frontend lives in `web/` and uses:

- React 19
- TypeScript
- Vite
- Tailwind CSS v4
- Zustand

Important frontend pieces:

- [web/src/app/App.tsx](/home/tychart/projects/readflow/web/src/app/App.tsx): shell and routing
- [web/src/features/jobs/JobsPage.tsx](/home/tychart/projects/readflow/web/src/features/jobs/JobsPage.tsx): job creation and live queue
- [web/src/features/reader/ReaderPage.tsx](/home/tychart/projects/readflow/web/src/features/reader/ReaderPage.tsx): playback, future-voice selection, chunk status
- [web/src/features/admin/AdminPage.tsx](/home/tychart/projects/readflow/web/src/features/admin/AdminPage.tsx): runtime tuning and model controls
- [web/src/hooks/useAppBootstrap.ts](/home/tychart/projects/readflow/web/src/hooks/useAppBootstrap.ts): initial data load and WebSocket wiring
- [web/src/lib/media-source.ts](/home/tychart/projects/readflow/web/src/lib/media-source.ts): `MediaSource`/`SourceBuffer` append logic

The frontend is intentionally thin. It does not own planning or scheduling policy. It fetches server state, subscribes to events, and sends user intent.

## Repository Layout

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
  Makefile
  README.md
```

## Voice Assets

The backend will fail fast if built-in voices are missing or incomplete.

Each voice folder must contain:

```text
server/voices/<voice_id>/
  ref.wav
  ref.txt
  meta.json
```

Current built-in voices in this repo:

- `suzy`
- `howard`

`meta.json` is used for display metadata. `ref.wav` and `ref.txt` are used to build the reusable Qwen voice-clone prompt.

## Runtime Ramifications and Tradeoffs

This architecture is simple on purpose, but that simplicity has consequences.

### Good consequences

- Much easier to reason about than multi-worker GPU inference
- More predictable VRAM behavior
- Easier to debug queueing, playback, and voice switching
- Good fit for a single personal workstation

### Cost of that simplicity

- One synthesis loop means no horizontal scaling inside one process
- Jobs disappear when the process restarts
- Runtime config changes are in memory, not persisted
- Long first-time setup because `flash-attn` may compile for a very long time
- Browser manual dev is not yet one-command smooth because there is no dev proxy

### Setup implication: `flash-attn`

The first `uv sync --extra dev` on a fresh machine can take a long time because `flash-attn==2.8.3` may compile locally. On the target machine this can easily be tens of minutes, and you should avoid casually changing that dependency unless you are prepared to rebuild it.

## Requirements

### For the mocked and normal test workflow

- Python 3.12+
- `uv`
- Node 22+
- `npm`
- `ffmpeg`

### For the real Qwen runtime

- NVIDIA GPU
- working CUDA stack visible to PyTorch
- enough VRAM for `Qwen/Qwen3-TTS-12Hz-0.6B-Base`
- successful `uv sync --extra dev`

If `torch.cuda.is_available()` is false in your current shell, the real provider and the real-model test suite will fail immediately by design.

## Installation

### Backend

```bash
cd server
uv sync --extra dev
```

### Frontend

```bash
cd web
npm ci
```

## Running the Backend

```bash
cd server
uv run uvicorn main:app --reload --host 0.0.0.0 --port 8000
```

Notes:

- Startup validates the configured provider and required voice assets.
- With the default `qwen` provider, startup will fail if CUDA is not available.
- For fast mocked development or test-only backend runs, use `READFLOW_TTS_PROVIDER=fake`.

Example:

```bash
cd server
READFLOW_TTS_PROVIDER=fake uv run uvicorn main:app --reload --host 0.0.0.0 --port 8000
```

## Running the Frontend

```bash
cd web
npm run dev -- --host 0.0.0.0 --port 5173
```

### Important dev caveat

The frontend currently calls relative `/api/...` URLs and opens `/api/ws`, but the Vite config does not yet proxy those paths to the FastAPI backend. That means:

- `npm run dev` is fine for isolated frontend work and tests
- `uvicorn` is fine for isolated backend work and API checks
- a real browser end-to-end local session currently needs a same-origin setup

Practical options:

1. add a Vite dev proxy in `web/vite.config.ts`
2. run both behind nginx/Caddy/another local reverse proxy
3. temporarily patch the frontend client for a different backend origin during development

## Testing

The repo is set up so fast tests do not require the real Qwen model.

### Root commands

```bash
make test
make lint
make typecheck
make test-real-model
```

### What they do

- `make test`: web unit tests + mocked server tests
- `make lint`: ESLint + Ruff format/lint checks
- `make typecheck`: TypeScript + Pyright
- `make test-real-model`: opt-in real Qwen tests

### Web tests

```bash
cd web
npm test -- --run
npm run test:e2e
```

### Server tests

```bash
cd server
uv run pytest
```

### Real-model tests

```bash
cd server
READFLOW_ENABLE_REAL_MODEL_TESTS=1 uv run pytest -m real_model
```

These tests are intentionally gated. They attempt to load the actual Qwen model and will fail if CUDA is unavailable in the shell that launches them.

## CI

GitHub Actions currently runs three jobs:

- `web-ci`: lint, typecheck, unit tests, coverage
- `server-ci`: `uv sync`, Ruff, Pyright, pytest, coverage
- `e2e`: Playwright smoke coverage

The real-model GPU-backed tests are intentionally excluded from normal CI.

## Operational Notes

### Temp media

Generated chunks are written under the system temp directory:

```text
/tmp/<temp_dir_name>/jobs/<job-id>/chunks/
```

This is intentional for v1. There is no separate cleanup service yet.

### Runtime config

The admin page can change runtime scheduling knobs such as:

- idle unload seconds
- target buffer seconds
- max prebuffer seconds
- VRAM soft limit

These changes are in memory only. They are not persisted across restarts.

### Useful environment variables

- `READFLOW_TTS_PROVIDER=qwen|fake`
- `READFLOW_SCHEDULER_AUTOSTART=true|false`
- `READFLOW_TEMP_DIR_NAME=<name>`
- `READFLOW_VOICES_DIR=<relative path>`

For many other runtime defaults, the current source of truth is [server/app/core/config.py](/home/tychart/projects/readflow/server/app/core/config.py).

## API Overview

Key HTTP endpoints:

- `POST /api/jobs`
- `GET /api/jobs`
- `GET /api/jobs/{job_id}`
- `GET /api/jobs/{job_id}/manifest`
- `GET /api/jobs/{job_id}/chunks/init`
- `GET /api/jobs/{job_id}/chunks/{chunk_index}`
- `POST /api/jobs/{job_id}/activate`
- `POST /api/jobs/{job_id}/pause`
- `POST /api/jobs/{job_id}/resume`
- `POST /api/jobs/{job_id}/voice`
- `POST /api/jobs/{job_id}/playback`
- `GET /api/voices`
- `GET /api/admin/state`
- `POST /api/admin/config`
- `POST /api/admin/model/warm`
- `POST /api/admin/model/evict`

WebSocket endpoint:

- `WS /api/ws`

## What Is Intentionally Out of Scope in v1

- accounts and auth
- persistent jobs
- distributed workers
- Redis/Celery
- user-uploaded voices
- automatic transcription
- multiple concurrently loaded Qwen models
- retroactive rewriting of already-generated chunks after a voice switch
- full production deployment packaging

## Future Plan

Reasonable next steps for the project are:

1. Add a proper Vite dev proxy or unified same-origin local dev setup.
2. Persist jobs and chunk metadata so restarts do not wipe state.
3. Add cleanup and retention policies for temp media.
4. Expand admin telemetry with per-job batch history and richer scheduler visibility.
5. Add better reader UX, including chunk highlighting and stronger playback recovery after pauses.
6. Support broader model/runtime tuning once the base 0.6B path is stable.
7. Add a production deployment story for single-host installation.
8. Add optional real-GPU CI or a documented validation checklist for target hardware.

## Short Practical Summary

If you want the shortest mental model for this repo, it is this:

- the backend owns everything important
- the scheduler tries to keep listeners buffered
- the GPU path is centralized and batched
- the browser plays appended fMP4 segments through `MediaSource`
- the fake provider keeps daily development and CI fast
- the real provider follows the exact official Qwen call pattern that was already validated externally
