# syntax=docker/dockerfile:1.7
#
# ReadFlow web image — builds the SPA with bun and serves it with Caddy, which
# also reverse-proxies /api (HTTP) and /api/ws (WebSocket) to the API service.
# Keeping the API same-origin is what lets the frontend use relative `/api/...`
# paths with no CORS and no build-time backend URL.
#
# Build context is `web/`:
#
#   docker build -t ghcr.io/<owner>/readflow-web:latest -f web/Dockerfile web
#
# READFLOW_API_UPSTREAM (default `api:8000`) selects the API host:port.

# ── Stage 1: build the SPA ────────────────────
FROM docker.io/oven/bun:1.4.2 AS builder

WORKDIR /app

# Dependency layer — cached until package.json / bun.lock change.
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY . .
# `bun run build` = tsc typecheck + vite build → /app/dist
RUN bun run build

# ── Stage 2: serve ────────────────────────────
FROM docker.io/library/caddy:2-alpine

ENV READFLOW_API_UPSTREAM=api:8000

COPY --from=builder /app/dist /srv
COPY Caddyfile /etc/caddy/Caddyfile

EXPOSE 80
