SHELL := /bin/bash
UV_CACHE_DIR := /tmp/readflow-uv-cache

.PHONY: test-web test-server test-e2e test lint typecheck test-real-model \
        cuda-install docker-build docker-run docker-clean

# ── Test / lint / typecheck ───────────────────

test-web:
	cd web && npm test -- --run

test-server:
	cd server && UV_CACHE_DIR=$(UV_CACHE_DIR) uv run pytest

test-e2e:
	cd web && npm run test:e2e

test: test-web test-server

lint:
	cd web && npm run lint
	cd server && UV_CACHE_DIR=$(UV_CACHE_DIR) uv run ruff check .
	cd server && UV_CACHE_DIR=$(UV_CACHE_DIR) uv run ruff format --check .

typecheck:
	cd web && npm run typecheck
	cd server && UV_CACHE_DIR=$(UV_CACHE_DIR) uv run pyright

test-real-model:
	cd server && UV_CACHE_DIR=$(UV_CACHE_DIR) READFLOW_ENABLE_REAL_MODEL_TESTS=1 uv run pytest -m real_model

# ── CUDA / flash-attn (native install) ────────
# Only needed if you want to install flash-attn on the host.
# On Fedora 44+ (GCC > 14), this will fail — use docker-build instead.
#
# For older GCC setups:
#   make cuda-install
#
# For RTX 30xx:
#   FLASH_ATTN_CUDA_ARCHS=86 make cuda-install

cuda-install:
	cd server && \
	uv sync --extra cuda

# ── Docker build ───────────────────────────────
# One-time: flash-attn compiles inside the container (~1 h on first run).
# Subsequent starts use the pre-built image — zero compile time.
#
# Only rebuilds the compiler layer when pyproject.toml or uv.lock changes.
# Application code changes do not trigger a rebuild.

docker-build:
	docker build -t readflow-server:cuda -f server/Dockerfile .

docker-run:
	docker run --rm --gpus all --ipc=host -p 8000:8000 readflow-server:cuda

docker-clean:
	docker rmi readflow-server:cuda 2>/dev/null || true
