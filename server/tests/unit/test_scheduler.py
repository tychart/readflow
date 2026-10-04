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


def _snapshot_chunks(snapshot):
    """Flatten the grouped queue snapshot into a single chunk list."""
    return [chunk for job in snapshot.jobs for chunk in job.chunks]


def test_priority_band_matrix(services):
    cases = [
        (False, 0.0, True, 99),
        (True, 0.0, False, 0),
        (True, 59.9, False, 0),
        (True, 60.0, False, 1),
        (True, 299.9, False, 1),
        (True, 300.0, False, 2),
        (True, 500.0, False, 2),
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
    assert (band, label) == (2, "Background")
    assert "no active listener" in reason

    services.job_manager.activate_job(job.id)
    current = services.job_manager.get_job(job.id)
    current.buffered_seconds = 100.0
    band, label, reason = services.scheduler._priority_info(current, chunk)
    assert (band, label) == (1, "Filling")
    assert "target 60s met" in reason
    assert "ideal" in reason

    current.buffered_seconds = 400.0
    band, label, reason = services.scheduler._priority_info(current, chunk)
    assert (band, label) == (2, "Buffered")
    assert "ideal 300s met" in reason

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

    snapshot = services.scheduler.queue_snapshot()

    pending = [chunk for chunk in _snapshot_chunks(snapshot) if chunk.is_pending]
    # Groups are per job (newest first), so check rank order explicitly.
    assert sorted(item.rank for item in pending) == [1, 2, 3]
    ordered = sorted(pending, key=lambda item: item.rank)
    assert ordered[0].priority_band == 0
    assert ordered[-1].priority_band == 2
    keys = [(item.priority_band, item.index, item.char_count) for item in ordered]
    assert keys == sorted(keys)


def test_queue_snapshot_includes_text_and_estimated_duration(services):
    job = _create_job(services, title="snapshot text")
    chunk = _add_chunk(services, job, "A chunk of text for estimation.")

    snapshot = services.scheduler.queue_snapshot()
    item = _snapshot_chunks(snapshot)[0]

    assert item.text == chunk.text
    assert item.char_count == len(chunk.text)
    assert item.char_start == chunk.char_start
    assert item.char_end == chunk.char_end
    expected = max(1.0, len(chunk.text) / services.settings.runtime.estimated_chars_per_second)
    assert item.estimated_duration_seconds == expected
    assert item.status == "planned"
    assert item.is_pending is True
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

    snapshot = services.scheduler.queue_snapshot()
    chunks = _snapshot_chunks(snapshot)
    assert len(chunks) == 1
    item = chunks[0]
    assert item.version == 1
    assert [version.version for version in item.versions] == [0, 1]
    assert item.versions[0].deprecated is True
    assert item.versions[1].deprecated is False


def test_queue_snapshot_marks_next_batch(services):
    job = _create_job(services, title="snapshot next batch")
    for index in range(3):
        _add_chunk(services, job, f"next batch chunk {index}")
    services.settings.runtime.batch_candidates_small_model = [2]

    snapshot = services.scheduler.queue_snapshot()

    assert snapshot.next_batch is not None
    assert snapshot.next_batch.chunk_count == 2
    pending = [chunk for chunk in _snapshot_chunks(snapshot) if chunk.is_pending]
    assert sum(1 for item in pending if item.in_next_batch) == 2
    assert [item.in_next_batch for item in pending] == [True, True, False]


def test_queue_snapshot_queue_depth_matches_manager(services):
    job = _create_job(services, title="snapshot depth")
    _add_chunk(services, job, "one")
    _add_chunk(services, job, "two")

    snapshot = services.scheduler.queue_snapshot()
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
    # Isolate the requeue behavior from the (now larger) plan-ahead window by
    # planning exactly the chunks this test adds.
    services.settings.runtime.plan_ahead_chunks = 3
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


def test_queue_snapshot_never_calls_provider_memory_stats(services):
    """Regression: awaiting provider memory stats queued behind an in-flight
    synthesis (blocking for the whole batch) and yielded the event loop
    mid-snapshot, so responses mixed pre- and post-batch state."""

    async def exploding_memory_stats():
        raise AssertionError("queue_snapshot must not read provider memory stats")

    services.model_manager.memory_stats = exploding_memory_stats
    job = _create_job(services, title="no memory stats")
    _add_chunk(services, job, "a pending chunk")

    snapshot = services.scheduler.queue_snapshot()

    assert len(_snapshot_chunks(snapshot)) == 1
    assert snapshot.jobs[0].pending_chunks == 1


def test_queue_snapshot_only_returns_schedulable_statuses(services):
    """A chunk that became `written` during a snapshot must never leak in."""
    from app.jobs.models import ChunkStatus

    job = _create_job(services, title="schedulable statuses")
    _add_chunk(services, job, "planned")
    rendering = _add_chunk(services, job, "rendering")
    written = _add_chunk(services, job, "written")
    rendering.status = ChunkStatus.RENDERING
    written.status = ChunkStatus.WRITTEN

    snapshot = services.scheduler.queue_snapshot()

    pending = [chunk for chunk in _snapshot_chunks(snapshot) if chunk.is_pending]
    assert all(item.status in {"planned", "queued", "rendering"} for item in pending)
    assert snapshot.queue_depth == len(pending) == 2
    assert sum(1 for item in pending if item.is_rendering) == 1
    # The written chunk is still present in the lifecycle, just not pending.
    assert any(item.status == "written" and not item.is_pending for item in snapshot.jobs[0].chunks)


def test_queue_snapshot_reports_the_rendering_batch_while_in_flight(services):
    from app.jobs.models import ChunkStatus

    job = _create_job(services, title="in flight")
    for index in range(3):
        chunk = _add_chunk(services, job, f"rendering {index}")
        chunk.status = ChunkStatus.RENDERING

    snapshot = services.scheduler.queue_snapshot()

    chunks = _snapshot_chunks(snapshot)
    assert len(chunks) == 3
    assert snapshot.active_batch is not None
    assert snapshot.active_batch.chunk_count == 3
    assert all(item.is_rendering for item in chunks)


def test_queue_snapshot_groups_full_lifecycle_per_job(services):
    from app.jobs.models import ChunkStatus

    first = _create_job(services, title="first job")
    second = _create_job(services, title="second job", voice_id="howard")
    written = _add_chunk(services, first, "already rendered")
    written.status = ChunkStatus.WRITTEN
    written.duration_seconds = 4.2
    _add_chunk(services, first, "still to render")
    _add_chunk(services, second, "other job pending")

    snapshot = services.scheduler.queue_snapshot()

    by_title = {group.job_title: group for group in snapshot.jobs}
    first_group = by_title["first job"]
    assert first_group.total_chunks == 2
    assert first_group.written_chunks == 1
    assert first_group.pending_chunks == 1
    assert [chunk.status for chunk in first_group.chunks] == ["written", "planned"]
    assert first_group.chunks[0].duration_seconds == 4.2
    assert len(by_title["second job"].chunks) == 1


def test_queue_snapshot_reports_unplanned_remaining_chars(services):
    job = _create_job(services, title="unplanned")
    # Do not plan at all: the whole source text is still unplanned.
    snapshot = services.scheduler.queue_snapshot()
    group = snapshot.jobs[0]
    assert group.chunks == []
    assert group.unplanned_chars == len(job.source_text)

    # Planning one chunk consumes part of the source text.
    planned = _add_chunk(services, job, "planned prefix")
    job.planner_cursor.offset = planned.char_end
    snapshot = services.scheduler.queue_snapshot()
    assert snapshot.jobs[0].unplanned_chars == len(job.source_text) - planned.char_end

    # An exhausted cursor means nothing is left.
    job.planner_cursor.offset = -1
    snapshot = services.scheduler.queue_snapshot()
    assert snapshot.jobs[0].unplanned_chars == 0


def test_queue_snapshot_truncates_large_jobs_but_keeps_pending(services, monkeypatch):
    from app.jobs.models import ChunkStatus
    from app.scheduler import service as scheduler_service

    monkeypatch.setattr(scheduler_service, "QUEUE_SNAPSHOT_CHUNK_LIMIT", 5)
    job = _create_job(services, title="truncated")
    for index in range(10):
        chunk = _add_chunk(services, job, f"chunk {index}")
        if index < 8:
            chunk.status = ChunkStatus.WRITTEN

    snapshot = services.scheduler.queue_snapshot()
    group = snapshot.jobs[0]

    assert group.total_chunks == 10
    assert group.chunks_truncated is True
    returned_indices = [chunk.index for chunk in group.chunks]
    # The two pending chunks are always kept, plus the most recent history.
    assert 8 in returned_indices and 9 in returned_indices
    assert len(group.chunks) == 5
    assert returned_indices == sorted(returned_indices)


def test_plan_ahead_window_controls_planning(services):
    from app.jobs.models import ChunkStatus

    job = services.job_manager.create_job(
        source_text="A sufficiently long sentence for planning. " * 200,
        source_kind="text",
        model_id=services.settings.runtime.default_model_id,
        voice_id="suzy",
        title="ahead window",
    )
    services.settings.runtime.plan_ahead_chunks = 3

    services.scheduler._ensure_planned_chunks()

    planned = [chunk for chunk in job.chunks if chunk.status == ChunkStatus.PLANNED]
    assert len(planned) == 3


# ── Reliability: the loop must survive anything a single tick throws ──


def test_run_forever_survives_a_failing_tick(services):
    """A broken tick used to kill the scheduler task permanently."""
    calls = {"count": 0}

    async def flaky_run_once() -> None:
        calls["count"] += 1
        if calls["count"] == 1:
            raise RuntimeError("boom")
        services.scheduler._stop_event.set()

    services.scheduler.run_once = flaky_run_once  # type: ignore[method-assign]
    asyncio.run(services.scheduler.run_forever())

    assert calls["count"] == 2
    assert services.scheduler._last_error == "RuntimeError: boom"
    assert services.scheduler._running is False


def test_batch_failure_retries_within_budget_then_skips_chunk(services):
    """One failing batch must not stop the loop or fail the whole job."""
    from app.jobs.models import ChunkStatus

    job = _create_job(services, title="retry budget")
    services.settings.runtime.batch_candidates_small_model = [1]
    services.job_manager.activate_job(job.id)

    async def always_fails(model_id, batch):
        raise RuntimeError("ffmpeg exploded")

    services.worker.render_batch = always_fails  # type: ignore[method-assign]

    asyncio.run(services.scheduler.run_once())
    chunk = services.job_manager.get_job(job.id).chunks[0]
    assert chunk.status == ChunkStatus.PLANNED
    assert chunk.attempts == 1

    asyncio.run(services.scheduler.run_once())
    assert chunk.status == ChunkStatus.PLANNED
    assert chunk.attempts == 2

    # Third failure exhausts the budget: only the chunk is abandoned.
    asyncio.run(services.scheduler.run_once())
    assert chunk.status == ChunkStatus.FAILED
    assert services.job_manager.get_job(job.id).status != "failed"


def test_synthesis_timeout_flags_model_error_and_pauses_dispatch(services):
    """A hung call trips the circuit breaker instead of piling up work."""
    from app.jobs.models import ChunkStatus, ModelState

    job = _create_job(services, title="timeout")
    services.job_manager.activate_job(job.id)
    services.settings.runtime.synthesis_timeout_seconds = 0.01
    calls = {"count": 0}

    async def hangs(model_id, chunks, prompts):
        calls["count"] += 1
        await asyncio.sleep(5)
        return []

    services.provider.synthesize_batch = hangs  # type: ignore[method-assign]

    asyncio.run(services.scheduler.run_once())

    assert services.model_manager.state == ModelState.ERROR
    assert services.model_manager.last_error is not None
    chunk = services.job_manager.get_job(job.id).chunks[0]
    assert chunk.status == ChunkStatus.PLANNED
    assert chunk.attempts == 1

    # The errored provider must not be called again until it is reset.
    dispatched_before = calls["count"]
    asyncio.run(services.scheduler.run_once())
    assert calls["count"] == dispatched_before

    asyncio.run(services.model_manager.reset_provider())
    assert services.model_manager.state == ModelState.UNLOADED


# ── Throughput: plan-ahead, round-robin, VRAM budgets, idle unload ──


def _long_job(services, *, title: str, voice_id: str = "suzy"):
    return services.job_manager.create_job(
        source_text="A sufficiently long sentence for planning. " * 200,
        source_kind="text",
        model_id=services.settings.runtime.default_model_id,
        voice_id=voice_id,
        title=title,
    )


def test_plan_ahead_lets_one_inactive_job_fill_a_batch(services):
    """With a batch-sized lookahead, an inactive job can fill a full batch.

    Previously the inactive window was 1 chunk, so every background batch was a
    batch of one and the GPU idled on undersized batches.
    """
    _long_job(services, title="full batch")
    services.settings.runtime.plan_ahead_chunks = 16
    services.settings.runtime.batch_candidates_small_model = [8]

    rendered: dict[str, int] = {}

    async def capture(model_id, chunks):
        rendered["count"] = len(chunks)
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

    services.worker.render_batch = capture  # type: ignore[method-assign]
    asyncio.run(services.scheduler.run_once())

    assert rendered["count"] == 8


def test_inactive_jobs_round_robin_by_chunk_index(services):
    """Equal-priority jobs advance together, one chunk each per round."""
    _long_job(services, title="job A")
    _long_job(services, title="job B")
    services.settings.runtime.plan_ahead_chunks = 3

    services.scheduler._ensure_planned_chunks()
    ranked = services.scheduler._rank_renderable_chunks()

    indices = [chunk.index for chunk in ranked]
    assert indices == [0, 0, 1, 1, 2, 2]
    # The first batch therefore contains one chunk from each job, not two
    # chunks from one job.
    group_key, batch = services.scheduler._select_next_batch(ranked, 100, 24000)
    assert group_key is not None
    assert [chunk.index for chunk in batch[:2]] == [0, 0]
    assert len({chunk.job_id for chunk in batch[:2]}) == 2


def test_batch_size_uses_configured_soft_limit(services):
    services.settings.runtime.batch_candidates_small_model = [8, 4, 3, 2, 1]
    services.settings.runtime.vram_soft_limit_mb = 1000

    # 90% of the soft budget -> downshift.
    assert services.scheduler._choose_batch_size(8, 900, 24000) <= 3
    # Plenty of headroom -> the largest candidate.
    assert services.scheduler._choose_batch_size(8, 100, 24000) == 8

    # A 0 soft limit falls back to physical VRAM.
    services.settings.runtime.vram_soft_limit_mb = 0
    assert services.scheduler._choose_batch_size(8, 5000, 10000) == 8
    assert services.scheduler._choose_batch_size(8, 9000, 10000) <= 3


def test_hard_vram_limit_pauses_dispatch_and_warns_once(services):
    job = _create_job(services, title="hard limit")
    services.job_manager.activate_job(job.id)
    services.settings.runtime.vram_hard_limit_mb = 100

    async def over_hard_limit():
        # total, allocated, reserved all above the hard limit.
        return ("cuda", 24000, 12000, 200, 23800, 32000, 16000, 4096, "cuda")

    services.model_manager.memory_stats = over_hard_limit  # type: ignore[method-assign]

    calls = {"count": 0}

    async def should_not_run(model_id, batch):
        calls["count"] += 1
        return []

    services.worker.render_batch = should_not_run  # type: ignore[method-assign]

    asyncio.run(services.scheduler.run_once())
    assert calls["count"] == 0
    warning = services.scheduler._warning
    assert warning is not None and "hard limit" in warning.lower()

    # Repeated ticks must not re-record the same warning every 0.2s.
    asyncio.run(services.scheduler.run_once())
    warnings = [
        event
        for event in services.telemetry.snapshot()["recent_events"]
        if event["type"] == "scheduler_warning"
    ]
    assert len(warnings) == 1
    # The scheduler is still alive and the queue still holds the work.
    assert services.job_manager.queue_depth() >= 1


def test_idle_unload_is_skipped_while_work_is_pending(services):
    from time import monotonic

    from app.jobs.models import ModelState

    job = _create_job(services, title="keep loaded")
    _add_chunk(services, job, "pending work")
    services.model_manager._state = ModelState.WARM_IDLE
    services.model_manager._loaded_model_id = "test-model"
    services.model_manager._last_used_at = monotonic() - 10_000
    services.settings.runtime.idle_unload_seconds = 1

    asyncio.run(services.model_manager.maybe_unload_idle(has_pending_work=True))
    assert services.model_manager.state == ModelState.WARM_IDLE

    asyncio.run(services.model_manager.maybe_unload_idle(has_pending_work=False))
    assert services.model_manager.state == ModelState.UNLOADED


def test_run_once_keeps_model_loaded_while_work_is_pending(services):
    from time import monotonic

    from app.jobs.models import ModelState

    job = _create_job(services, title="run once keep loaded")
    _add_chunk(services, job, "pending work")
    services.model_manager._state = ModelState.WARM_IDLE
    services.model_manager._loaded_model_id = services.settings.runtime.default_model_id
    services.model_manager._last_used_at = monotonic() - 10_000
    services.settings.runtime.idle_unload_seconds = 1

    async def noop_render(model_id, batch):
        return []

    services.worker.render_batch = noop_render  # type: ignore[method-assign]

    asyncio.run(services.scheduler.run_once())

    assert services.model_manager.state == ModelState.WARM_IDLE
    assert services.job_manager.queue_depth() >= 1


def test_oom_halves_the_batch_until_it_fits(services):
    """The real fake provider OOMs above 6 chunks / 2400 chars.

    The worker must keep shrinking (not just once) so an 8-chunk batch still
    renders, and the chunks it dropped must be requeued rather than stuck.
    """
    job = services.job_manager.create_job(
        source_text="A sentence long enough for a chunk. " * 300,
        source_kind="text",
        model_id=services.settings.runtime.default_model_id,
        voice_id="suzy",
        title="oom shrink",
    )
    services.job_manager.activate_job(job.id)
    services.settings.runtime.plan_ahead_chunks = 16
    services.settings.runtime.batch_candidates_small_model = [8]

    asyncio.run(services.scheduler.run_once())

    written = services.job_manager.get_job(job.id).written_chunks()
    assert 0 < len(written) < 8
    assert services.telemetry.snapshot()["oom_count"] >= 1
    assert services.job_manager.queue_depth() >= 1


def test_filling_listener_outranks_background_work(services):
    """A listener inside the 60s..300s window is band 1; background is band 2."""
    listener = _create_job(services, title="filling listener")
    background = _create_job(services, title="background", voice_id="howard")
    services.job_manager.activate_job(listener.id)

    listener = services.job_manager.get_job(listener.id)
    listener.buffered_seconds = 100.0

    assert services.scheduler._priority_band(listener) == 1
    assert services.scheduler._priority_band(services.job_manager.get_job(background.id)) == 2


def test_fully_buffered_listener_shares_band_with_background(services):
    """At/above the ideal buffer the listener drops into the background band."""
    listener = _create_job(services, title="fully buffered listener")
    background = _create_job(services, title="background two", voice_id="howard")
    services.job_manager.activate_job(listener.id)

    listener = services.job_manager.get_job(listener.id)
    listener.buffered_seconds = 1000.0

    assert services.scheduler._priority_band(listener) == 2
    assert services.scheduler._priority_band(services.job_manager.get_job(background.id)) == 2
