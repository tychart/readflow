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

## Docker Build (production)

One-time compile of flash-attn inside a CUDA container (~1 hour first run, cached afterwards).

| Target | Command | What it does |
|--------|---------|--------------|
| `docker-build` | `make docker-build` | Builds `readflow-server:cuda` image |
| `docker-run` | `make docker-run` | Runs container with GPU, exposes port 8000 |
| `docker-clean` | `make docker-clean` | Removes the image |

**Note:** On Fedora 44+ (GCC 15+), use `docker-build` — do **not** run `cuda-install` on the host.

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
