from __future__ import annotations

import asyncio
import io
import wave
from pathlib import Path
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient

from app.core.app import create_app
from app.core.config import Settings
from app.jobs.models import ChunkRecord
from app.synthesis.provider import QwenProvider
from app.voices.registry import VoiceRegistry


@pytest.mark.real_model
def test_real_qwen_provider_generates_audio_from_real_voice_clone_prompt():
    base_dir = Path(__file__).resolve().parents[2]
    settings = Settings(tts_provider="qwen")
    registry = VoiceRegistry(settings, base_dir)
    provider = QwenProvider(default_language=settings.runtime.default_language)

    provider.validate_environment()
    asyncio.run(provider.load_model(settings.runtime.default_model_id))
    prompt = registry.get_prompt("suzy")
    chunks = [
        ChunkRecord(
            job_id="real-job",
            index=0,
            text="A tiny real model check.",
            voice_id="suzy",
            plan_version=1,
            char_start=0,
            char_end=24,
            language=settings.runtime.default_language,
        ),
        ChunkRecord(
            job_id="real-job",
            index=1,
            text="This confirms batched generation works.",
            voice_id="suzy",
            plan_version=1,
            char_start=25,
            char_end=62,
            language=settings.runtime.default_language,
        ),
    ]

    try:
        results = asyncio.run(
            provider.synthesize_batch(settings.runtime.default_model_id, chunks, [prompt, prompt])
        )
    finally:
        asyncio.run(provider.unload_model())

    assert len(results) == 2
    assert results[0].wav_bytes
    with wave.open(io.BytesIO(results[0].wav_bytes), "rb") as wav_file:
        assert wav_file.getframerate() > 0
        assert wav_file.getnframes() > 0


@pytest.mark.real_model
def test_real_qwen_app_serves_packaged_segments(monkeypatch):
    monkeypatch.setenv("READFLOW_TTS_PROVIDER", "qwen")
    monkeypatch.setenv("READFLOW_TEMP_DIR_NAME", f"readflow-real-{uuid4()}")
    app = create_app()

    with TestClient(app) as client:
        response = client.post(
            "/api/jobs",
            data={"text": "Hello there. This is a tiny end-to-end real model test.", "voice_id": "suzy"},
        )
        assert response.status_code == 200
        job = response.json()["job"]

        asyncio.run(app.state.services.scheduler.run_once())

        manifest_response = client.get(f"/api/jobs/{job['id']}/manifest")
        assert manifest_response.status_code == 200
        manifest = manifest_response.json()

        written_chunk = next(chunk for chunk in manifest["chunks"] if chunk["status"] == "written")
        init_response = client.get(manifest["init_segment_url"])
        segment_response = client.get(written_chunk["segment_url"])

        assert init_response.status_code == 200
        assert segment_response.status_code == 200
        assert init_response.content
        assert segment_response.content
