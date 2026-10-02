import asyncio

from app.jobs.models import JobStatus
from app.synthesis.worker import RenderedChunkResult


def test_scheduler_prioritizes_active_listening_jobs_and_writes_media(services):
    active = services.job_manager.create_job(
        source_text="This active job should get rendered first. " * 8,
        source_kind="text",
        model_id=services.settings.runtime.default_model_id,
        voice_id="suzy",
        title="Active",
    )
    passive = services.job_manager.create_job(
        source_text="This passive job can wait a bit. " * 8,
        source_kind="text",
        model_id=services.settings.runtime.default_model_id,
        voice_id="howard",
        title="Passive",
    )
    services.job_manager.activate_job(active.id)

    asyncio.run(services.scheduler.run_once())

    active_after = services.job_manager.get_job(active.id)
    passive_after = services.job_manager.get_job(passive.id)

    assert active_after.total_chunks_completed >= 1
    assert passive_after.total_chunks_completed == 0
    assert active_after.status in {JobStatus.PLAYING, JobStatus.QUEUED, JobStatus.COMPLETED}
    assert services.media_store.init_segment_path(active.id).exists()


def test_scheduler_reduces_batch_size_when_memory_is_high(services):
    job = services.job_manager.create_job(
        source_text=("alpha beta gamma delta. " * 80).strip(),
        source_kind="text",
        model_id=services.settings.runtime.default_model_id,
        voice_id="suzy",
        title="Large batch",
    )
    services.job_manager.activate_job(job.id)
    services.settings.runtime.vram_soft_limit_mb = 1

    async def fake_memory_stats():
        return ("cuda", 5000, 4200, 4800, 200, 32000, 16000, 4096, "cuda")

    services.model_manager.memory_stats = fake_memory_stats

    asyncio.run(services.scheduler.run_once())

    snapshot = services.telemetry.snapshot()
    assert snapshot["recent_batches"][0]["batch_size"] <= 3


def test_scheduler_batches_one_voice_at_a_time(services):
    first = services.job_manager.create_job(
        source_text="Short first job. " * 12,
        source_kind="text",
        model_id=services.settings.runtime.default_model_id,
        voice_id="suzy",
        title="First",
    )
    second = services.job_manager.create_job(
        source_text="Short second job. " * 12,
        source_kind="text",
        model_id=services.settings.runtime.default_model_id,
        voice_id="howard",
        title="Second",
    )
    services.job_manager.activate_job(first.id)
    services.job_manager.activate_job(second.id)
    services.settings.runtime.batch_candidates_small_model = [2, 1]

    captured_batches: list[list[str]] = []

    async def fake_render_batch(model_id: str, chunks):
        del model_id
        captured_batches.append([chunk.voice_id for chunk in chunks])
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

    services.worker.render_batch = fake_render_batch

    asyncio.run(services.scheduler.run_once())

    assert captured_batches
    assert len(captured_batches[0]) == 1
    assert len(set(captured_batches[0])) == 1


# ── Admin queue inspection ─────────────────────────────────────────────


def _create_job(services, *, title: str, voice_id: str = "suzy"):
    return services.job_manager.create_job(
        source_text="Sentence one. Sentence two. Sentence three. " * 4,
        source_kind="text",
        model_id=services.settings.runtime.default_model_id,
        voice_id=voice_id,
        title=title,
    )


def _add_chunk(services, job, text: str, *, index_plan_version: int | None = None):
    if index_plan_version is None:
        plan_version = services.job_manager.get_job(job.id).plan_version
    else:
        plan_version = index_plan_version
    return services.job_manager.add_planned_chunk(
        job.id,
        text=text,
        char_start=0,
        char_end=len(text),
        plan_version=plan_version,
        voice_id=job.voice_id,
    )


def test_priority_band_matrix(services):
    cases = [
        (False, 0.0, True, 99),
        (True, 0.0, False, 0),
        (True, 44.9, False, 0),
        (True, 45.0, False, 1),
        (True, 500.0, False, 1),
        (False, 0.0, False, 2),
    ]
    for active_listening, buffered, paused, expected in cases:
        job = _create_job(services, title=f"band-{active_listening}-{buffered}-{paused}")
        if active_listening:
            services.job_manager.activate_job(job.id)
        job = services.job_manager.get_job(job.id)
        job.is_active_listening = active_listening
        job.buffered_seconds = buffered
        if paused:
            services.job_manager.pause_job(job.id)
        job = services.job_manager.get_job(job.id)
        assert services.scheduler._priority_band(job) == expected, (
            active_listening,
            buffered,
            paused,
        )


def test_chunk_priority_prefers_lower_index(services):
    job = _create_job(services, title="index tiebreak")
    first = _add_chunk(services, job, "same length")
    second = _add_chunk(services, job, "same length")
    assert first.index < second.index
    assert services.scheduler._chunk_priority(first) < services.scheduler._chunk_priority(second)


def test_chunk_priority_prefers_shorter_text_at_same_index(services):
    from app.jobs.models import ChunkRecord

    job = _create_job(services, title="length tiebreak")
    short = ChunkRecord(
        job_id=job.id,
        index=0,
        text="abc",
        voice_id="suzy",
        plan_version=1,
        char_start=0,
        char_end=3,
    )
    long = ChunkRecord(
        job_id=job.id,
        index=0,
        text="abcdefghij",
        voice_id="suzy",
        plan_version=1,
        char_start=0,
        char_end=10,
    )
    assert services.scheduler._chunk_priority(short) < services.scheduler._chunk_priority(long)


def test_priority_info_labels_and_reasons(services):
    job = _create_job(services, title="labels")
    chunk = _add_chunk(services, job, "some text")

    current = services.job_manager.get_job(job.id)
    band, label, reason = services.scheduler._priority_info(current, chunk)
    assert (band, label) == (2, "Normal")
    assert "no active listener" in reason

    services.job_manager.activate_job(job.id)
    current = services.job_manager.get_job(job.id)
    current.buffered_seconds = 100.0
    band, label, reason = services.scheduler._priority_info(current, chunk)
    assert (band, label) == (1, "High")
    assert "target of 45s met" in reason

    current.buffered_seconds = 3.5
    band, label, reason = services.scheduler._priority_info(current, chunk)
    assert (band, label) == (0, "Urgent")
    assert "3.5s buffered" in reason

    services.job_manager.pause_job(job.id)
    current = services.job_manager.get_job(job.id)
    band, label, reason = services.scheduler._priority_info(current, chunk)
    assert (band, label) == (99, "Paused")
    assert "excluded" in reason


def test_pending_chunks_for_inspection_filters_unschedulable(services):
    from app.jobs.models import ChunkStatus

    job = _create_job(services, title="pending filter")
    planned = _add_chunk(services, job, "planned")
    queued = _add_chunk(services, job, "queued")
    rendering = _add_chunk(services, job, "rendering")
    written = _add_chunk(services, job, "written")
    stale = _add_chunk(services, job, "stale")
    failed = _add_chunk(services, job, "failed")
    deprecated = _add_chunk(services, job, "deprecated")
    old_plan = _add_chunk(services, job, "old plan", index_plan_version=0)

    queued.status = ChunkStatus.QUEUED
    rendering.status = ChunkStatus.RENDERING
    written.status = ChunkStatus.WRITTEN
    stale.status = ChunkStatus.STALE
    failed.status = ChunkStatus.FAILED
    deprecated.deprecated = True

    result = services.scheduler._pending_chunks_for_inspection()
    assert {id(chunk) for chunk in result} == {id(planned), id(queued), id(rendering)}
    assert id(old_plan) not in {id(chunk) for chunk in result}


def test_pending_chunks_for_inspection_orders_by_priority(services):
    active = _create_job(services, title="active")
    queued = _create_job(services, title="queued", voice_id="howard")
    services.job_manager.activate_job(active.id)
    services.job_manager.get_job(active.id).buffered_seconds = 0.0

    active_a = _add_chunk(services, active, "aaa")
    active_b = _add_chunk(services, active, "bbbb")
    queued_a = _add_chunk(services, queued, "cccc")

    result = services.scheduler._pending_chunks_for_inspection()
    assert result == [active_a, active_b, queued_a]


def test_active_batch_is_none_when_idle(services):
    job = _create_job(services, title="idle")
    _add_chunk(services, job, "idle chunk")
    assert services.scheduler._active_batch() is None


def test_active_batch_groups_rendering_chunks(services):
    from app.jobs.models import ChunkStatus

    job = _create_job(services, title="rendering")
    chunks = [_add_chunk(services, job, f"chunk {index}") for index in range(3)]
    job = services.job_manager.get_job(job.id)
    for chunk, updated_at in zip(chunks, (100.0, 102.0, 104.0), strict=True):
        chunk.status = ChunkStatus.RENDERING
        chunk.updated_at = updated_at

    batch = services.scheduler._active_batch()
    assert batch is not None
    assert batch.chunk_count == 3
    assert batch.model_id == job.model_id
    assert batch.language == "English"
    assert batch.voice_id == "suzy"
    assert batch.started_at == 100.0


def test_queue_snapshot_ranks_are_contiguous_and_priority_ordered(services):
    active = _create_job(services, title="snapshot active")
    queued = _create_job(services, title="snapshot queued", voice_id="howard")
    services.job_manager.activate_job(active.id)
    services.job_manager.get_job(active.id).buffered_seconds = 0.0

    _add_chunk(services, active, "active one")
    _add_chunk(services, active, "active two")
    _add_chunk(services, queued, "queued one")

    snapshot = asyncio.run(services.scheduler.queue_snapshot())

    assert [item.rank for item in snapshot.items] == [1, 2, 3]
    assert snapshot.items[0].priority_band == 0
    assert snapshot.items[-1].priority_band == 2
    keys = [(item.priority_band, item.index, item.char_count) for item in snapshot.items]
    assert keys == sorted(keys)


def test_queue_snapshot_includes_text_and_estimated_duration(services):
    job = _create_job(services, title="snapshot text")
    chunk = _add_chunk(services, job, "A chunk of text for estimation.")

    snapshot = asyncio.run(services.scheduler.queue_snapshot())
    item = snapshot.items[0]

    assert item.text == chunk.text
    assert item.char_count == len(chunk.text)
    assert item.char_start == chunk.char_start
    assert item.char_end == chunk.char_end
    expected = max(1.0, len(chunk.text) / services.settings.runtime.estimated_chars_per_second)
    assert item.estimated_duration_seconds == expected
    assert item.status == "planned"
    assert item.is_rendering is False
    assert item.job_title == "snapshot text"


def test_queue_snapshot_lists_version_history(services):
    job = _create_job(services, title="snapshot versions")
    _add_chunk(services, job, "original text")
    services.job_manager.add_versioned_chunk(
        job.id,
        text="revised text",
        char_start=0,
        char_end=12,
        plan_version=job.plan_version,
        voice_id="suzy",
        parent_index=0,
    )

    snapshot = asyncio.run(services.scheduler.queue_snapshot())
    assert len(snapshot.items) == 1
    item = snapshot.items[0]
    assert item.version == 1
    assert [version.version for version in item.versions] == [0, 1]
    assert item.versions[0].deprecated is True
    assert item.versions[1].deprecated is False


def test_queue_snapshot_marks_next_batch(services):
    job = _create_job(services, title="snapshot next batch")
    for index in range(3):
        _add_chunk(services, job, f"next batch chunk {index}")
    services.settings.runtime.batch_candidates_small_model = [2]

    snapshot = asyncio.run(services.scheduler.queue_snapshot())

    assert snapshot.next_batch is not None
    assert snapshot.next_batch.chunk_count == 2
    assert sum(1 for item in snapshot.items if item.in_next_batch) == 2
    assert [item.in_next_batch for item in snapshot.items] == [True, True, False]


def test_queue_snapshot_queue_depth_matches_manager(services):
    job = _create_job(services, title="snapshot depth")
    _add_chunk(services, job, "one")
    _add_chunk(services, job, "two")

    snapshot = asyncio.run(services.scheduler.queue_snapshot())
    assert snapshot.queue_depth == services.job_manager.queue_depth() == 2


def test_scheduler_broadcasts_active_batch_at_batch_start(services):
    job = _create_job(services, title="broadcast")
    services.job_manager.activate_job(job.id)
    services.job_manager.get_job(job.id).buffered_seconds = 0.0

    captured: list[dict] = []

    async def capture(envelope: dict) -> None:
        captured.append(envelope)

    async def noop_render(model_id, chunks):
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

    services.hub.broadcast = capture
    services.worker.render_batch = noop_render

    asyncio.run(services.scheduler.run_once())

    scheduler_states = [event for event in captured if event["type"] == "scheduler_state"]
    assert scheduler_states
    # At least one tick observed the batch in flight with a start time.
    in_flight = [
        event for event in scheduler_states if event["payload"].get("active_batch") is not None
    ]
    assert in_flight
    assert in_flight[0]["payload"]["active_batch"]["chunk_count"] >= 1
    assert in_flight[0]["payload"]["active_batch"]["started_at"] is not None
    # And the final tick reports the queue drained.
    assert scheduler_states[-1]["payload"]["active_batch"] is None


def test_scheduler_requeues_chunks_dropped_by_partial_batch(services):
    from app.jobs.models import ChunkStatus

    job = _create_job(services, title="partial batch")
    for index in range(3):
        _add_chunk(services, job, f"chunk number {index}")
    services.settings.runtime.batch_candidates_small_model = [3]

    async def partial_render(model_id, batch):
        del model_id
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
            for chunk in batch[:-1]
        ]

    services.worker.render_batch = partial_render
    asyncio.run(services.scheduler.run_once())

    statuses = [chunk.status for chunk in services.job_manager.get_job(job.id).chunks]
    assert statuses == [ChunkStatus.WRITTEN, ChunkStatus.WRITTEN, ChunkStatus.PLANNED]
