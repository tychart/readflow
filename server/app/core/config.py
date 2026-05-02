from __future__ import annotations

from functools import cached_property
from typing import Literal

from pydantic import BaseModel, Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class RuntimeConfig(BaseModel):
    idle_unload_seconds: int = 300
    max_prebuffer_seconds: int = 300
    target_buffer_seconds: int = 45
    planning_tick_seconds: float = 0.2
    inactive_job_ahead_chunks: int = 1
    batch_candidates_small_model: list[int] = Field(
        default_factory=lambda: [8, 7, 6, 5, 4, 3, 2, 1]
    )
    batch_candidates_large_model: list[int] = Field(default_factory=lambda: [6, 5, 4, 3, 2, 1])
    vram_soft_limit_mb: int = 9000
    vram_hard_limit_mb: int = 11000
    default_model_id: str = "Qwen/Qwen3-TTS-12Hz-0.6B-Base"
    default_voice_id: str = "suzy"
    default_language: str = "English"
    chunk_startup_target_chars: int = 140
    chunk_safety_target_chars: int = 260
    chunk_steady_target_chars: int = 700
    estimated_chars_per_second: float = 18.0
    recent_events_limit: int = 50


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="READFLOW_", case_sensitive=False)

    app_name: str = "ReadFlow"
    tts_provider: Literal["qwen", "fake"] = "qwen"
    voices_dir: str = "voices"
    temp_dir_name: str = "readflow"
    runtime: RuntimeConfig = Field(default_factory=RuntimeConfig)

    @cached_property
    def chunk_mime_type(self) -> str:
        return 'audio/mp4; codecs="mp4a.40.2"'


def get_settings() -> Settings:
    return Settings()
