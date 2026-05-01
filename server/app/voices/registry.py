from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

from app.core.config import Settings


@dataclass(slots=True)
class VoicePrompt:
    voice_id: str
    reference_text: str
    reference_audio_path: str


@dataclass(slots=True)
class VoiceDefinition:
    id: str
    display_name: str
    description: str | None
    ref_audio_path: str
    ref_text_path: str


class VoiceRegistry:
    def __init__(self, settings: Settings, base_dir: Path) -> None:
        self._voices_dir = base_dir / settings.voices_dir
        self._voices: dict[str, VoiceDefinition] = {}
        self._prompt_cache: dict[str, VoicePrompt] = {}
        self._load_voices()

    def list_voices(self) -> list[VoiceDefinition]:
        return sorted(self._voices.values(), key=lambda item: item.display_name.lower())

    def get_voice(self, voice_id: str) -> VoiceDefinition:
        try:
            return self._voices[voice_id]
        except KeyError as exc:
            raise KeyError(f"Unknown voice '{voice_id}'") from exc

    def get_prompt(self, voice_id: str) -> VoicePrompt:
        if voice_id in self._prompt_cache:
            return self._prompt_cache[voice_id]
        voice = self.get_voice(voice_id)
        prompt = VoicePrompt(
            voice_id=voice.id,
            reference_text=Path(voice.ref_text_path).read_text(encoding="utf-8").strip(),
            reference_audio_path=voice.ref_audio_path,
        )
        self._prompt_cache[voice_id] = prompt
        return prompt

    def _load_voices(self) -> None:
        if not self._voices_dir.exists():
            self._voices_dir.mkdir(parents=True, exist_ok=True)
        for voice_dir in self._voices_dir.iterdir():
            if not voice_dir.is_dir():
                continue
            meta_path = voice_dir / "meta.json"
            ref_audio_path = voice_dir / "ref.wav"
            ref_text_path = voice_dir / "ref.txt"
            if not meta_path.exists() or not ref_audio_path.exists() or not ref_text_path.exists():
                continue
            meta = json.loads(meta_path.read_text(encoding="utf-8"))
            voice = VoiceDefinition(
                id=voice_dir.name,
                display_name=meta.get("display_name", voice_dir.name.replace("_", " ").title()),
                description=meta.get("description"),
                ref_audio_path=str(ref_audio_path),
                ref_text_path=str(ref_text_path),
            )
            self._voices[voice.id] = voice
        if not self._voices:
            self._bootstrap_default_voices()
            self._load_voices()

    def _bootstrap_default_voices(self) -> None:
        seed_voices = {
            "suzy": {
                "display_name": "Suzy",
                "description": "Warm default narrator voice.",
            },
            "male_default": {
                "display_name": "Milo",
                "description": "Calm alternate narrator voice.",
            },
        }
        silent_wav = (
            b"RIFF$\x08\x00\x00WAVEfmt "
            b"\x10\x00\x00\x00\x01\x00\x01\x00D\xac\x00\x00\x88X\x01\x00\x02\x00\x10\x00data"
            b"\x00\x08\x00\x00" + b"\x00" * 2048
        )
        for voice_id, meta in seed_voices.items():
            voice_dir = self._voices_dir / voice_id
            voice_dir.mkdir(parents=True, exist_ok=True)
            (voice_dir / "meta.json").write_text(json.dumps(meta), encoding="utf-8")
            (voice_dir / "ref.txt").write_text(
                "This is a placeholder reference transcript for development.", encoding="utf-8"
            )
            (voice_dir / "ref.wav").write_bytes(silent_wav)
