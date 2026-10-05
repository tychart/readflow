---
name: readflow-workflow
description: "Execute ReadFlow development workflow: test, lint, typecheck, real-model verification, and Docker workflows. USE FOR: verify changes before committing, run the full fast suite, run targeted checks, validate with real Qwen model, build Docker image. DO NOT USE FOR: running the dev servers, managing voices, or debugging playback — see AGENTS.md for those."
license: MIT
metadata:
  author: readflow-team
  version: "1.0.0"
  repo: readflow
---

# ReadFlow Workflow Skill

This skill defines the standard verification and build workflows for ReadFlow.
Future agents should run the appropriate subset of checks before marking changes as complete.

## Pre-Execution Requirements

> **MANDATORY: Before running any command, confirm you are in the repository root** (`readflow/`).
> All Makefile targets assume this working directory.

## Fast Verification (always run)

Run these after **any** meaningful change to backend or frontend code.

| Target | Command | What it does |
|--------|---------|--------------|
| `test` | `make test` | Runs `test-web` + `test-server` (TypeScript vitest + pytest with fake provider) |
| `lint` | `make lint` | ESLint (web), ruff check + ruff format (server) |
| `typecheck` | `make typecheck` | TypeScript strict check + Pyright |

**Expected order:** `make test` → `make lint` → `make typecheck`

## Targeted Checks

When you know exactly what changed, you can run only the relevant subset.

| Target | Command | When to use |
|--------|---------|-------------|
| `test-web` | `make test-web` | Only frontend changes |
| `test-server` | `make test-server` | Only backend changes |

## Real-Model Verification (opt-in)

Only run when CUDA is available (`torch.cuda.is_available()` must be `True`).

| Target | Command | What it does |
|--------|---------|--------------|
| `test-real-model` | `make test-real-model` | Runs real-Qwen gated tests (synthesis, prompt creation, manifest, segments) |

**Prerequisite:** `READFLOW_ENABLE_REAL_MODEL_TESTS=1` is set, GPU visible.

## Container Build (production)

Two images (api + web) run together via `compose.yml`. The api comes in three
variants: CUDA/SDPA (default), `-flash` (prebuilt flash-attn wheel), and `-cpu`.
None of them compile flash-attn — it comes from a prebuilt wheel — so every build
is minutes, not an hour.

`podman compose up -d --build` builds and runs from this checkout; no Makefile needed.
The Make targets below are just convenience wrappers (they auto-detect docker then
podman; override with `ENGINE=podman`, `REGISTRY=...`, or `IMAGE_TAG=...`).

| Target | Command | What it does |
|--------|---------|--------------|
| `docker-build` | `make docker-build` | Builds the api (CUDA/SDPA) + web images locally |
| `docker-build-flash` | `make docker-build-flash` | Builds the api image with flash-attn |
| `docker-build-cpu` | `make docker-build-cpu` | Builds the CPU-only api image |
| `docker-run` | `make docker-run` | `compose up -d`, serves the UI on port 8080 |
| `docker-smoke` | `make docker-smoke` | Boots an api image (fake provider) and checks health + voices |
| `docker-logs` / `docker-down` | `make docker-logs` / `make docker-down` | Tail logs / stop the stack |
| `docker-clean` | `make docker-clean` | Removes the local images |

**Note:** On Fedora 44+ (GCC 15+), use the containers — do **not** run `cuda-install` on the host.

**Note:** `torch` is pinned to 2.9.0 so the prebuilt flash-attn wheel matches. If you bump
it, confirm a matching flash-attn wheel exists first.

## Workflow Checklist

Use this as your default verification sequence:

```
1. Identify changed areas (server, web, or both)
2. Run targeted tests (test-web or test-server)
3. Run make test (full fast suite)
4. Run make lint
5. Run make typecheck
6. (Optional) If CUDA available and you touched provider/scheduler logic → make test-real-model
7. If changing deployment → make docker-build
```

## Caveats

- `flash-attn` is optional. Provider falls back to SDPA when absent. Daily dev/test does not rebuild it.
- Real-model tests fail immediately if `torch.cuda.is_available()` is `False` — check GPU visibility before assuming code is broken.
- Server tests use `httpx.AsyncClient` + `ASGITransport`. Do not reintroduce `TestClient`.
- Frontend URLs are relative (`/api/...`). Do not hardcode backend URLs.

## Extending This Skill

To add new workflow steps:

1. Add a new `.PHONY` target to `Makefile`
2. Add a row to the appropriate table above
3. Update the Workflow Checklist if it is a commonly-needed step
4. Add caveats if the new step has special requirements (env vars, prerequisites, etc.)

Sub-skill references (future):

| Sub-Skill | When to Use | Reference |
|-----------|-------------|-----------|
| **playback-debugging** | Fixing reader/player state bugs | `[playback-debugging](playback-debugging/SKILL.md)` |
| **voice-management** | Adding/removing voices, updating ref files | `[voice-management](voice-management/SKILL.md)` |
