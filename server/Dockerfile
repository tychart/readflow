# syntax=docker/dockerfile:1.7
#
# ReadFlow API image — FastAPI + Qwen3-TTS. Build context is `server/`.
#
#   podman build -f server/Dockerfile --target cuda server                  # SDPA (default)
#   podman build -f server/Dockerfile --target cuda server \
#       --build-arg INSTALL_FLASH_ATTN=1 -t readflow-api:flash              # + flash-attn
#   podman build -f server/Dockerfile --target cpu  server                  # CPU only
#
# flash-attn is installed from a PREBUILT wheel, so no CUDA compiler is needed
# and the flash image builds in minutes rather than ~1 hour. That is exactly why
# torch is pinned to 2.9.0 in pyproject.toml: PyPI torch 2.9 is a CUDA 12.8 build
# and flash-attn 2.8.3 publishes a matching `cu12torch2.9` wheel. (torch 2.11 is
# a CUDA 13 build with no matching flash-attn wheel, which is what previously
# forced a from-source compile.)

ARG UV_VERSION=0.11.9

# ── Shared build toolchain ────────────────────────────────────────────────
# Deliberately Ubuntu 24.04 rather than python:*-slim: the venv records the
# interpreter path, so the builder and both runtime bases must agree on
# /usr/bin/python3.12 or the copied venv is dead on arrival.
FROM docker.io/library/ubuntu:24.04 AS base
ENV DEBIAN_FRONTEND=noninteractive \
    UV_LINK_MODE=copy \
    UV_PYTHON_DOWNLOADS=never
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3.12 \
    python3.12-venv \
    python3.12-dev \
    build-essential \
    curl \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*
ARG UV_VERSION
RUN curl -LsSf https://astral.sh/uv/${UV_VERSION}/install.sh | sh
ENV PATH="/root/.local/bin:${PATH}"
WORKDIR /app/server

# ── GPU/CUDA application environment ──────────────────────────────────────
FROM base AS builder
COPY pyproject.toml uv.lock ./
COPY app/ app/
COPY main.py ./
# `utils` installs psutil, which the Admin memory panel imports at runtime.
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-dev --extra utils

# Optional flash-attn. The wheel must match torch's CXX11 ABI, so it is detected
# rather than assumed; a mismatch is a hard error at build time.
ARG INSTALL_FLASH_ATTN=0
RUN --mount=type=cache,target=/root/.cache/uv \
    if [ "$INSTALL_FLASH_ATTN" = "1" ]; then \
        ABI=$(./.venv/bin/python -c \
            "import torch; print('TRUE' if torch._C._GLIBCXX_USE_CXX11_ABI else 'FALSE')"); \
        WHEEL="flash_attn-2.8.3%2Bcu12torch2.9cxx11abi${ABI}-cp312-cp312-linux_x86_64.whl"; \
        echo "Installing prebuilt flash-attn wheel for cxx11abi=${ABI}"; \
        cd / && uv pip install --no-config --python /app/server/.venv/bin/python --no-deps \
            "https://github.com/Dao-AILab/flash-attention/releases/download/v2.8.3/${WHEEL}"; \
    fi

# ── CPU application environment ───────────────────────────────────────────
FROM base AS builder-cpu
COPY pyproject.toml uv.lock ./
COPY app/ app/
COPY main.py ./
# This is the one stage that resolves instead of using the frozen lock: the lock
# pins the CUDA build of torch, and CPU torch wheels come from the PyTorch CPU
# index that uv selects with --torch-backend=cpu.
RUN --mount=type=cache,target=/root/.cache/uv \
    uv venv .venv && \
    uv pip install --python .venv/bin/python --torch-backend=cpu -e ".[utils]"

# ── Runtime: CPU ──────────────────────────────────────────────────────────
FROM docker.io/library/ubuntu:24.04 AS cpu
ENV DEBIAN_FRONTEND=noninteractive \
    PATH="/app/server/.venv/bin:${PATH}" \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    HF_HOME=/home/readflow/.cache/huggingface
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3.12 python3.12-venv libsndfile1 ffmpeg \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home --uid 10001 readflow \
    && mkdir -p /app/server /home/readflow/.cache/huggingface /tmp/readflow \
    && chown -R readflow:readflow /app /home/readflow /tmp/readflow
WORKDIR /app/server
COPY --from=builder-cpu --chown=readflow:readflow /app/server/.venv /app/server/.venv
COPY --chown=readflow:readflow app/ app/
COPY --chown=readflow:readflow main.py ./
COPY --chown=readflow:readflow pyproject.toml ./
COPY --chown=readflow:readflow voices/ voices/
USER readflow
EXPOSE 8000
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]

# ── Runtime: CUDA (default target — must stay last) ───────────────────────
FROM docker.io/nvidia/cuda:12.8.1-runtime-ubuntu24.04 AS cuda
ENV DEBIAN_FRONTEND=noninteractive \
    PATH="/app/server/.venv/bin:${PATH}" \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    HF_HOME=/home/readflow/.cache/huggingface
# libsndfile1 is the Ubuntu 24.04 package name (there is no `libsndfile1-2`).
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3.12 python3.12-venv libsndfile1 ffmpeg \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home --uid 10001 readflow \
    && mkdir -p /app/server /home/readflow/.cache/huggingface /tmp/readflow \
    && chown -R readflow:readflow /app /home/readflow /tmp/readflow
WORKDIR /app/server
COPY --from=builder --chown=readflow:readflow /app/server/.venv /app/server/.venv
COPY --chown=readflow:readflow app/ app/
COPY --chown=readflow:readflow main.py ./
COPY --chown=readflow:readflow pyproject.toml ./
# VoiceRegistry fails fast when the voices directory is missing or empty, so the
# built-in voices must be baked into the image.
COPY --chown=readflow:readflow voices/ voices/
USER readflow
EXPOSE 8000
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
