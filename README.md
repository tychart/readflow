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

The repo does **not** yet contain every production nicety — jobs live in memory, there is no auth and no persistence — but local development is two commands:

```bash
make install      # one-time: uv sync (server) + bun install (web)
scripts/dev.sh    # run the API + web dev server with hot reload
```

Dependencies are managed with the native toolchains: **uv** owns the backend
(`server/uv.lock`, `server/pyproject.toml`) and **bun** owns the frontend
(`web/bun.lock`, `web/package.json`). Containers are for deployment and validation,
not the day-to-day loop — see [Container Deployment](#container-deployment). The
`bun run` aliases mirror the Make targets if you prefer to stay in the JS toolchain:
`bun run setup` (setup) and `bun run dev` (run the stack).

That starts the API (uvicorn `--reload`, real Qwen3-TTS by default) and the Vite dev server
with HMR, waits until both are ready, then follows their logs. Ctrl-C stops both. Use
`scripts/dev.sh --fake` for instant, GPU-free runs.

Vite binds `0.0.0.0`, so a phone or tablet on the same network can open the URL the script
prints (`--localhost` restricts it to loopback-only). The API stays on loopback and is
reached through Vite's `/api` proxy, so nothing else needs a LAN bind.

`web/vite.config.ts` proxies `/api` and `/api/ws` to the backend, so the browser session is
same-origin with no extra setup.

## Features

- Create jobs from pasted text or `.txt` upload
- Shared backend queue for all jobs
- Reader view with chunk-by-chunk buffered playback
- Reader navigation built for book-length jobs:
  - a whole-document waveform playbar (the overview)
  - a **chunk conveyor** below it — a fixed-playhead strip that you drag or flick
    to scrub, with the chunk under the playhead named and timestamped
  - a **jump control on every chunk** in the text, so you can jump straight to a
    location without touching the playbar
  - **−10s / +10s** skip buttons
  - a **playback speed** slider and numeric input (0.5–3×)
  - **page-wide keyboard shortcuts** (Space/K, arrows, J/L) with a shortcuts guide
  - **reader settings** (motion, conveyor, jump buttons, chunk window), saved per device
  - a **phone bottom dock** that puts the transport and conveyor in the thumb zone
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
- [web/src/features/reader/reader-model.ts](/home/tychart/projects/readflow/web/src/features/reader/reader-model.ts): pure reader derivations (patch merging, playback model, timeline slots)
- [web/src/features/reader/conveyor-physics.ts](/home/tychart/projects/readflow/web/src/features/reader/conveyor-physics.ts): pure conveyor gesture physics and layout
- [web/src/features/reader/PlaybackSpeedControl.tsx](/home/tychart/projects/readflow/web/src/features/reader/PlaybackSpeedControl.tsx): playback speed slider and input
- [web/src/components/ChunkConveyor.tsx](/home/tychart/projects/readflow/web/src/components/ChunkConveyor.tsx): the fixed-playhead scrub strip
- [web/src/state/reader-settings.ts](/home/tychart/projects/readflow/web/src/state/reader-settings.ts): device-local reader preferences
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
- Browser work needs both dev servers; `scripts/dev.sh` starts them together

### Setup implication: `flash-attn`

`flash-attn` is an **optional** CUDA extension that speeds up the attention layer.
When it is absent the provider falls back to PyTorch's SDPA implementation,
so the app works on development machines without CUDA.

On the target machine with CUDA there are two options:

- `uv sync --extra cuda` compiles flash-attn natively for your GPU architecture
  (about 30–60 min). On Fedora 44+ the system GCC is too new for CUDA 12.8, so use the
  container instead.
- the container images: the default API image runs on PyTorch SDPA and needs no compile,
  while the `-flash` tag installs a prebuilt flash-attn wheel. See
  [Container Deployment](#container-deployment).

`torch` is pinned to `2.9.0` in `server/pyproject.toml` so the prebuilt flash-attn
wheel matches (CUDA 12.8 + `cu12torch2.9`). Changing that pin means re-checking that a
matching flash-attn wheel exists.

## Requirements

### For the mocked and normal test workflow

- Python 3.12+
- `uv`
- `bun` — package manager and script runner for everything JS/TS
- Node 22+ — runtime for the Vite/Vitest/Playwright binaries that bun drives
- `ffmpeg`

### For the real Qwen runtime (native install)

- NVIDIA GPU
- working CUDA stack visible to PyTorch
- GCC ≤ 14 (CUDA 12.8 limitation)
- enough VRAM for `Qwen/Qwen3-TTS-12Hz-0.6B-Base`
- successful `uv sync --extra cuda`

### For the real Qwen runtime (Docker)

- Docker (or Podman with NVIDIA container runtime)
- enough VRAM for `Qwen/Qwen3-TTS-12Hz-0.6B-Base`

If `torch.cuda.is_available()` is false in your current shell, the real provider and the real-model test suite will fail immediately by design.

## Container Deployment

ReadFlow ships as **two images**, with three api variants:

| Image | Contents |
|---|---|
| `ghcr.io/tychart/readflow-api` | CUDA, PyTorch SDPA — boots on any NVIDIA GPU |
| `ghcr.io/tychart/readflow-api:<tag>-flash` | CUDA, prebuilt flash-attn — fastest attention |
| `ghcr.io/tychart/readflow-api:<tag>-cpu` | CPU-only torch — no NVIDIA runtime needed |
| `ghcr.io/tychart/readflow-web` | Caddy serving the built SPA and proxying `/api` + `/api/ws` |

Caddy serves the SPA and the API from one origin, so the frontend keeps its relative
`/api/...` paths with no CORS and no build-time backend URL. All api variants bake in
the built-in voices and keep the model weights out of the image entirely.

### Run (published images)

```bash
cp .env.example .env          # optional overrides (tag, port, provider)
podman compose up -d          # or: docker compose up -d
```

Open <http://localhost:8080>. Compose pulls the images from GHCR, reserves the GPU for
the API, and mounts a named `hf-cache` volume at the Hugging Face cache. The model
downloads on first use and is reused across container updates — it is never baked into
the image.

Requirements on the host:

- Docker with `nvidia-container-toolkit`, or Podman with CDI
- an NVIDIA GPU with enough VRAM for `Qwen/Qwen3-TTS-12Hz-0.6B-Base`

If `podman compose up` fails with
`crun: cannot stat /usr/lib64/libEGL_nvidia.so.<version>`, the host CDI spec is stale
after a driver upgrade. Regenerate it once:

```bash
sudo nvidia-ctk cdi generate --output=/etc/cdi/nvidia.yaml
```

No NVIDIA GPU at all? Use the CPU stack (see below).

### Building and running from source

The same compose file builds locally, so you never need a wrapper script:

```bash
podman compose up -d --build        # builds both images from this checkout
```

`--build` is required on code changes; without it Compose reuses the existing image.
Override the local build variant through `.env`:

```bash
READFLOW_FLASH=1 podman compose up -d --build     # build the flash-attn api
```

### CPU stack (no GPU)

```bash
podman compose -f compose.cpu.yml up -d --build
```

Synthesising a book on a CPU is very slow, so this is mainly for trying the app out and
for UI work. For a fast UI-only stack that never loads a model:

```bash
READFLOW_TTS_PROVIDER=fake podman compose -f compose.cpu.yml up -d
```

### Image tags

| Tag | Meaning |
|---|---|
| `latest` | newest `main` commit or release |
| `main`, `sha-<short>` | rolling branch / exact commit |
| `1.2.3`, `1.2` | release (from a `v*` git tag) |
| `-flash`, `-cpu` suffix | the corresponding api variant |

The default api image does not include flash-attn and falls back to PyTorch SDPA. The
`-flash` image is the accelerated one; select it by overriding the image:

```bash
READFLOW_API_IMAGE=ghcr.io/tychart/readflow-api:latest-flash podman compose up -d
```

### Why flash-attn needs no compiler

PyTorch 2.9 on PyPI is a **CUDA 12.8** build and flash-attn 2.8.3 publishes a matching
prebuilt `cu12torch2.9` wheel, so the api image installs flash-attn from that wheel and
builds in minutes. The stack is pinned in `server/pyproject.toml` (`torch==2.9.0`,
`torchaudio==2.9.0`) for exactly this reason — torch 2.11 is a CUDA 13 build with no
matching flash-attn wheel, which is what previously forced a ~1 hour source compile.

### Fast container check

```bash
scripts/compose-smoke.sh                     # or: make docker-smoke
```

Boots an api image with the fake provider (no GPU, no model download) and asserts it
reaches `/health` and exposes the built-in voices. Seconds, not minutes.

### How the images are built

`.github/workflows/images.yml` publishes to GHCR on every push to `main`, on `v*` tags,
and on manual dispatch — `latest`, the branch, `sha-<short>`, and semver tags, plus the
`-flash` and `-cpu` variants.

The api Dockerfile is multi-target: a shared Ubuntu 24.04 builder creates the venv (and
optionally installs the flash-attn wheel), and two runtime stages (`cuda` and `cpu`)
copy it. The builder deliberately matches the runtime distro so the copied venv's
interpreter path stays valid.

### Development workflow

| Activity | Command |
|---|---|
| Day-to-day dev (whole app, hot reload) | `scripts/dev.sh` |
| Day-to-day dev (backend only) | `uv sync --extra dev && uv run uvicorn main:app --reload` |
| Real-model test (native) | `uv sync --extra cuda` then `uv run pytest -m real_model` |
| Run containers from source | `podman compose up -d --build` |
| Fast image check | `scripts/compose-smoke.sh` |
| Logs / stop | `make docker-logs` / `make docker-down` |

## Installation

Both halves at once:

```bash
make install
```

Or separately:

### Backend

```bash
cd server
uv sync --extra dev --extra utils
```

### Frontend

```bash
cd web
bun install
```

Bun owns everything JavaScript/TypeScript: `bun install`, `bun run`, `bunx`, and
`web/bun.lock`. uv owns everything Python: `uv sync`, `uv run`. There is no `package-lock.json`
and no root `node_modules` — the JS project lives entirely in `web/`.

## Running the Backend

The normal way to run the app locally is `scripts/dev.sh`:

```bash
scripts/dev.sh            # real Qwen3-TTS provider (default)
scripts/dev.sh --fake     # instant, no GPU, deterministic audio
```

To run the API on its own:

```bash
cd server
uv run uvicorn main:app --reload --port 8000
```

Notes:

- Startup validates the configured provider and required voice assets.
- With the default `qwen` provider, startup will fail if CUDA is not available.
- For fast mocked development or test-only backend runs, use `READFLOW_TTS_PROVIDER=fake`.

Example:

```bash
cd server
READFLOW_TTS_PROVIDER=fake uv run uvicorn main:app --reload --port 8000
```

## Running the Frontend

```bash
cd web
bun run dev
```

On its own this only serves the UI; `/api` requests need the backend on port 8000. For a
working browser session use `scripts/dev.sh`, which runs both halves and keeps the proxy
pointing at the API it started.

Ports are fixed at 8000 (api) and 5173 (web) because `web/vite.config.ts` compiles the
proxy target against 8000. `scripts/dev.sh` reports (and leaves alone) any process already
holding either port instead of guessing.

`scripts/dev.sh` serves the frontend on the LAN by default (Vite `--host 0.0.0.0`), which is
what makes the reader usable from a phone. The API is *not* exposed directly — it keeps
uvicorn's loopback default and LAN clients reach it only through Vite's `/api` proxy.

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
bun run test:run        # vitest, one shot
bun run test:coverage   # vitest + v8 coverage
bun run test:e2e        # Playwright
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
- `READFLOW_MAX_SOURCE_BYTES=<bytes>` (default `67108864`, i.e. 64 MB per job)

### Long documents

Paste or upload a whole chapter, or a whole book. The source text is
canonicalized once when the job is created (whitespace/newline cleanup) and that
single canonical string is what chunk offsets and the reader index into.

- `READFLOW_MAX_SOURCE_BYTES` caps one job's source text. Both the pasted-text
  field and a `.txt` upload are measured against it; going over returns HTTP 413
  with the configured limit in the message. Starlette's 1 MiB per-field multipart
  default does **not** apply here.
- Chunk planning stays lazy and buffer-aware, so a long document is planned as
  it renders — the reader shows the not-yet-planned tail as dimmed "Upcoming
  text" (whole tail for chapter-sized sources, a bounded preview for books).
- Live events carry a job summary plus, for chunk events, the single chunk that
  changed. Full detail (including `source_text`) is fetched over HTTP.

For many other runtime defaults, the current source of truth is [server/app/core/config.py](/home/tychart/projects/readflow/server/app/core/config.py).

## API Overview

Key HTTP endpoints:

- `POST /api/jobs` (multipart: `text` or `.txt` `file`, up to `READFLOW_MAX_SOURCE_BYTES`)
- `GET /api/jobs`
- `GET /api/jobs/{job_id}` (full detail, including `source_text`)
- `GET /api/jobs/{job_id}/manifest`
- `GET /api/jobs/{job_id}/chunks/init`
- `GET /api/jobs/{job_id}/chunks/{chunk_index}`
- `POST /api/jobs/{job_id}/activate` (returns a job summary)
- `POST /api/jobs/{job_id}/pause` (returns a job summary)
- `POST /api/jobs/{job_id}/resume` (returns a job summary)
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

1. Persist jobs and chunk metadata so restarts do not wipe state.
2. Add cleanup and retention policies for temp media.
3. Expand admin telemetry with per-job batch history and richer scheduler visibility.
4. Keep hardening the newest reader surfaces (the conveyor gestures and the
   phone dock layouts).
5. Support broader model/runtime tuning once the base 0.6B path is stable.
6. Add a production deployment story for single-host installation.
7. Add optional real-GPU CI or a documented validation checklist for target hardware.

## Short Practical Summary

If you want the shortest mental model for this repo, it is this:

- the backend owns everything important
- the scheduler tries to keep listeners buffered
- the GPU path is centralized and batched
- the browser plays appended fMP4 segments through `MediaSource`
- the fake provider keeps daily development and CI fast
- the real provider follows the exact official Qwen call pattern that was already validated externally
