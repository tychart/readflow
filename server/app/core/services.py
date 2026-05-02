from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from app.chunking.planner import ChunkPlanner
from app.core.config import Settings
from app.core.hub import WebSocketHub
from app.jobs.manager import JobManager
from app.media.store import MediaStore
from app.scheduler.service import SchedulerService
from app.synthesis.model_manager import ModelManager
from app.synthesis.provider import FakeQwenProvider, QwenProvider, SynthesisProvider
from app.synthesis.worker import SynthesisWorker
from app.telemetry.service import TelemetryService
from app.voices.registry import VoiceRegistry


@dataclass(slots=True)
class AppServices:
    settings: Settings
    job_manager: JobManager
    planner: ChunkPlanner
    media_store: MediaStore
    telemetry: TelemetryService
    voice_registry: VoiceRegistry
    provider: SynthesisProvider
    model_manager: ModelManager
    worker: SynthesisWorker
    scheduler: SchedulerService
    hub: WebSocketHub


def build_services(settings: Settings, base_dir: Path) -> AppServices:
    job_manager = JobManager()
    planner = ChunkPlanner(settings.runtime)
    media_store = MediaStore(settings)
    telemetry = TelemetryService(settings.runtime.recent_events_limit)
    voice_registry = VoiceRegistry(settings, base_dir)
    voice_registry.get_voice(settings.runtime.default_voice_id)
    provider: SynthesisProvider = (
        FakeQwenProvider()
        if settings.tts_provider == "fake"
        else QwenProvider(default_language=settings.runtime.default_language)
    )
    provider.validate_environment()
    hub = WebSocketHub()
    model_manager = ModelManager(provider, telemetry, settings.runtime)
    worker = SynthesisWorker(
        config=settings.runtime,
        provider=provider,
        model_manager=model_manager,
        media_store=media_store,
        voice_registry=voice_registry,
        telemetry=telemetry,
    )
    scheduler = SchedulerService(
        config=settings.runtime,
        job_manager=job_manager,
        planner=planner,
        worker=worker,
        model_manager=model_manager,
        telemetry=telemetry,
        hub=hub,
    )
    return AppServices(
        settings=settings,
        job_manager=job_manager,
        planner=planner,
        media_store=media_store,
        telemetry=telemetry,
        voice_registry=voice_registry,
        provider=provider,
        model_manager=model_manager,
        worker=worker,
        scheduler=scheduler,
        hub=hub,
    )
