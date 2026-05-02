from __future__ import annotations

import json
from pathlib import Path

import pytest

from app.core.config import Settings
from app.voices.registry import VoiceRegistry


def test_voice_registry_discovers_real_voice_folders(tmp_path: Path):
    voices_dir = tmp_path / "voices"
    for voice_id, display_name in (("suzy", "Suzy"), ("howard", "Howard")):
        voice_dir = voices_dir / voice_id
        voice_dir.mkdir(parents=True)
        (voice_dir / "meta.json").write_text(
            json.dumps({"display_name": display_name, "description": f"{display_name} voice"}),
            encoding="utf-8",
        )
        (voice_dir / "ref.txt").write_text("Reference text for tests.", encoding="utf-8")
        (voice_dir / "ref.wav").write_bytes(b"RIFF....WAVE")

    settings = Settings(tts_provider="fake", voices_dir="voices")
    registry = VoiceRegistry(settings, tmp_path)

    assert [voice.id for voice in registry.list_voices()] == ["howard", "suzy"]
    assert registry.get_prompt("howard").reference_text == "Reference text for tests."


def test_voice_registry_requires_complete_voice_assets(tmp_path: Path):
    voice_dir = tmp_path / "voices" / "suzy"
    voice_dir.mkdir(parents=True)
    (voice_dir / "meta.json").write_text(json.dumps({"display_name": "Suzy"}), encoding="utf-8")
    (voice_dir / "ref.txt").write_text("Reference text for tests.", encoding="utf-8")

    settings = Settings(tts_provider="fake", voices_dir="voices")

    with pytest.raises(RuntimeError, match="missing required files"):
        VoiceRegistry(settings, tmp_path)
