from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from app.auth.service import AuthService
from app.auth.throttle import LoginThrottle
from app.chunking.planner import ChunkPlanner
from app.core.config import Settings
from app.core.hub import WebSocketHub
from app.db.memory import MemoryDatabase
from app.db.postgres import PostgresDatabase
from app.db.protocols import Database
from app.jobs.manager import JobManager
from app.media.store import MediaStore
from app.scheduler.service import SchedulerService
from app.scheduler.source_cache import SourceTextCache
from app.synthesis.model_manager import ModelManager
from app.synthesis.provider import FakeQwenProvider, QwenProvider, SynthesisProvider
from app.synthesis.worker import SynthesisWorker
from app.telemetry.service import TelemetryService
from app.voices.registry import VoiceRegistry


@dataclass(slots=True)
class AppServices:
    """The process-wide, system-scoped service graph.

    There is deliberately no `job_manager`/`library`/`progress` here: those are
    per-user scopes, built per request by `app.core.user_services`. What lives
    here is what one machine owns — the database, the scheduler, the GPU, the
    files, the event hub — plus `scheduler_jobs` and `auth`, which are
    system-scoped by nature.
    """

    settings: Settings
    # Storage seam. Services depend on the protocol, never on the in-memory
    # implementation, so a SQL adapter is a one-line construction change here.
    database: Database
    auth: AuthService
    # The scheduler's job manager: `user_id=None` means "every user's jobs".
    scheduler_jobs: JobManager
    planner: ChunkPlanner
    media_store: MediaStore
    telemetry: TelemetryService
    voice_registry: VoiceRegistry
    provider: SynthesisProvider
    model_manager: ModelManager
    worker: SynthesisWorker
    scheduler: SchedulerService
    hub: WebSocketHub


async def build_services(
    settings: Settings, base_dir: Path, *, database: Database | None = None
) -> AppServices:
    """Construct the whole service graph once per process.

    `database` is injectable so a test (or the diagnostics probe) can wrap the
    adapter in a counter, and so the Postgres adapter can be selected without
    touching every constructor.
    """
    if database is None:
        # One setting decides the adapter: a URL means Postgres, no URL means
        # in-memory (tests, `dev.sh --memory`).
        database = (
            PostgresDatabase(settings.database_url) if settings.database_url else MemoryDatabase()
        )
    # System scope: the scheduler serves every user's jobs because one GPU does.
    # Per-user scopes are built per request (app.core.user_services).
    scheduler_jobs = JobManager(database, user_id=None)
    auth = AuthService(
        database,
        settings,
        LoginThrottle(
            failures_before_lockout=settings.login_throttle_failures,
            window_seconds=settings.login_throttle_window_seconds,
        ),
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
        job_manager=scheduler_jobs,
        planner=planner,
        worker=worker,
        model_manager=model_manager,
        telemetry=telemetry,
        hub=hub,
        source_cache=SourceTextCache(settings.source_cache_chars),
    )
    return AppServices(
        settings=settings,
        database=database,
        auth=auth,
        scheduler_jobs=scheduler_jobs,
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
