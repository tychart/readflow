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
            raise RuntimeError(
                f"Voice directory '{self._voices_dir}' does not exist. "
                "Provide built-in voices under server/voices/<voice_id>/."
            )
        for voice_dir in sorted(self._voices_dir.iterdir()):
            if not voice_dir.is_dir():
                continue
            meta_path = voice_dir / "meta.json"
            ref_audio_path = voice_dir / "ref.wav"
            ref_text_path = voice_dir / "ref.txt"
            missing = [
                str(path.name)
                for path in (meta_path, ref_audio_path, ref_text_path)
                if not path.exists()
            ]
            if missing:
                raise RuntimeError(
                    f"Voice '{voice_dir.name}' is missing required files: {', '.join(missing)}"
                )
            meta = json.loads(meta_path.read_text(encoding="utf-8"))
            reference_text = ref_text_path.read_text(encoding="utf-8").strip()
            if not reference_text:
                raise RuntimeError(f"Voice '{voice_dir.name}' has an empty ref.txt")
            voice = VoiceDefinition(
                id=voice_dir.name,
                display_name=meta.get("display_name", voice_dir.name.replace("_", " ").title()),
                description=meta.get("description"),
                ref_audio_path=str(ref_audio_path),
                ref_text_path=str(ref_text_path),
            )
            self._voices[voice.id] = voice
        if not self._voices:
            raise RuntimeError(
                f"No built-in voices were discovered in '{self._voices_dir}'. "
                "Add real voice folders before starting the app."
            )
