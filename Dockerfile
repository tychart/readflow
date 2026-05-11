# ──────────────────────────────────────────────
# Multi-stage build
#   Stage 1 (builder): compile flash-attn with CUDA-compatible GCC
#   Stage 2 (runtime):  ship the pre-built wheel, no compiler needed
# ──────────────────────────────────────────────

# ── Stage 1: builder ──────────────────────────
FROM nvidia/cuda:12.8.0-devel-ubuntu24.04 AS builder

# Ubuntu 24.04 ships GCC 13 — compatible with CUDA 12.8
# Install Python and uv
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3.12 python3.12-venv python3.12-dev \
    gcc g++ ninja-build cmake \
    libsndfile1-dev ffmpeg \
    && rm -rf /var/lib/apt/lists/*

RUN curl -LsSf https://astral.sh/uv/0.8.14/install.sh | sh

WORKDIR /build

# Copy just pyproject + lock to leverage uv's caching
COPY server/pyproject.toml server/uv.lock ./
COPY server/app/ app/

# Create venv with cuda extra (flash-attn compiles here with compatible GCC)
RUN /root/.local/bin/uv venv .venv && \
    .venv/bin/uv pip install --python .venv/bin/python3.12 \
    -e ".[cuda,dev]" && \
    # Pre-warm the model download so runtime doesn't stall
    true

# ── Stage 2: runtime ──────────────────────────
FROM nvidia/cuda:12.8.0-runtime-ubuntu24.04

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3.12 python3.12-venv \
    libsndfile1-2 ffmpeg \
    && rm -rf /var/lib/apt/lists/*

COPY --from=builder /build/.venv /app/.venv
COPY server/app /app/app
COPY server/main.py /app/main.py
COPY server/pyproject.toml /app/pyproject.toml

WORKDIR /app

ENV PATH="/app/.venv/bin:$PATH" \
    READFLOW_TTS_PROVIDER=qwen \
    PYTHONUNBUFFERED=1

EXPOSE 8000

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
