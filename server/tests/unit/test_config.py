from __future__ import annotations

from fastapi.testclient import TestClient

from app.core.app import create_app
from app.core.config import Settings
from app.synthesis.provider import FakeQwenProvider


def test_settings_default_to_real_qwen_runtime():
    settings = Settings()

    assert settings.tts_provider == "qwen"
    assert settings.runtime.default_model_id == "Qwen/Qwen3-TTS-12Hz-0.6B-Base"
    assert settings.runtime.default_voice_id == "suzy"
    assert settings.runtime.default_language == "English"


def test_app_fixture_can_override_provider_to_fake(monkeypatch):
    monkeypatch.setenv("READFLOW_TTS_PROVIDER", "fake")
    app = create_app()

    with TestClient(app):
        assert isinstance(app.state.services.provider, FakeQwenProvider)
