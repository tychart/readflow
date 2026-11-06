from __future__ import annotations

import pytest

from app.chunking.planner import ChunkPlan


async def _create_job(client, *, title: str, folder_id: str | None = None):
    data = {"text": f"{title} text for the library.", "voice_id": "suzy", "title": title}
    if folder_id is not None:
        data["folder_id"] = folder_id
    response = await client.post("/api/jobs", data=data)
    assert response.status_code == 200, response.text
    return response.json()["job"]


async def _create_folder(client, name: str, parent_id: str | None = None):
    payload: dict[str, object] = {"name": name}
    if parent_id is not None:
        payload["parent_id"] = parent_id
    response = await client.post("/api/folders", json=payload)
    assert response.status_code == 201, response.text
    return response.json()


async def _render_chunks(services, job_id: str, count: int = 2):
    for index in range(count):
        start = index * 5
        chunk = services.job_manager.add_planned_chunk(
            job_id, ChunkPlan(text=f"chunk {index}", char_start=start, char_end=start + 5)
        )
        services.job_manager.mark_chunk_written(
            chunk,
            duration_seconds=10.0,
            segment_path=f"/tmp/{index}.m4s",
            wav_path=f"/tmp/{index}.wav",
        )
    services.job_manager.finish_planning(job_id)


@pytest.mark.asyncio
async def test_library_snapshot_tracks_folders_and_jobs(client, services):
    folder = await _create_folder(client, "Books")
    job = await _create_job(client, title="First book", folder_id=folder["id"])

    response = await client.get("/api/library")
    assert response.status_code == 200
    library = response.json()

    assert [item["name"] for item in library["folders"]] == ["Books"]
    assert [item["title"] for item in library["jobs"]] == ["First book"]
    assert library["jobs"][0]["folder_id"] == folder["id"]
    assert library["jobs"][0]["progress"]["read_status"] == "unread"
    assert library["folders"][0]["job_count"] == 1
    assert library["trash_count"] == 0
    assert job["id"] == library["jobs"][0]["id"]


@pytest.mark.asyncio
async def test_create_job_rejects_an_unknown_folder(client):
    response = await client.post(
        "/api/jobs",
        data={"text": "Hello.", "voice_id": "suzy", "folder_id": "missing"},
    )
    assert response.status_code == 404


@pytest.mark.asyncio
async def test_rename_folder_and_job(client):
    folder = await _create_folder(client, "Books")
    job = await _create_job(client, title="Old", folder_id=folder["id"])

    renamed_folder = await client.patch(f"/api/folders/{folder['id']}", json={"name": "Reading"})
    renamed_job = await client.patch(f"/api/jobs/{job['id']}", json={"title": "New"})

    assert renamed_folder.status_code == 200
    assert renamed_folder.json()["name"] == "Reading"
    assert renamed_job.status_code == 200
    assert renamed_job.json()["title"] == "New"
    assert renamed_job.json()["progress"]["read_status"] == "unread"

    blank = await client.patch(f"/api/folders/{folder['id']}", json={"name": "  "})
    assert blank.status_code == 422


@pytest.mark.asyncio
async def test_reorder_and_move(client):
    source = await _create_folder(client, "Source")
    target = await _create_folder(client, "Target")
    first = await _create_job(client, title="One", folder_id=source["id"])
    second = await _create_job(client, title="Two", folder_id=source["id"])

    reorder = await client.post(
        "/api/library/reorder",
        json={"parent_id": source["id"], "folder_ids": [], "job_ids": [second["id"], first["id"]]},
    )
    assert reorder.status_code == 204

    moved = await client.post(
        "/api/library/move",
        json={"items": [{"kind": "job", "id": second["id"]}], "folder_id": target["id"]},
    )
    assert moved.status_code == 204

    library = (await client.get("/api/library")).json()
    jobs = {item["id"]: item for item in library["jobs"]}
    assert jobs[first["id"]]["folder_id"] == source["id"]
    assert jobs[first["id"]]["position"] == 0
    assert jobs[second["id"]]["folder_id"] == target["id"]
    assert jobs[second["id"]]["position"] == 0


@pytest.mark.asyncio
async def test_reorder_rejects_a_stale_list(client):
    folder = await _create_folder(client, "Books")
    await _create_job(client, title="One", folder_id=folder["id"])
    response = await client.post(
        "/api/library/reorder", json={"parent_id": folder["id"], "job_ids": []}
    )
    assert response.status_code == 422


@pytest.mark.asyncio
async def test_trash_restore_and_purge(client, services):
    folder = await _create_folder(client, "Books")
    job = await _create_job(client, title="One", folder_id=folder["id"])

    deleted = await client.post(
        "/api/library/delete", json={"items": [{"kind": "folder", "id": folder["id"]}]}
    )
    assert deleted.status_code == 204
    library = (await client.get("/api/library")).json()
    assert library["folders"] == [] and library["jobs"] == []
    assert library["trash_count"] == 1

    trash = (await client.get("/api/trash")).json()
    assert len(trash) == 1
    assert trash[0]["kind"] == "folder"
    assert trash[0]["job_count"] == 1

    restored = await client.post("/api/trash/restore", json={"entry_ids": [trash[0]["id"]]})
    assert restored.status_code == 204
    library = (await client.get("/api/library")).json()
    assert [item["id"] for item in library["jobs"]] == [job["id"]]

    await client.post(
        "/api/library/delete", json={"items": [{"kind": "folder", "id": folder["id"]}]}
    )
    entry = (await client.get("/api/trash")).json()[0]
    purged = await client.post("/api/trash/purge", json={"entry_ids": [entry["id"]]})
    assert purged.status_code == 204
    assert (await client.get("/api/trash")).json() == []
    assert (await client.get(f"/api/jobs/{job['id']}")).status_code == 404


@pytest.mark.asyncio
async def test_delete_folder_only_keeps_the_jobs(client):
    folder = await _create_folder(client, "Books")
    job = await _create_job(client, title="One", folder_id=folder["id"])

    response = await client.post(f"/api/folders/{folder['id']}/delete-only")
    assert response.status_code == 204

    library = (await client.get("/api/library")).json()
    assert library["folders"] == []
    assert library["jobs"][0]["folder_id"] is None
    assert library["trash_count"] == 1
    assert library["jobs"][0]["id"] == job["id"]


@pytest.mark.asyncio
async def test_progress_reports_position_and_heard_chunks(client, services):
    job = await _create_job(client, title="One")
    await _render_chunks(services, job["id"], count=2)

    response = await client.post(
        f"/api/jobs/{job['id']}/progress",
        json={"position_seconds": 12.0, "heard_chunk_indexes": [0]},
    )
    assert response.status_code == 200
    progress = response.json()["progress"]
    assert progress["position_seconds"] == 12.0
    assert progress["heard_chunks"] == [0]
    assert progress["fraction"] == 0.5
    assert progress["read_status"] == "in_progress"

    detail = (await client.get(f"/api/jobs/{job['id']}")).json()
    assert detail["progress"]["heard_chunks"] == [0]
    assert detail["progress"]["read_status"] == "in_progress"


@pytest.mark.asyncio
async def test_mark_read_and_unread(client, services):
    folder = await _create_folder(client, "Books")
    job = await _create_job(client, title="One", folder_id=folder["id"])
    await _render_chunks(services, job["id"], count=2)

    read = await client.post(f"/api/jobs/{job['id']}/read", json={"read": True})
    assert read.status_code == 200
    assert read.json()["progress"]["read_status"] == "read"

    library = (await client.get("/api/library")).json()
    assert library["jobs"][0]["progress"]["read_status"] == "read"
    assert library["folders"][0]["progress_fraction"] == 1.0

    unread = await client.post(f"/api/jobs/{job['id']}/read", json={"read": False})
    assert unread.json()["progress"]["read_status"] == "unread"
    assert unread.json()["position_seconds"] == 0.0


@pytest.mark.asyncio
async def test_bulk_read_expands_folders(client, services):
    folder = await _create_folder(client, "Books")
    nested = await _create_folder(client, "Nested", folder["id"])
    first = await _create_job(client, title="One", folder_id=folder["id"])
    second = await _create_job(client, title="Two", folder_id=nested["id"])
    await _render_chunks(services, first["id"], count=1)
    await _render_chunks(services, second["id"], count=1)

    response = await client.post(
        "/api/library/read",
        json={"items": [{"kind": "folder", "id": folder["id"]}], "read": True},
    )
    assert response.status_code == 204

    library = (await client.get("/api/library")).json()
    assert {job["progress"]["read_status"] for job in library["jobs"]} == {"read"}


@pytest.mark.asyncio
async def test_chunk_level_heard_toggle(client, services):
    job = await _create_job(client, title="One")
    await _render_chunks(services, job["id"], count=2)

    heard = await client.post(f"/api/jobs/{job['id']}/chunks/1/heard", json={"heard": True})
    assert heard.status_code == 200
    assert heard.json()["progress"]["heard_chunks"] == [1]

    unheard = await client.post(f"/api/jobs/{job['id']}/chunks/1/heard", json={"heard": False})
    assert unheard.json()["progress"]["heard_chunks"] == []

    missing = await client.post(f"/api/jobs/{job['id']}/chunks/99/heard", json={"heard": True})
    assert missing.status_code == 404


@pytest.mark.asyncio
async def test_job_detail_carries_folder_path_and_neighbours(client):
    folder = await _create_folder(client, "Books")
    nested = await _create_folder(client, "Sci-fi", folder["id"])
    first = await _create_job(client, title="One", folder_id=nested["id"])
    second = await _create_job(client, title="Two", folder_id=nested["id"])

    detail = (await client.get(f"/api/jobs/{first['id']}")).json()
    assert [item["name"] for item in detail["folder_path"]] == ["Books", "Sci-fi"]
    assert detail["previous_job_id"] is None
    assert detail["next_job_id"] == second["id"]
    assert detail["folder_index"] == 1
    assert detail["folder_count"] == 2
    assert detail["next_job_title"] == "Two"
    assert detail["previous_job_title"] is None

    detail = (await client.get(f"/api/jobs/{second['id']}")).json()
    assert detail["previous_job_id"] == first["id"]
    assert detail["next_job_id"] is None
    assert detail["folder_index"] == 2
    assert detail["previous_job_title"] == "One"


@pytest.mark.asyncio
async def test_up_next_prebuffer_is_an_admin_knob(client):
    config = (await client.get("/api/admin/config")).json()
    assert config["up_next_prebuffer_seconds"] == 120

    updated = await client.post("/api/admin/config", json={"up_next_prebuffer_seconds": 30})
    assert updated.status_code == 200
    assert updated.json()["up_next_prebuffer_seconds"] == 30

    rejected = await client.post("/api/admin/config", json={"up_next_prebuffer_seconds": -1})
    assert rejected.status_code == 422
    assert (await client.get("/api/admin/config")).json()["up_next_prebuffer_seconds"] == 30
