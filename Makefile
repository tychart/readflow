SHELL := /bin/bash
UV_CACHE_DIR := /tmp/readflow-uv-cache

.PHONY: test-web test-server test-e2e test lint typecheck test-real-model

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
