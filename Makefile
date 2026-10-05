SHELL := /bin/bash
UV_CACHE_DIR := /tmp/readflow-uv-cache

.PHONY: install dev test-web test-server test-e2e test lint typecheck test-real-model \
        cuda-install docker-build docker-build-flash docker-build-cpu docker-build-all \
        docker-run docker-run-cpu docker-logs docker-down docker-smoke docker-clean

# ── Setup ─────────────────────────────────────
# Bun owns the frontend, uv owns the backend.

install:
	cd web && bun install
	cd server && UV_CACHE_DIR=$(UV_CACHE_DIR) uv sync --extra dev --extra utils

# ── Local development ─────────────────────────
# scripts/dev.sh is the one-command local stack (uvicorn --reload + Vite).

dev:
	scripts/dev.sh start

# ── Test / lint / typecheck ───────────────────

test-web:
	cd web && bun run test:run

test-server:
	cd server && UV_CACHE_DIR=$(UV_CACHE_DIR) uv run pytest

test-e2e:
	cd web && bun run test:e2e

test: test-web test-server

lint:
	cd web && bun run lint
	cd server && UV_CACHE_DIR=$(UV_CACHE_DIR) uv run ruff check .
	cd server && UV_CACHE_DIR=$(UV_CACHE_DIR) uv run ruff format --check .

typecheck:
	cd web && bun run typecheck
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

# ── Containers ─────────────────────────────────
# Engine auto-detects docker, then podman. Override: `make docker-build ENGINE=podman`.
# Compose prefers `docker compose`, then podman-compose.
ENGINE ?= $(shell command -v docker 2>/dev/null || command -v podman 2>/dev/null)
COMPOSE ?= $(shell if command -v docker >/dev/null 2>&1; then echo "docker compose"; \
	elif command -v podman-compose >/dev/null 2>&1; then echo "podman-compose"; \
	else echo "podman compose"; fi)
REGISTRY ?= ghcr.io/tychart
IMAGE_TAG ?= latest

# Build locally, tagged exactly like the published images so compose resolves
# them without pulling. `$(COMPOSE) up -d --build` does the same from compose.yml.
docker-build:
	$(ENGINE) build --target cuda -t $(REGISTRY)/readflow-api:$(IMAGE_TAG) -f server/Dockerfile server
	$(ENGINE) build -t $(REGISTRY)/readflow-web:$(IMAGE_TAG) -f web/Dockerfile web

# flash-attn is a prebuilt wheel now, so this takes minutes, not an hour.
docker-build-flash:
	$(ENGINE) build --target cuda --build-arg INSTALL_FLASH_ATTN=1 \
		-t $(REGISTRY)/readflow-api:$(IMAGE_TAG)-flash -f server/Dockerfile server

# CPU-only api image (no NVIDIA runtime needed).
docker-build-cpu:
	$(ENGINE) build --target cpu -t $(REGISTRY)/readflow-api:$(IMAGE_TAG)-cpu -f server/Dockerfile server

docker-build-all: docker-build docker-build-flash docker-build-cpu

# Start the GPU stack. Add ARGS=--build to build from this checkout.
docker-run:
	$(COMPOSE) -f compose.yml up -d $(ARGS)
	@echo "ReadFlow: http://localhost:$${READFLOW_PORT:-8080}"

docker-run-cpu:
	$(COMPOSE) -f compose.cpu.yml up -d $(ARGS)

docker-logs:
	$(COMPOSE) -f compose.yml logs -f

docker-down:
	-$(COMPOSE) -f compose.yml down
	-$(COMPOSE) -f compose.cpu.yml down

# Fast check that an api image boots, is healthy and has the built-in voices.
docker-smoke:
	scripts/compose-smoke.sh $(REGISTRY)/readflow-api:$(IMAGE_TAG)

docker-clean:
	-$(ENGINE) rmi $(REGISTRY)/readflow-api:$(IMAGE_TAG) \
		$(REGISTRY)/readflow-api:$(IMAGE_TAG)-flash \
		$(REGISTRY)/readflow-api:$(IMAGE_TAG)-cpu \
		$(REGISTRY)/readflow-web:$(IMAGE_TAG)
