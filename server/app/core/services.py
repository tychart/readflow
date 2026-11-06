from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from app.chunking.planner import ChunkPlanner
from app.core.config import Settings
from app.core.hub import WebSocketHub
from app.core.identity import DEFAULT_USER_ID
from app.db.memory import MemoryDatabase
from app.db.models import User
from app.db.protocols import Database
from app.jobs.manager import JobManager
from app.library.progress_service import ProgressService
from app.library.service import LibraryService
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
    # Storage seam. Services depend on the protocol, never on the in-memory
    # implementation, so a SQL adapter is a one-line construction change here.
    database: Database
    current_user: User
    job_manager: JobManager
    library: LibraryService
    progress: ProgressService
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
    database: Database = MemoryDatabase()
    current_user = database.get_user(DEFAULT_USER_ID)
    if current_user is None:  # pragma: no cover - the adapter seeds it
        raise RuntimeError("The database did not seed a default user")
    job_manager = JobManager(database)
    library = LibraryService(database)
    progress = ProgressService(
        database,
        estimated_chars_per_second=settings.runtime.estimated_chars_per_second,
    )
    planner = ChunkPlanner(settings.runtime)
    media_store = MediaStore(settings)
    telemetry = TelemetryService(settings.runtime.recent_events_limit)
    voice_registry = VoiceRegistry(settings, base_dir)
    voice_registry.get_voice(settings.runtime.default_voice_id)
    provider: SynthesisProvider = (
        FakeQwenProvider()
        if settings.tts_provider == "fake"
        else QwenProvider(
            default_language=settings.runtime.default_language,
            device=settings.runtime.device,
            estimated_chars_per_second=settings.runtime.estimated_chars_per_second,
            synthesis_token_headroom=settings.runtime.synthesis_token_headroom,
        )
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
        hub=hub,
    )
    scheduler = SchedulerService(
        config=settings.runtime,
        chunk_mime_type=settings.chunk_mime_type,
        job_manager=job_manager,
        planner=planner,
        worker=worker,
        model_manager=model_manager,
        telemetry=telemetry,
        hub=hub,
    )
    return AppServices(
        settings=settings,
        database=database,
        current_user=current_user,
        job_manager=job_manager,
        library=library,
        progress=progress,
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
