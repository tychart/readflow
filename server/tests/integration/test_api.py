import io
import json
import wave
from typing import Any, cast

from app.synthesis.worker import RenderedChunkResult


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
    written = [chunk for chunk in manifest["chunks"] if chunk["status"] == "written"]
    assert written, "expected at least one written chunk"
    chunk = written[0]
    assert chunk["peaks_url"] == f"/api/jobs/{job['id']}/chunks/{chunk['index']}/peaks"

    peaks_response = await client.get(chunk["peaks_url"])
    assert peaks_response.status_code == 200
    assert peaks_response.headers["content-type"].startswith("application/json")
    peaks_payload = peaks_response.json()
    assert peaks_payload["bins"] == len(peaks_payload["peaks"]) > 0
    assert all(0.0 <= peak <= 1.0 for peak in peaks_payload["peaks"])

    missing_response = await client.get(f"/api/jobs/{job['id']}/chunks/999/peaks")
    assert missing_response.status_code == 404


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


async def test_create_job_with_custom_model_id(client, services):
    response = await client.post(
        "/api/jobs",
        data={
            "text": "Hello world.",
            "voice_id": "howard",
            "model_id": "Qwen/Qwen3-TTS-12Hz-1.7B-Base",
        },
    )
    assert response.status_code == 200
    job = response.json()["job"]
    assert job["voice_id"] == "howard"
    assert job["model_id"] == "Qwen/Qwen3-TTS-12Hz-1.7B-Base"


async def test_create_job_rejects_invalid_model_id(client, services):
    response = await client.post(
        "/api/jobs",
        data={"text": "Hello world.", "voice_id": "suzy", "model_id": "nonexistent-model"},
    )
    assert response.status_code == 400
    assert "Unsupported model" in response.json()["detail"]


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


# ─── Admin device config tests ────────────────────────────────────────


async def test_admin_config_returns_default_device(client, services):
    response = await client.get("/api/admin/config")
    assert response.status_code == 200
    config = response.json()
    assert "device" in config
    assert config["device"] in {"auto", "cpu", "gpu"}


async def test_admin_config_change_device_propagates_to_provider(client, services):
    # Verify initial device is "auto" (the default)
    assert services.settings.runtime.device == "auto"
    assert services.provider._device == "auto"

    # Update to "cpu"
    response = await client.post("/api/admin/config", json={"device": "cpu"})
    assert response.status_code == 200

    # Both runtime config and provider should be updated
    assert services.settings.runtime.device == "cpu"
    assert services.provider._device == "cpu"

    # Update to "gpu"
    response = await client.post("/api/admin/config", json={"device": "gpu"})
    assert response.status_code == 200

    assert services.settings.runtime.device == "gpu"
    assert services.provider._device == "gpu"


async def test_admin_config_change_device_broadcasts_event(client, services):
    ws = _FakeWebSocket()
    await services.hub.connect(ws)

    try:
        await client.post("/api/admin/config", json={"device": "cpu"})
    finally:
        await services.hub.disconnect(ws)

    # Should have received an admin_config_updated event
    config_events = [m for m in ws.messages if m.get("type") == "admin_config_updated"]
    assert len(config_events) >= 1
    payload = cast(dict[str, Any], config_events[-1].get("payload", {}))
    assert payload.get("device") == "cpu"


async def test_admin_config_change_device_resets_not_enough_vram_state(client, services):
    """When device changes and model state is NOT_ENOUGH_VRAM, it should reset to UNLOADED."""
    # Simulate NOT_ENOUGH_VRAM state
    services.model_manager._state = "not_enough_vram"
    services.model_manager._telemetry.set_model_state("not_enough_vram")

    # Change device
    response = await client.post("/api/admin/config", json={"device": "cpu"})

    assert response.status_code == 200
    # State should have been reset
    assert services.model_manager.state == "unloaded"
    assert services.model_manager._telemetry.snapshot()["model_state"] == "unloaded"


# ── Long documents ─────────────────────────────────────────
#
# Starlette's MultiPartParser caps each non-file part at 1 MiB. Because the
# browser always posts `FormData` (multipart), pasted text used to be rejected
# well before the configured source limit while an identical .txt upload was
# accepted. These tests pin the behavior that matters for whole books.


def _big_text(min_chars: int) -> str:
    return (
        ("Sentence number one. Sentence number two. " * (min_chars // 39 + 2))
        .strip()[:min_chars]
        .strip()
    )


async def test_create_job_accepts_paste_larger_than_one_mebibyte(client):
    pasted = _big_text(1_200_000)

    response = await client.post(
        "/api/jobs",
        files={"text": (None, pasted), "voice_id": (None, "suzy")},
    )

    assert response.status_code == 200
    assert response.json()["job"]["source_text"] == pasted


async def test_create_job_stores_canonical_pasted_text(client):
    response = await client.post(
        "/api/jobs",
        files={
            "text": (None, "  Line one.\r\n\r\n\r\nLine   two.\t\tEnd.  "),
            "voice_id": (None, "suzy"),
        },
    )

    assert response.status_code == 200
    assert response.json()["job"]["source_text"] == "Line one.\n\nLine two. End."


async def test_create_job_rejects_text_over_configured_limit(client, services):
    services.settings.max_source_bytes = 2_048

    response = await client.post(
        "/api/jobs",
        files={"text": (None, "word " * 2_000), "voice_id": (None, "suzy")},
    )

    assert response.status_code == 413
    assert "Text is too large" in response.json()["detail"]


async def test_create_job_rejects_oversized_txt_upload(client, services):
    services.settings.max_source_bytes = 2_048

    response = await client.post(
        "/api/jobs",
        files={
            "file": ("book.txt", b"word " * 2_000, "text/plain"),
            "voice_id": (None, "suzy"),
        },
    )

    assert response.status_code == 413
    assert "Uploaded text is too large" in response.json()["detail"]


async def test_create_job_rejects_non_utf8_txt_upload(client):
    response = await client.post(
        "/api/jobs",
        files={
            "file": ("book.txt", b"\xff\xfe\x00bad bytes", "text/plain"),
            "voice_id": (None, "suzy"),
        },
    )

    assert response.status_code == 400
    assert "UTF-8" in response.json()["detail"]


async def test_job_created_event_carries_summary_only(client, services):
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
    job = cast(dict[str, Any], cast(dict[str, Any], update["payload"])["job"])
    assert job["title"] == "A websocket visible job."
    assert "source_text" not in job
    assert "chunks" not in job


async def test_chunk_events_carry_summary_and_the_single_chunk(client, services):
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

    event = next(
        message
        for message in websocket.messages
        if cast(str, message["type"]) in {"chunk_ready", "job_completed"}
    )
    payload = cast(dict[str, Any], event["payload"])
    job = cast(dict[str, Any], payload["job"])
    chunk = cast(dict[str, Any], payload["chunk"])

    # Job detail (with the whole source text and every chunk) must not be
    # re-broadcast per chunk: that made streaming a book quadratic.
    assert "source_text" not in job
    assert "chunks" not in job
    assert job["id"] == job_id
    assert chunk["index"] == payload["chunk_index"]
    assert chunk["status"] == "written"
    assert chunk["segment_url"] == f"/api/jobs/{job_id}/chunks/{chunk['index']}"


async def test_activation_endpoints_return_summaries(client):
    create_response = await client.post(
        "/api/jobs",
        data={"text": "Activation summary job.", "voice_id": "suzy"},
    )
    job_id = create_response.json()["job"]["id"]

    activated = await client.post(f"/api/jobs/{job_id}/activate")
    assert activated.status_code == 200
    assert activated.json()["status"] == "playing"
    assert "source_text" not in activated.json()
    assert "chunks" not in activated.json()

    paused = await client.post(f"/api/jobs/{job_id}/pause")
    assert paused.status_code == 200
    assert paused.json()["status"] == "paused"

    resumed = await client.post(f"/api/jobs/{job_id}/resume")
    assert resumed.status_code == 200
    assert resumed.json()["status"] == "queued"


# ─── Admin queue inspection tests ─────────────────────────────────────


def _queue_chunks(payload: dict[str, Any]) -> list[dict[str, Any]]:
    """Flatten the grouped admin queue payload into a single chunk list."""
    return [chunk for job in payload["jobs"] for chunk in job["chunks"]]


async def test_admin_queue_empty(client):
    response = await client.get("/api/admin/queue")

    assert response.status_code == 200
    payload = response.json()
    assert payload["jobs"] == []
    assert payload["active_batch"] is None
    assert payload["next_batch"] is None
    assert payload["queue_depth"] == 0


async def test_admin_queue_reports_pending_chunks_after_dispatch(client, services):
    long_text = "A sentence that is long enough to plan a chunk. " * 120
    created = await client.post(
        "/api/jobs", data={"text": long_text, "voice_id": "suzy", "title": "Queued book"}
    )
    job_id = created.json()["job"]["id"]
    await client.post(f"/api/jobs/{job_id}/activate")

    await services.scheduler.run_once()

    response = await client.get("/api/admin/queue")
    assert response.status_code == 200
    payload = response.json()
    chunks = _queue_chunks(payload)
    assert chunks, "active job should keep chunks planned ahead"
    # The lifecycle includes already-rendered chunks, so rank only applies to
    # the pending ones.
    assert any(chunk["status"] == "written" for chunk in chunks)
    pending = [chunk for chunk in chunks if chunk["is_pending"]]
    assert pending
    first = pending[0]
    assert first["job_id"] == job_id
    assert first["job_title"] == "Queued book"
    assert first["text"]
    assert first["rank"] == 1
    assert first["priority_band"] == 0
    assert first["priority_label"] == "Urgent"
    assert first["char_count"] == len(first["text"])
    assert [item["rank"] for item in pending] == list(range(1, len(pending) + 1))


async def test_admin_queue_marks_paused_job_chunks(client, services):
    created = await client.post(
        "/api/jobs", data={"text": "Paused text. " * 20, "voice_id": "suzy", "title": "Paused"}
    )
    job_id = created.json()["job"]["id"]
    job = services.job_manager.get_job(job_id)
    services.job_manager.add_planned_chunk(
        job_id,
        text="A planned chunk on a paused job.",
        char_start=0,
        char_end=31,
        plan_version=job.plan_version,
        voice_id=job.voice_id,
    )
    await client.post(f"/api/jobs/{job_id}/pause")

    response = await client.get("/api/admin/queue")
    payload = response.json()
    pending = [chunk for chunk in _queue_chunks(payload) if chunk["is_pending"]]
    assert pending
    assert all(item["priority_band"] == 99 for item in pending)
    assert all(item["priority_label"] == "Paused" for item in pending)


async def test_admin_queue_reports_active_batch_while_rendering(client, services):
    import asyncio

    created = await client.post(
        "/api/jobs", data={"text": "Render me. " * 60, "voice_id": "suzy", "title": "Rendering"}
    )
    job_id = created.json()["job"]["id"]
    await client.post(f"/api/jobs/{job_id}/activate")

    started = asyncio.Event()
    release = asyncio.Event()

    async def blocking_render(model_id, chunks):
        del model_id
        started.set()
        await release.wait()
        return [
            RenderedChunkResult(
                chunk_index=chunk.index,
                segment_path=f"/tmp/{chunk.job_id}-{chunk.index}.m4s",
                init_segment_path=f"/tmp/{chunk.job_id}-init.mp4",
                wav_path=f"/tmp/{chunk.job_id}-{chunk.index}.wav",
                duration_seconds=1.0,
                reserved_vram_mb=0,
                allocated_vram_mb=0,
            )
            for chunk in chunks
        ]

    services.worker.render_batch = blocking_render
    task = asyncio.create_task(services.scheduler.run_once())
    await asyncio.wait_for(started.wait(), timeout=5)

    response = await client.get("/api/admin/queue")
    payload = response.json()
    assert payload["active_batch"] is not None
    assert payload["active_batch"]["chunk_count"] >= 1
    assert payload["active_batch"]["voice_id"] == "suzy"
    assert payload["active_batch"]["started_at"] is not None
    assert any(item["is_rendering"] for item in _queue_chunks(payload))

    release.set()
    await asyncio.wait_for(task, timeout=5)


async def test_scheduler_state_broadcast_carries_active_batch(client, services):
    import asyncio

    created = await client.post(
        "/api/jobs", data={"text": "Broadcast me. " * 60, "voice_id": "suzy", "title": "Cast"}
    )
    job_id = created.json()["job"]["id"]
    await client.post(f"/api/jobs/{job_id}/activate")

    ws = _FakeWebSocket()
    await services.hub.connect(ws)

    started = asyncio.Event()
    release = asyncio.Event()

    async def blocking_render(model_id, chunks):
        del model_id
        started.set()
        await release.wait()
        return [
            RenderedChunkResult(
                chunk_index=chunk.index,
                segment_path=f"/tmp/{chunk.job_id}-{chunk.index}.m4s",
                init_segment_path=f"/tmp/{chunk.job_id}-init.mp4",
                wav_path=f"/tmp/{chunk.job_id}-{chunk.index}.wav",
                duration_seconds=1.0,
                reserved_vram_mb=0,
                allocated_vram_mb=0,
            )
            for chunk in chunks
        ]

    services.worker.render_batch = blocking_render
    task = asyncio.create_task(services.scheduler.run_once())
    await asyncio.wait_for(started.wait(), timeout=5)
    release.set()
    await asyncio.wait_for(task, timeout=5)
    await services.hub.disconnect(ws)

    scheduler_states = [m for m in ws.messages if m.get("type") == "scheduler_state"]
    in_flight = [
        m for m in scheduler_states if cast(dict[str, Any], m["payload"]).get("active_batch")
    ]
    assert in_flight, "batch-start broadcast must include the active batch"
    active = cast(dict[str, Any], in_flight[0]["payload"])["active_batch"]
    assert active["chunk_count"] >= 1
    assert active["started_at"] is not None


async def test_admin_queue_reflects_reprocessed_chunk(client, services):
    created = await client.post(
        "/api/jobs", data={"text": "Reprocess me. " * 20, "voice_id": "suzy", "title": "Repro"}
    )
    job_id = created.json()["job"]["id"]
    job = services.job_manager.get_job(job_id)
    services.job_manager.add_planned_chunk(
        job_id,
        text="Original chunk text.",
        char_start=0,
        char_end=21,
        plan_version=job.plan_version,
        voice_id=job.voice_id,
    )

    reprocess = await client.post(f"/api/jobs/{job_id}/chunks/0/reprocess", json={})
    assert reprocess.status_code == 200

    response = await client.get("/api/admin/queue")
    payload = response.json()
    items = [item for item in _queue_chunks(payload) if item["index"] == 0]
    assert len(items) == 1
    item = items[0]
    assert item["version"] == 1
    assert [version["version"] for version in item["versions"]] == [0, 1]


async def test_admin_queue_does_not_depend_on_provider_memory_stats(client, services):
    """The queue view must answer even while the provider is mid-synthesis.

    `memory_stats()` is executed on the provider's worker thread, so awaiting it
    here queued behind the batch and the endpoint never returned, which is why
    the admin Queue tab looked empty. The snapshot must not touch it.
    """

    async def exploding_memory_stats():
        raise AssertionError("admin queue must not read provider memory stats")

    services.model_manager.memory_stats = exploding_memory_stats

    created = await client.post(
        "/api/jobs", data={"text": "Queue must answer. " * 20, "voice_id": "suzy"}
    )
    job_id = created.json()["job"]["id"]
    job = services.job_manager.get_job(job_id)
    services.job_manager.add_planned_chunk(
        job_id,
        text="A pending chunk while the model is busy.",
        char_start=0,
        char_end=40,
        plan_version=job.plan_version,
        voice_id=job.voice_id,
    )

    response = await client.get("/api/admin/queue")

    assert response.status_code == 200
    payload = response.json()
    chunks = _queue_chunks(payload)
    assert len(chunks) == 1
    assert chunks[0]["status"] == "planned"


async def test_admin_config_exposes_and_updates_inactive_ahead_window(client, services):
    initial = await client.get("/api/admin/config")
    assert initial.status_code == 200
    assert initial.json()["inactive_job_ahead_chunks"] == 1

    updated = await client.post("/api/admin/config", json={"inactive_job_ahead_chunks": 4})
    assert updated.status_code == 200
    assert updated.json()["inactive_job_ahead_chunks"] == 4
    assert services.settings.runtime.inactive_job_ahead_chunks == 4

    # An inactive job now plans up to the configured window.
    long_text = "A sentence that is long enough to plan a chunk. " * 200
    created = await client.post("/api/jobs", data={"text": long_text, "voice_id": "suzy"})
    job_id = created.json()["job"]["id"]
    services.scheduler._ensure_planned_chunks()
    job = services.job_manager.get_job(job_id)
    assert sum(1 for chunk in job.chunks if chunk.status == "planned") == 4
