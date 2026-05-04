import io
import json
import wave
from typing import Any, cast


class _FakeWebSocket:
    def __init__(self) -> None:
        self.messages: list[dict[str, object]] = []

    async def accept(self) -> None:
        return None

    async def send_text(self, payload: str) -> None:
        self.messages.append(json.loads(payload))


def _build_wav_bytes(duration_frames: int = 2400, sample_rate: int = 24_000) -> bytes:
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(sample_rate)
        handle.writeframes(b"\x00\x00" * duration_frames)
    return buffer.getvalue()


def _seed_written_chunk(services, job, index: int):
    chunk = services.job_manager.add_planned_chunk(
        job.id,
        text=f"Chunk {index}",
        char_start=index * 10,
        char_end=index * 10 + 7,
        plan_version=job.plan_version,
        voice_id=job.voice_id,
    )
    stored = services.media_store.package_wav_chunk(job.id, chunk.index, _build_wav_bytes())
    services.job_manager.mark_chunk_written(
        chunk,
        duration_seconds=stored.duration_seconds,
        segment_path=stored.segment_path,
        wav_path=stored.wav_path,
    )
    return chunk


async def test_create_job_and_fetch_manifest(client, services):
    response = await client.post(
        "/api/jobs",
        data={"text": "Hello world. This should become speech.", "voice_id": "suzy"},
    )
    assert response.status_code == 200
    job = response.json()["job"]

    await services.scheduler.run_once()

    detail_response = await client.get(f"/api/jobs/{job['id']}")
    manifest_response = await client.get(f"/api/jobs/{job['id']}/manifest")

    assert detail_response.status_code == 200
    assert manifest_response.status_code == 200
    manifest = manifest_response.json()
    assert manifest["mime_type"].startswith("audio/mp4")
    assert manifest["init_segment_url"] is not None
    assert any(chunk["status"] == "written" for chunk in manifest["chunks"])


async def test_job_creation_broadcasts_websocket_event(client, services):
    websocket = _FakeWebSocket()
    await services.hub.connect(websocket)

    try:
        await client.post(
            "/api/jobs",
            data={"text": "A websocket visible job.", "voice_id": "suzy"},
        )
    finally:
        await services.hub.disconnect(websocket)

    update = next(message for message in websocket.messages if message["type"] == "job_created")
    payload = cast(dict[str, Any], update["payload"])
    job = cast(dict[str, Any], payload["job"])
    assert job["title"] == "A websocket visible job."


async def test_admin_warm_and_evict_endpoints(client):
    warm = await client.post("/api/admin/model/warm")
    evict = await client.post("/api/admin/model/evict")

    assert warm.status_code == 200
    assert warm.json()["status"] == "warm"
    assert evict.status_code == 200
    assert evict.json()["status"] == "evicted"


async def test_playback_updates_do_not_broadcast_job_events(client, services):
    create_response = await client.post(
        "/api/jobs",
        data={"text": "A playback-tracked job.", "voice_id": "suzy"},
    )
    job_id = create_response.json()["job"]["id"]

    websocket = _FakeWebSocket()
    await services.hub.connect(websocket)

    try:
        response = await client.post(
            f"/api/jobs/{job_id}/playback",
            json={"current_time_seconds": 4.5, "is_playing": True},
        )
    finally:
        await services.hub.disconnect(websocket)

    assert response.status_code == 200
    assert websocket.messages == []


async def test_scheduler_emits_chunk_ready_without_duplicate_job_updated(client, services):
    create_response = await client.post(
        "/api/jobs",
        data={"text": "Hello world. This should become speech.", "voice_id": "suzy"},
    )
    job_id = create_response.json()["job"]["id"]

    websocket = _FakeWebSocket()
    await services.hub.connect(websocket)

    try:
        await services.scheduler.run_once()
    finally:
        await services.hub.disconnect(websocket)

    job_events = [
        message
        for message in websocket.messages
        if cast(dict[str, Any], message["payload"]).get("job", {}).get("id") == job_id
    ]
    message_types = {cast(str, message["type"]) for message in job_events}

    assert "chunk_ready" in message_types or "job_completed" in message_types
    assert "job_updated" not in message_types

    chunk_event = next(
        message
        for message in job_events
        if cast(str, message["type"]) in {"chunk_ready", "job_completed"}
    )
    payload = cast(dict[str, Any], chunk_event["payload"])
    assert payload["mime_type"].startswith("audio/mp4")
    assert payload["init_segment_url"] == f"/api/jobs/{job_id}/chunks/init"


async def test_download_job_audio_returns_full_m4a_for_completed_job(client, services):
    job = services.job_manager.create_job(
        source_text="Downloadable job.",
        source_kind="text",
        model_id=services.settings.runtime.default_model_id,
        voice_id="suzy",
        title="Finished download",
    )
    _seed_written_chunk(services, job, 0)
    job.planner_cursor.offset = -1
    _seed_written_chunk(services, job, 1)

    response = await client.get(f"/api/jobs/{job.id}/download")

    assert response.status_code == 200
    assert response.headers["content-type"].startswith("audio/mp4")
    assert 'filename="finished-download.m4a"' in response.headers["content-disposition"]
    assert len(response.content) > 0


async def test_download_job_audio_returns_partial_contiguous_audio_for_in_progress_job(
    client, services
):
    job = services.job_manager.create_job(
        source_text="Partial download.",
        source_kind="text",
        model_id=services.settings.runtime.default_model_id,
        voice_id="suzy",
        title="Partial download",
    )
    _seed_written_chunk(services, job, 0)
    _seed_written_chunk(services, job, 1)

    response = await client.get(f"/api/jobs/{job.id}/download")

    assert response.status_code == 200
    assert 'filename="partial-download-partial.m4a"' in response.headers["content-disposition"]
    assert len(response.content) > 0


async def test_download_job_audio_ignores_written_chunks_after_the_first_gap(client, services):
    job = services.job_manager.create_job(
        source_text="Gap download.",
        source_kind="text",
        model_id=services.settings.runtime.default_model_id,
        voice_id="suzy",
        title="Gap download",
    )
    _seed_written_chunk(services, job, 0)
    _seed_written_chunk(services, job, 1)
    _seed_written_chunk(services, job, 2)
    gap_chunk = services.job_manager.add_planned_chunk(
        job.id,
        text="Gap chunk",
        char_start=30,
        char_end=39,
        plan_version=job.plan_version,
        voice_id=job.voice_id,
    )
    assert gap_chunk.index == 3
    services.job_manager.add_planned_chunk(
        job.id,
        text="Still missing",
        char_start=40,
        char_end=53,
        plan_version=job.plan_version,
        voice_id=job.voice_id,
    )
    _seed_written_chunk(services, job, 5)

    response = await client.get(f"/api/jobs/{job.id}/download")

    assert response.status_code == 200
    assert 'filename="gap-download-partial.m4a"' in response.headers["content-disposition"]
    assert len(response.content) > 0


async def test_download_job_audio_returns_409_when_no_front_contiguous_audio_is_ready(
    client, services
):
    job = services.job_manager.create_job(
        source_text="Nothing ready yet.",
        source_kind="text",
        model_id=services.settings.runtime.default_model_id,
        voice_id="suzy",
        title="No audio yet",
    )
    services.job_manager.add_planned_chunk(
        job.id,
        text="Chunk 0",
        char_start=0,
        char_end=7,
        plan_version=job.plan_version,
        voice_id=job.voice_id,
    )

    response = await client.get(f"/api/jobs/{job.id}/download")

    assert response.status_code == 409
    assert response.json()["detail"] == "No contiguous rendered audio is ready"


async def test_delete_job_removes_export_source_files(client, services):
    job = services.job_manager.create_job(
        source_text="Delete this job.",
        source_kind="text",
        model_id=services.settings.runtime.default_model_id,
        voice_id="suzy",
        title="Delete me",
    )
    _seed_written_chunk(services, job, 0)
    wav_path = services.media_store.wav_path(job.id, 0)

    assert wav_path.exists()

    response = await client.delete(f"/api/jobs/{job.id}")

    assert response.status_code == 204
    assert not wav_path.parent.exists()
