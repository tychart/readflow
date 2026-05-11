# syntax=docker/dockerfile:1.7
#
# Multi-stage build:
#   Stage 1 (builder) — compile flash-attn inside a CUDA image with
#                       a GCC version compatible with CUDA 12.8
#   Stage 2 (runtime) — ship the pre-built environment, no compiler needed
#
# Usage:
#   docker build -t readflow-server:cuda -f server/Dockerfile .
#   docker run --rm --gpus all --ipc=host -p 8000:8000 readflow-server:cuda

# ── Stage 1: builder ──────────────────────────
FROM nvidia/cuda:12.8.1-devel-ubuntu24.04 AS builder

ENV DEBIAN_FRONTEND=noninteractive

# FlashAttention: only compile for Ampere (RTX 30xx = SM 86).
# This is far faster than the default multi-arch build.
ENV FLASH_ATTN_CUDA_ARCHS=86
ENV MAX_JOBS=4

# Use copy link mode so the venv files get correct permissions in stage 2
ENV UV_LINK_MODE=copy

# Install system deps (gcc-13 is the default on Ubuntu 24.04,
# and CUDA 12.8 supports GCC up to 14 — so we are safe).
# Also install ffmpeg which the app needs for media packaging.
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3.12 \
    python3.12-venv \
    python3-pip \
    build-essential \
    ninja-build \
    libsndfile1-dev \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/*

# Install uv (the Python package manager)
RUN curl -LsSf https://astral.sh/uv/0.8.14/install.sh | sh
ENV PATH="/root/.local/bin:${PATH}"

WORKDIR /app/server

# ── Layer cache: copy only dependency files first ──
COPY pyproject.toml uv.lock ./
COPY app/ app/
COPY main.py ./

# Install the cuda extra — this is where flash-attn compiles.
# Docker caches this layer; it only rebuilds when pyproject.toml / uv.lock changes.
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --extra cuda --no-dev

# ── Stage 2: runtime ──────────────────────────
FROM nvidia/cuda:12.8.1-runtime-ubuntu24.04

ENV DEBIAN_FRONTEND=noninteractive
ENV PATH="/app/server/.venv/bin:${PATH}"
ENV PYTHONUNBUFFERED=1

# Runtime deps: just Python, libsndfile, and ffmpeg.
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3.12 \
    python3.12-venv \
    libsndfile1-2 \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app/server

# Copy the built venv and application code from the builder stage
COPY --from=builder /app/server/.venv /app/server/.venv
COPY --from=builder /app/server/app /app/server/app
COPY --from=builder /app/server/main.py /app/server/main.py
COPY --from=builder /app/server/pyproject.toml /app/server/pyproject.toml

EXPOSE 8000

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
