from __future__ import annotations

from functools import cached_property
from typing import Literal

from pydantic import BaseModel, Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class RuntimeConfig(BaseModel):
    device: Literal["auto", "cpu", "gpu"] = "auto"
    idle_unload_seconds: int = 300
    max_prebuffer_seconds: int = 300
    target_buffer_seconds: int = 60
    planning_tick_seconds: float = 0.2
    # How many chunks the planner keeps ready per schedulable job. Must be at
    # least the largest batch candidate, otherwise no single job can fill a
    # batch and the GPU runs undersized batches. Inactive (background) jobs use
    # the same window so they render at full batch size too.
    plan_ahead_chunks: int = 16
    batch_candidates_small_model: list[int] = Field(
        default_factory=lambda: [8, 7, 6, 5, 4, 3, 2, 1]
    )
    batch_candidates_large_model: list[int] = Field(default_factory=lambda: [6, 5, 4, 3, 2, 1])
    vram_soft_limit_mb: int = 9000
    vram_hard_limit_mb: int = 11000
    # Failed render attempts before a chunk is marked failed and skipped. The
    # job keeps rendering its other chunks; only the chunk is abandoned.
    chunk_max_attempts: int = 3
    # Deadlines for the provider's single worker thread. A model load can
    # legitimately include a first-time download, so it gets a much larger
    # budget than a synthesis batch. A timeout flags the model as errored and
    # pauses dispatch until the provider is reset from Admin.
    model_load_timeout_seconds: float = 900.0
    synthesis_timeout_seconds: float = 300.0
    default_model_id: str = "Qwen/Qwen3-TTS-12Hz-0.6B-Base"
    default_voice_id: str = "suzy"
    default_language: str = "English"
    chunk_target_chars: int = 700
    estimated_chars_per_second: float = 18.0
    recent_events_limit: int = 50


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="READFLOW_", case_sensitive=False)

    app_name: str = "ReadFlow"
    tts_provider: Literal["qwen", "fake"] = "qwen"
    scheduler_autostart: bool = True
    voices_dir: str = "voices"
    temp_dir_name: str = "readflow"
    # Largest source text (UTF-8 bytes) accepted for a job, whether pasted or
    # uploaded. Also used as the multipart part limit, because Starlette's
    # default (1 MiB) silently made the paste path far stricter than uploads.
    # 64 MiB covers full-length books (War and Peace is ~3 MiB of text) with
    # plenty of headroom while still bounding in-memory jobs.
    max_source_bytes: int = 64 * 1024 * 1024
    runtime: RuntimeConfig = Field(default_factory=RuntimeConfig)

    @cached_property
    def chunk_mime_type(self) -> str:
        return 'audio/mp4; codecs="mp4a.40.2"'


def get_settings() -> Settings:
    return Settings()
