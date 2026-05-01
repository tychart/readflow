import asyncio
import json


def test_create_job_and_fetch_manifest(client, services):
    response = client.post(
        "/api/jobs",
        data={"text": "Hello world. This should become speech.", "voice_id": "suzy"},
    )
    assert response.status_code == 200
    job = response.json()["job"]

    asyncio.run(services.scheduler.run_once())

    detail_response = client.get(f"/api/jobs/{job['id']}")
    manifest_response = client.get(f"/api/jobs/{job['id']}/manifest")

    assert detail_response.status_code == 200
    assert manifest_response.status_code == 200
    manifest = manifest_response.json()
    assert manifest["mime_type"].startswith("audio/mp4")
    assert manifest["init_segment_url"] is not None
    assert any(chunk["status"] == "written" for chunk in manifest["chunks"])


def test_websocket_receives_job_events(client):
    with client.websocket_connect("/api/ws") as websocket:
        initial = json.loads(websocket.receive_text())
        assert initial["type"] == "telemetry"

        client.post("/api/jobs", data={"text": "A websocket visible job.", "voice_id": "suzy"})

        update = json.loads(websocket.receive_text())
        assert update["type"] == "job_created"
        assert update["payload"]["job"]["title"] == "A websocket visible job."


def test_admin_warm_and_evict_endpoints(client):
    warm = client.post("/api/admin/model/warm")
    evict = client.post("/api/admin/model/evict")

    assert warm.status_code == 200
    assert warm.json()["status"] == "warm"
    assert evict.status_code == 200
    assert evict.json()["status"] == "evicted"
