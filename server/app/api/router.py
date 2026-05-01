from __future__ import annotations

import json
from collections.abc import Callable

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile, WebSocket
from fastapi.responses import FileResponse
from starlette.websockets import WebSocketDisconnect

from app.core.services import AppServices
from app.schemas.api import (
    AdminConfigResponse,
    AdminConfigUpdateRequest,
    AdminStateResponse,
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


def build_router(get_services: Callable[[], AppServices]) -> APIRouter:
    router = APIRouter(prefix="/api")

    def services() -> AppServices:
        return get_services()

    def admin_config_response(app_services: AppServices) -> AdminConfigResponse:
        runtime = app_services.settings.runtime
        return AdminConfigResponse(
            idle_unload_seconds=runtime.idle_unload_seconds,
            max_prebuffer_seconds=runtime.max_prebuffer_seconds,
            target_buffer_seconds=runtime.target_buffer_seconds,
            batch_candidates_small_model=runtime.batch_candidates_small_model,
            batch_candidates_large_model=runtime.batch_candidates_large_model,
            vram_soft_limit_mb=runtime.vram_soft_limit_mb,
            vram_hard_limit_mb=runtime.vram_hard_limit_mb,
        )

    @router.get("/jobs", response_model=list[JobSummaryResponse])
    async def list_jobs(app_services: AppServices = Depends(services)) -> list[JobSummaryResponse]:
        return [job_to_summary(job) for job in app_services.job_manager.list_jobs()]

    @router.post("/jobs", response_model=CreateJobResponse)
    async def create_job(
        text: str | None = Form(default=None),
        title: str | None = Form(default=None),
        voice_id: str | None = Form(default=None),
        file: UploadFile | None = File(default=None),
        app_services: AppServices = Depends(services),
    ) -> CreateJobResponse:
        if file is None and not text:
            raise HTTPException(status_code=400, detail="Provide text or a .txt upload")
        payload_text = text or ""
        source_kind = "text"
        if file is not None:
            if not file.filename or not file.filename.endswith(".txt"):
                raise HTTPException(status_code=400, detail="Only .txt uploads are supported")
            payload_text = (await file.read()).decode("utf-8")
            source_kind = "txt_file"
        voice = voice_id or app_services.settings.runtime.default_voice_id
        try:
            app_services.voice_registry.get_voice(voice)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        job = app_services.job_manager.create_job(
            source_text=payload_text,
            source_kind=source_kind,
            model_id=app_services.settings.runtime.default_model_id,
            voice_id=voice,
            title=title,
        )
        detail = job_to_detail(job)
        envelope = WsEnvelope(type="job_created", payload={"job": detail.model_dump()})
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

    @router.post("/jobs/{job_id}/activate", response_model=JobDetailResponse)
    async def activate_job(
        job_id: str, app_services: AppServices = Depends(services)
    ) -> JobDetailResponse:
        try:
            job = app_services.job_manager.activate_job(job_id)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        detail = job_to_detail(job)
        await app_services.hub.broadcast(
            WsEnvelope(type="job_updated", payload={"job": detail.model_dump()}).model_dump()
        )
        return detail

    @router.post("/jobs/{job_id}/pause", response_model=JobDetailResponse)
    async def pause_job(
        job_id: str, app_services: AppServices = Depends(services)
    ) -> JobDetailResponse:
        try:
            job = app_services.job_manager.pause_job(job_id)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        detail = job_to_detail(job)
        await app_services.hub.broadcast(
            WsEnvelope(type="job_updated", payload={"job": detail.model_dump()}).model_dump()
        )
        return detail

    @router.post("/jobs/{job_id}/resume", response_model=JobDetailResponse)
    async def resume_job(
        job_id: str, app_services: AppServices = Depends(services)
    ) -> JobDetailResponse:
        try:
            job = app_services.job_manager.resume_job(job_id)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        detail = job_to_detail(job)
        await app_services.hub.broadcast(
            WsEnvelope(type="job_updated", payload={"job": detail.model_dump()}).model_dump()
        )
        return detail

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
        detail = job_to_detail(job)
        await app_services.hub.broadcast(
            WsEnvelope(type="job_updated", payload={"job": detail.model_dump()}).model_dump()
        )
        return detail

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
        return AdminStateResponse(
            config=config, scheduler=scheduler, telemetry=app_services.telemetry.snapshot()
        )

    @router.post("/admin/model/warm", response_model=dict[str, str])
    async def warm_model(app_services: AppServices = Depends(services)) -> dict[str, str]:
        await app_services.model_manager.ensure_loaded(
            app_services.settings.runtime.default_model_id
        )
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
                if message == "ping":
                    await websocket.send_text(json.dumps({"type": "pong", "payload": {}}))
        finally:
            await app_services.hub.disconnect(websocket)

    return router
