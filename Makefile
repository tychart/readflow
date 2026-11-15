SHELL := /bin/bash
UV_CACHE_DIR := /tmp/readflow-uv-cache

.PHONY: install dev test-web test-server test-e2e test test-fast test-db lint lint-fix typecheck test-real-model \
        db-up db-down db-reset migrate probe \
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

# Server tests without the coverage harness: the fast loop while iterating.
test-fast:
	cd server && UV_CACHE_DIR=$(UV_CACHE_DIR) uv run pytest --no-cov -q

# ── Database ──────────────────────────────────
# A local Postgres for development and the adapter contract suite. Postgres 18
# expects its volume at /var/lib/postgresql (not .../data): the image puts the
# data in a versioned subdirectory so pg_upgrade can work across majors.
# database (`readflow`) and the throwaway test database (`readflow_test`) live
# in one container and one named volume; nothing is published beyond loopback.
PG_CONTAINER ?= readflow-dev-pg
PG_VOLUME ?= readflow-dev-pgdata
PG_PORT ?= 5432
PG_USER ?= readflow
PG_PASSWORD ?= readflow
PG_IMAGE ?= docker.io/library/postgres:18
PG_URL ?= postgresql+psycopg://$(PG_USER):$(PG_PASSWORD)@127.0.0.1:$(PG_PORT)/readflow
TEST_PG_URL ?= postgresql+psycopg://$(PG_USER):$(PG_PASSWORD)@127.0.0.1:$(PG_PORT)/readflow_test

# `test-db` runs the adapter contract suite against real Postgres (it skips
# itself when READFLOW_TEST_DATABASE_URL is unset).
test-db:
	cd server && UV_CACHE_DIR=$(UV_CACHE_DIR) READFLOW_TEST_DATABASE_URL=$(TEST_PG_URL) uv run pytest

# Alembic arrives with the Postgres adapter; until then this explains itself
# instead of failing with "No such file: alembic.ini".
migrate:
	@if [ -f server/alembic.ini ]; then \
		cd server && UV_CACHE_DIR=$(UV_CACHE_DIR) uv run alembic upgrade head; \
	else \
		echo "alembic.ini not present yet (migrations land with the Postgres adapter)"; \
	fi

db-up:
	@$(ENGINE) ps volume inspect $(PG_VOLUME) >/dev/null 2>&1 || $(ENGINE) volume create $(PG_VOLUME) >/dev/null
	@$(ENGINE) ps container inspect $(PG_CONTAINER) >/dev/null 2>&1 && { \
		echo "$(PG_CONTAINER) already exists"; \
		$(ENGINE) ps start $(PG_CONTAINER) >/dev/null; \
	} || $(ENGINE) run -d --name $(PG_CONTAINER) \
		-e POSTGRES_USER=$(PG_USER) -e POSTGRES_PASSWORD=$(PG_PASSWORD) \
		-e POSTGRES_DB=readflow -e POSTGRES_INITDB_ARGS="--data-checksums" \
		-v $(PG_VOLUME):/var/lib/postgresql \
		-p 127.0.0.1:$(PG_PORT):5432 $(PG_IMAGE) >/dev/null
	@printf 'waiting for postgres'
	@until $(ENGINE) exec $(PG_CONTAINER) pg_isready -U $(PG_USER) -d readflow >/dev/null 2>&1; do \
		printf '.'; sleep 0.5; \
	done; echo ' ready'
	@$(ENGINE) exec $(PG_CONTAINER) psql -U $(PG_USER) -d readflow -tAc \
		"SELECT 1 FROM pg_database WHERE datname='readflow_test'" | grep -q 1 || \
		$(ENGINE) exec $(PG_CONTAINER) createdb -U $(PG_USER) readflow_test
	@echo "DATABASE_URL=$(PG_URL)"

db-down:
	-$(ENGINE) stop $(PG_CONTAINER)

db-reset:
	@$(ENGINE) exec $(PG_CONTAINER) psql -U $(PG_USER) -d postgres -c \
		"DROP DATABASE IF EXISTS readflow WITH (FORCE); DROP DATABASE IF EXISTS readflow_test WITH (FORCE);"
	@$(ENGINE) exec $(PG_CONTAINER) psql -U $(PG_USER) -d postgres -c \
		"CREATE DATABASE readflow; CREATE DATABASE readflow_test;"
	@$(MAKE) --no-print-directory migrate

# Read-model measurement harness (see docs/plan-postgres-auth.md).
probe:
	cd server && UV_CACHE_DIR=$(UV_CACHE_DIR) uv run python ../scripts/diagnostics/hot_path_probe.py $(ARGS)

# Biome owns formatting + linting for web/ (biome.jsonc at the repo root);
# ruff owns the same for server/.
lint:
	cd web && bun run lint
	cd server && UV_CACHE_DIR=$(UV_CACHE_DIR) uv run ruff check .
	cd server && UV_CACHE_DIR=$(UV_CACHE_DIR) uv run ruff format --check .

lint-fix:
	cd web && bun run lint:fix
	cd server && UV_CACHE_DIR=$(UV_CACHE_DIR) uv run ruff check --fix .
	cd server && UV_CACHE_DIR=$(UV_CACHE_DIR) uv run ruff format .

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
