from __future__ import annotations

import json
import re
from collections.abc import Callable

from fastapi import APIRouter, Depends, HTTPException, Request, WebSocket
from fastapi.responses import FileResponse
from starlette.background import BackgroundTask
from starlette.datastructures import FormData, UploadFile
from starlette.exceptions import HTTPException as StarletteHTTPException
from starlette.formparsers import MultiPartException
from starlette.websockets import WebSocketDisconnect

from app.core.services import AppServices
from app.jobs.models import ChunkStatus, Job, JobStatus
from app.schemas.api import (
    AdminConfigResponse,
    AdminConfigUpdateRequest,
    AdminMemoryStats,
    AdminStateResponse,
    ChunkReprocessRequest,
    ChunkVersionRequest,
    CreateJobResponse,
    JobDetailResponse,
    JobManifestResponse,
    JobSummaryResponse,
    PlaybackUpdateRequest,
    SchedulerStateResponse,
    UpdateVoiceRequest,
    VoiceResponse,
    WsEnvelope,
    chunk_to_response,
    job_to_detail,
    job_to_summary,
)
from app.synthesis.provider import ModelVRAMError

SUPPORTED_MODEL_IDS: set[str] = {
    "Qwen/Qwen3-TTS-12Hz-0.6B-Base",
    "Qwen/Qwen3-TTS-12Hz-1.7B-Base",
}

# Body schema for /jobs. These endpoints parse the form themselves (see
# `read_job_form`) so the part-size limit can be raised above Starlette's 1 MiB
# default; declaring the shape here keeps /docs useful.
JOB_FORM_REQUEST_BODY: dict[str, object] = {
    "content": {
        "multipart/form-data": {
            "schema": {
                "type": "object",
                "properties": {
                    "text": {
                        "type": "string",
                        "description": "Long-form text to narrate (normalized server-side).",
                    },
                    "title": {"type": "string"},
                    "voice_id": {"type": "string"},
                    "model_id": {"type": "string"},
                    "language": {"type": "string"},
                    "file": {
                        "type": "string",
                        "format": "binary",
                        "description": "Optional .txt upload used instead of pasted text.",
                    },
                },
            }
        }
    },
    "required": True,
}


def _format_bytes(byte_count: int) -> str:
    """Human-readable size for API error messages (limits are configurable)."""
    if byte_count >= 1024 * 1024:
        return f"{byte_count / 1024 / 1024:.1f} MB"
    return f"{byte_count / 1024:.0f} KB"


def _reject_oversized(byte_count: int, max_source_bytes: int, label: str) -> None:
    if byte_count <= max_source_bytes:
        return
    raise HTTPException(
        status_code=413,
        detail=(
            f"{label} is too large ({_format_bytes(byte_count)}, "
            f"limit is {_format_bytes(max_source_bytes)})"
        ),
    )


def _read_form_text(form: FormData, name: str) -> str | None:
    """Return a non-empty string form field, ignoring missing/blank values."""
    value = form.get(name)
    if not isinstance(value, str) or not value.strip():
        return None
    return value


async def _read_job_form(request: Request, max_source_bytes: int) -> FormData:
    """Parse a job creation form with a raised multipart part limit.

    FastAPI's `Form(...)`/`File(...)` parameters always parse with Starlette's
    1 MiB `max_part_size`, which made a long *paste* fail while an identical
    *.txt upload succeeded. The job endpoint therefore parses its own form.
    `max_part_size` only bounds individual non-file parts; uploads spool to disk
    and are measured against the same limit in `_resolve_job_source_text`.
    """
    try:
        return await request.form(max_part_size=max_source_bytes)
    except MultiPartException as exc:
        # Raised when a parser is driven outside an ASGI scope.
        raise HTTPException(
            status_code=413,
            detail=f"Text is too large (limit is {_format_bytes(max_source_bytes)})",
        ) from exc
    except StarletteHTTPException as exc:
        # Inside an app Starlette turns its own part-size breach into a 400
        # before the route ever sees the exception, which is why a long paste
        # surfaced as "400 Part exceeded maximum size of 1024KB."
        if exc.status_code != 400 or "exceeded maximum size" not in str(exc.detail):
            raise
        raise HTTPException(
            status_code=413,
            detail=f"Text is too large (limit is {_format_bytes(max_source_bytes)})",
        ) from exc


def _read_form_file(form: FormData, name: str) -> UploadFile | None:
    value = form.get(name)
    return value if isinstance(value, UploadFile) else None


async def _resolve_job_source_text(form: FormData, *, max_source_bytes: int) -> tuple[str, str]:
    """Resolve (text, source_kind) from an uploaded .txt or the text field.

    Starlette streams file parts to disk, so an upload can legitimately exceed
    the per-part limit; both paths are measured against `max_source_bytes` here.
    """
    upload = _read_form_file(form, "file")
    if upload is not None:
        if not upload.filename or not upload.filename.endswith(".txt"):
            raise HTTPException(status_code=400, detail="Only .txt uploads are supported")
        raw = await upload.read()
        _reject_oversized(len(raw), max_source_bytes, "Uploaded text")
        try:
            return raw.decode("utf-8"), "txt_file"
        except UnicodeDecodeError as exc:
            raise HTTPException(
                status_code=400, detail=".txt uploads must be UTF-8 encoded"
            ) from exc
    text = _read_form_text(form, "text") or ""
    _reject_oversized(len(text.encode("utf-8")), max_source_bytes, "Text")
    return text, "text"


def build_router(get_services: Callable[[], AppServices]) -> APIRouter:
    router = APIRouter(prefix="/api")

    async def services() -> AppServices:
        return get_services()

    def admin_config_response(app_services: AppServices) -> AdminConfigResponse:
        runtime = app_services.settings.runtime
        return AdminConfigResponse(
            device=runtime.device,
            idle_unload_seconds=runtime.idle_unload_seconds,
            max_prebuffer_seconds=runtime.max_prebuffer_seconds,
            target_buffer_seconds=runtime.target_buffer_seconds,
            batch_candidates_small_model=runtime.batch_candidates_small_model,
            batch_candidates_large_model=runtime.batch_candidates_large_model,
            vram_soft_limit_mb=runtime.vram_soft_limit_mb,
            vram_hard_limit_mb=runtime.vram_hard_limit_mb,
        )

    def contiguous_export_wav_paths(job: Job) -> list[str]:
        wav_paths: list[str] = []
        for expected_index, chunk in enumerate(sorted(job.chunks, key=lambda item: item.index)):
            if chunk.index != expected_index:
                break
            if chunk.status != ChunkStatus.WRITTEN or not chunk.wav_path:
                break
            wav_paths.append(chunk.wav_path)
        return wav_paths

    def sanitize_download_name(value: str | None) -> str:
        raw = (value or "readflow-job").strip().lower()
        sanitized = re.sub(r"[^a-z0-9]+", "-", raw).strip("-")
        return sanitized[:80] or "readflow-job"

    @router.get("/jobs", response_model=list[JobSummaryResponse])
    async def list_jobs(app_services: AppServices = Depends(services)) -> list[JobSummaryResponse]:
        return [job_to_summary(job) for job in app_services.job_manager.list_jobs()]

    @router.post(
        "/jobs",
        response_model=CreateJobResponse,
        openapi_extra={"requestBody": JOB_FORM_REQUEST_BODY},
    )
    async def create_job(
        request: Request,
        app_services: AppServices = Depends(services),
    ) -> CreateJobResponse:
        max_source_bytes = app_services.settings.max_source_bytes
        form = await _read_job_form(request, max_source_bytes)
        payload_text, source_kind = await _resolve_job_source_text(
            form, max_source_bytes=max_source_bytes
        )
        if not payload_text:
            raise HTTPException(status_code=400, detail="Provide text or a .txt upload")
        title = _read_form_text(form, "title")
        voice = _read_form_text(form, "voice_id") or app_services.settings.runtime.default_voice_id
        try:
            app_services.voice_registry.get_voice(voice)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        selected_model = (
            _read_form_text(form, "model_id") or app_services.settings.runtime.default_model_id
        )
        if selected_model not in SUPPORTED_MODEL_IDS:
            raise HTTPException(
                status_code=400,
                detail=(
                    f"Unsupported model '{selected_model}'. Supported models: "
                    f"{', '.join(sorted(SUPPORTED_MODEL_IDS))}"
                ),
            )
        job = app_services.job_manager.create_job(
            source_text=payload_text,
            source_kind=source_kind,
            model_id=selected_model,
            voice_id=voice,
            language=_read_form_text(form, "language")
            or app_services.settings.runtime.default_language,
            title=title,
        )
        detail = job_to_detail(job)
        # Streamed job payloads carry the summary only. `source_text` is static
        # per job and is fetched over HTTP, so broadcasting it (megabytes for a
        # book) on every job event would be pure overhead.
        envelope = WsEnvelope(type="job_created", payload={"job": job_to_summary(job).model_dump()})
        app_services.telemetry.record_event("job_created", {"job_id": job.id})
        await app_services.hub.broadcast(envelope.model_dump())
        return CreateJobResponse(job=detail)

    @router.get("/jobs/{job_id}", response_model=JobDetailResponse)
    async def get_job(
        job_id: str, app_services: AppServices = Depends(services)
    ) -> JobDetailResponse:
        try:
            return job_to_detail(app_services.job_manager.get_job(job_id))
        except KeyError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc

    @router.get("/jobs/{job_id}/manifest", response_model=JobManifestResponse)
    async def get_manifest(
        job_id: str, app_services: AppServices = Depends(services)
    ) -> JobManifestResponse:
        try:
            job = app_services.job_manager.get_job(job_id)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        init_path = app_services.media_store.init_segment_path(job_id)
        return JobManifestResponse(
            mime_type=app_services.settings.chunk_mime_type,
            init_segment_url=f"/api/jobs/{job_id}/chunks/init" if init_path.exists() else None,
            chunks=[
                chunk_to_response(job, chunk)
                for chunk in sorted(job.chunks, key=lambda item: item.index)
            ],
        )

    @router.post("/jobs/{job_id}/chunks/{chunk_index}/reprocess", response_model=JobDetailResponse)
    async def reprocess_chunk(
        job_id: str,
        chunk_index: int,
        request: ChunkReprocessRequest,
        app_services: AppServices = Depends(services),
    ) -> JobDetailResponse:
        """Reprocess a specific chunk, optionally with new text/voice."""
        try:
            job = app_services.job_manager.get_job(job_id)
        except KeyError:
            raise HTTPException(status_code=404, detail="Job not found") from None

        # Check if chunk exists
        chunk = None
        for c in job.chunks:
            if c.index == chunk_index:
                chunk = c
                break
        if chunk is None:
            raise HTTPException(status_code=404, detail="Chunk not found") from None

        # Revive completed/failed jobs
        if job.status in {JobStatus.COMPLETED, JobStatus.FAILED}:
            app_services.job_manager.reactivate_job(job_id)

        # Check retry limit (max 3 total attempts including original = versions 0,1,2,3)
        latest_version = job.get_latest_chunk_version(chunk_index)
        if latest_version >= 3:
            raise HTTPException(status_code=409, detail="Maximum retry attempts exceeded")

        # Determine text and voice for the new version
        text = request.new_text if request.new_text is not None else chunk.text
        voice = request.new_voice_id if request.new_voice_id is not None else job.voice_id

        job = app_services.job_manager.add_versioned_chunk(
            job_id,
            text=text,
            char_start=chunk.char_start,
            char_end=chunk.char_end,
            plan_version=job.plan_version,
            voice_id=voice,
            parent_index=chunk_index,
            retries=latest_version,
        )

        detail = job_to_detail(job)
        await app_services.hub.broadcast(
            WsEnvelope(type="job_updated", payload={"job": detail.model_dump()}).model_dump()
        )
        return JobDetailResponse(**detail.model_dump())

    @router.post(
        "/jobs/{job_id}/chunks/{chunk_index}/set-active-version",
        response_model=JobDetailResponse,
    )
    async def set_active_chunk_version(
        job_id: str,
        chunk_index: int,
        request: ChunkVersionRequest,
        app_services: AppServices = Depends(services),
    ) -> JobDetailResponse:
        """Set the active version for a chunk index."""
        try:
            job = app_services.job_manager.get_job(job_id)
        except KeyError:
            raise HTTPException(status_code=404, detail="Job not found") from None

        job = app_services.job_manager.set_active_chunk_version(
            job_id, chunk_index, request.version
        )

        detail = job_to_detail(job)
        await app_services.hub.broadcast(
            WsEnvelope(type="job_updated", payload={"job": detail.model_dump()}).model_dump()
        )
        return JobDetailResponse(**detail.model_dump())

    @router.get("/jobs/{job_id}/chunks/init")
    async def get_init_segment(
        job_id: str, app_services: AppServices = Depends(services)
    ) -> FileResponse:
        path = app_services.media_store.init_segment_path(job_id)
        if not path.exists():
            raise HTTPException(status_code=404, detail="Init segment not ready")
        return FileResponse(path, media_type=app_services.settings.chunk_mime_type)

    @router.get("/jobs/{job_id}/chunks/{chunk_index}")
    async def get_chunk(
        job_id: str, chunk_index: int, app_services: AppServices = Depends(services)
    ) -> FileResponse:
        path = app_services.media_store.segment_path(job_id, chunk_index)
        if not path.exists():
            raise HTTPException(status_code=404, detail="Chunk not ready")
        return FileResponse(path, media_type=app_services.settings.chunk_mime_type)

    @router.get("/jobs/{job_id}/chunks/{chunk_index}/peaks")
    async def get_chunk_peaks(
        job_id: str, chunk_index: int, app_services: AppServices = Depends(services)
    ) -> FileResponse:
        path = app_services.media_store.peaks_path(job_id, chunk_index)
        if not path.exists():
            raise HTTPException(status_code=404, detail="Chunk peaks not ready")
        return FileResponse(path, media_type="application/json")

    @router.get("/jobs/{job_id}/download")
    async def download_job_audio(
        job_id: str, app_services: AppServices = Depends(services)
    ) -> FileResponse:
        try:
            job = app_services.job_manager.get_job(job_id)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc

        wav_paths = contiguous_export_wav_paths(job)
        if not wav_paths:
            raise HTTPException(status_code=409, detail="No contiguous rendered audio is ready")

        export_path = app_services.media_store.build_export_file(job_id, wav_paths)
        is_full_export = job.status == JobStatus.COMPLETED and len(wav_paths) == len(job.chunks)
        filename = sanitize_download_name(job.title)
        if not is_full_export:
            filename = f"{filename}-partial"

        return FileResponse(
            export_path,
            media_type="audio/mp4",
            filename=f"{filename}.m4a",
            background=BackgroundTask(export_path.unlink, missing_ok=True),
        )

    @router.post("/jobs/{job_id}/activate", response_model=JobSummaryResponse)
    async def activate_job(
        job_id: str, app_services: AppServices = Depends(services)
    ) -> JobSummaryResponse:
        try:
            job = app_services.job_manager.activate_job(job_id)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        summary = job_to_summary(job)
        await app_services.hub.broadcast(
            WsEnvelope(type="job_updated", payload={"job": summary.model_dump()}).model_dump()
        )
        return summary

    @router.post("/jobs/{job_id}/pause", response_model=JobSummaryResponse)
    async def pause_job(
        job_id: str, app_services: AppServices = Depends(services)
    ) -> JobSummaryResponse:
        try:
            job = app_services.job_manager.pause_job(job_id)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        summary = job_to_summary(job)
        await app_services.hub.broadcast(
            WsEnvelope(type="job_updated", payload={"job": summary.model_dump()}).model_dump()
        )
        return summary

    @router.post("/jobs/{job_id}/resume", response_model=JobSummaryResponse)
    async def resume_job(
        job_id: str, app_services: AppServices = Depends(services)
    ) -> JobSummaryResponse:
        try:
            job = app_services.job_manager.resume_job(job_id)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        summary = job_to_summary(job)
        await app_services.hub.broadcast(
            WsEnvelope(type="job_updated", payload={"job": summary.model_dump()}).model_dump()
        )
        return summary

    @router.post("/jobs/{job_id}/voice", response_model=JobDetailResponse)
    async def update_voice(
        job_id: str,
        request: UpdateVoiceRequest,
        app_services: AppServices = Depends(services),
    ) -> JobDetailResponse:
        try:
            app_services.voice_registry.get_voice(request.voice_id)
            job = app_services.job_manager.set_voice(job_id, request.voice_id)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        detail = job_to_detail(job)
        await app_services.hub.broadcast(
            WsEnvelope(type="job_updated", payload={"job": detail.model_dump()}).model_dump()
        )
        return detail

    @router.post("/jobs/{job_id}/playback", response_model=JobDetailResponse)
    async def update_playback(
        job_id: str,
        request: PlaybackUpdateRequest,
        app_services: AppServices = Depends(services),
    ) -> JobDetailResponse:
        try:
            job = app_services.job_manager.update_playback(
                job_id,
                current_time_seconds=request.current_time_seconds,
                is_playing=request.is_playing,
            )
        except KeyError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        return job_to_detail(job)

    @router.delete("/jobs/{job_id}", status_code=204)
    async def delete_job(job_id: str, app_services: AppServices = Depends(services)) -> None:
        app_services.job_manager.delete_job(job_id)
        app_services.media_store.remove_job(job_id)

    @router.get("/voices", response_model=list[VoiceResponse])
    async def list_voices(app_services: AppServices = Depends(services)) -> list[VoiceResponse]:
        return [
            VoiceResponse(
                id=voice.id, display_name=voice.display_name, description=voice.description
            )
            for voice in app_services.voice_registry.list_voices()
        ]

    @router.get("/admin/config", response_model=AdminConfigResponse)
    async def get_admin_config(
        app_services: AppServices = Depends(services),
    ) -> AdminConfigResponse:
        return admin_config_response(app_services)

    @router.post("/admin/config", response_model=AdminConfigResponse)
    async def update_admin_config(
        request: AdminConfigUpdateRequest,
        app_services: AppServices = Depends(services),
    ) -> AdminConfigResponse:
        runtime = app_services.settings.runtime
        for field_name, value in request.model_dump(exclude_none=True).items():
            setattr(runtime, field_name, value)
            # Propagate device setting change to the provider and model manager
            if field_name == "device":
                app_services.model_manager.set_device(str(value))
        config = admin_config_response(app_services)
        await app_services.hub.broadcast(
            WsEnvelope(type="admin_config_updated", payload=config.model_dump()).model_dump()
        )
        return config

    @router.get("/admin/state", response_model=AdminStateResponse)
    async def get_admin_state(app_services: AppServices = Depends(services)) -> AdminStateResponse:
        config = admin_config_response(app_services)
        scheduler = SchedulerStateResponse(
            queue_depth=app_services.job_manager.queue_depth(),
            batch_candidates=app_services.settings.runtime.batch_candidates_small_model,
        )
        try:
            mem_raw = await app_services.model_manager.memory_stats()
            memory = AdminMemoryStats(
                device=mem_raw[0],
                vram_total_mb=mem_raw[1],
                vram_used_mb=mem_raw[2],
                vram_reserved_mb=mem_raw[3],
                vram_free_mb=mem_raw[4],
                ram_total_mb=mem_raw[5],
                ram_free_mb=mem_raw[6],
                ram_used_mb=mem_raw[7],
            )
        except Exception:
            memory = None
        return AdminStateResponse(
            config=config,
            scheduler=scheduler,
            telemetry=app_services.telemetry.snapshot(),
            memory=memory,
        )

    @router.post("/admin/model/warm", response_model=dict[str, str])
    async def warm_model(app_services: AppServices = Depends(services)) -> dict[str, str]:
        try:
            await app_services.model_manager.ensure_loaded(
                app_services.settings.runtime.default_model_id
            )
        except ModelVRAMError as exc:
            await app_services.hub.broadcast(
                WsEnvelope(
                    type="model_state", payload={"state": app_services.model_manager.state}
                ).model_dump()
            )
            raise HTTPException(status_code=507, detail=str(exc)) from exc
        await app_services.hub.broadcast(
            WsEnvelope(
                type="model_state", payload={"state": app_services.model_manager.state}
            ).model_dump()
        )
        return {"status": "warm"}

    @router.post("/admin/model/evict", response_model=dict[str, str])
    async def evict_model(app_services: AppServices = Depends(services)) -> dict[str, str]:
        await app_services.model_manager.unload()
        await app_services.hub.broadcast(
            WsEnvelope(
                type="model_state", payload={"state": app_services.model_manager.state}
            ).model_dump()
        )
        return {"status": "evicted"}

    @router.websocket("/ws")
    async def websocket_endpoint(websocket: WebSocket) -> None:
        app_services = get_services()
        await app_services.hub.connect(websocket)
        try:
            await websocket.send_text(
                json.dumps(
                    WsEnvelope(
                        type="telemetry",
                        payload={"telemetry": app_services.telemetry.snapshot()},
                    ).model_dump()
                )
            )
            while True:
                try:
                    message = await websocket.receive_text()
                except WebSocketDisconnect:
                    break

                # Plain-text heartbeat
                if message == "ping":
                    await websocket.send_text(json.dumps({"type": "pong", "payload": {}}))
                    continue

                # JSON-typed messages
                try:
                    data = json.loads(message)
                except json.JSONDecodeError:
                    continue

                msg_type = data.get("type")
                payload = data.get("payload", {})

                if msg_type == "playback_sync":
                    job_id = payload.get("job_id", "")
                    if job_id:
                        try:
                            app_services.job_manager.update_playback(
                                job_id,
                                current_time_seconds=payload.get("current_time_seconds", 0.0),
                                is_playing=payload.get("is_playing", True),
                            )
                        except KeyError:
                            pass  # stale job id, ignore silently
        finally:
            await app_services.hub.disconnect(websocket)

    return router
