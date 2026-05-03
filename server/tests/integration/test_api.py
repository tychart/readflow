import json
from typing import Any, cast


class _FakeWebSocket:
    def __init__(self) -> None:
        self.messages: list[dict[str, object]] = []

    async def accept(self) -> None:
        return None

    async def send_text(self, payload: str) -> None:
        self.messages.append(json.loads(payload))


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
