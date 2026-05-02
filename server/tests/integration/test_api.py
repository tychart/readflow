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
