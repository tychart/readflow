"""Query budgets: the read-model regression guard.

The scheduler used to load a full job aggregate inside its sort keys, which cost
~675 transactions and ~170 MiB of chunk text per tick at eight jobs. The numbers
below are what makes "one read per pass" a property instead of a hopeful comment.

Everything here counts real repository calls by wrapping the storage seam, so a
new `get_job` on the tick path fails a test instead of quietly reappearing.
"""

from __future__ import annotations

from collections import Counter
from typing import Any

import pytest

from app.scheduler.service import SchedulerService
from tests.conftest import Harness


class CountingRepository:
    def __init__(self, inner: Any, counters: Counter[str], name: str) -> None:
        self._inner = inner
        self._counters = counters
        self._name = name

    def __getattr__(self, attribute: str) -> Any:
        target: Any = getattr(self._inner, attribute)
        if not callable(target):
            return target

        async def counted(*args: Any, **kwargs: Any) -> Any:
            self._counters[f"{self._name}.{attribute}"] += 1
            result: Any = target(*args, **kwargs)
            return await result

        return counted


class CountingUnitOfWork:
    def __init__(self, inner: Any, counters: Counter[str]) -> None:
        self._inner = inner
        self._counters = counters
        for name in ("users", "sessions", "folders", "jobs", "sources", "progress", "trash"):
            setattr(self, name, CountingRepository(getattr(inner, name), counters, name))

    async def __aenter__(self) -> CountingUnitOfWork:
        await self._inner.__aenter__()
        return self

    async def __aexit__(self, exc_type: Any, exc: Any, tb: Any) -> None:
        await self._inner.__aexit__(exc_type, exc, tb)

    async def commit(self) -> None:
        await self._inner.commit()

    async def rollback(self) -> None:
        await self._inner.rollback()


def _count_calls(services: Harness, monkeypatch: pytest.MonkeyPatch) -> Counter[str]:
    """Count every repository call, whoever makes it.

    Wrapping `MemoryDatabase.transaction` rather than swapping `services.database`
    keeps the count honest for *all* services (scheduler, library, progress,
    preferences) without rebuilding the graph.
    """
    database = services.database
    counters: Counter[str] = Counter()
    original = database.transaction

    def counting_transaction() -> CountingUnitOfWork:
        return CountingUnitOfWork(original(), counters)

    monkeypatch.setattr(database, "transaction", counting_transaction)
    return counters


async def _seed_jobs(services: Harness, count: int) -> list[str]:
    """Jobs with enough text that planning and rendering are non-trivial."""
    ids = []
    for index in range(count):
        job = await services.jobs.create_job(
            source_text=(f"Job {index} sentence number {index}. " * 40),
            source_kind="text",
            model_id=services.settings.runtime.default_model_id,
            voice_id="suzy",
            title=f"Job {index}",
        )
        ids.append(job.id)
    return ids


@pytest.mark.parametrize("job_count", [3, 10])
async def test_a_tick_reads_the_job_table_a_constant_number_of_times(
    services: Harness, job_count: int, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A tick's reads must not scale with the library.

    Budget (per tick, with nothing dispatchable left after the first pass):
    summaries twice (once for the tick, once for the freshness broadcast),
    planned/rendering once each, and no aggregate load at all.
    """
    await _seed_jobs(services, job_count)
    counting = _count_calls(services, monkeypatch)

    # Warm-up: plan the window so the measured tick is the steady state.
    await services.scheduler.run_once()

    # Block dispatch so the measured tick is pure read model. A missing memory
    # reading is exactly the `MONITORING` block the scheduler already handles.
    async def no_memory_stats() -> None:
        return None

    monkeypatch.setattr(services.model_manager, "memory_stats", no_memory_stats)

    counting.clear()
    await services.scheduler.run_once()

    assert counting["jobs.get"] == 0, counting
    assert counting["jobs.get_any"] == 0
    assert counting["jobs.list"] == 0
    assert counting["jobs.save"] == 0
    # The tick reads the job table twice: once for the pass, once for the
    # freshness-sensitive broadcast at the end. Both are flat column reads.
    assert counting["jobs.summaries_all"] == 2, counting
    assert counting["jobs.planned_chunks"] == 1
    assert counting["jobs.rendering_chunks"] == 1
    assert counting["progress.get"] == 0


@pytest.mark.parametrize("job_count", [3, 10])
async def test_the_library_endpoint_does_not_scale_its_reads(
    client: Any, services: Harness, job_count: int, monkeypatch: pytest.MonkeyPatch
) -> None:
    await _seed_jobs(services, job_count)
    counting = _count_calls(services, monkeypatch)

    response = await client.get("/api/library")
    assert response.status_code == 200

    assert counting["jobs.summaries"] == 1
    assert counting["jobs.list"] == 0
    assert counting["jobs.source_text"] == 0
    assert counting["jobs.source_text_any"] == 0
    # Folders/progress/trash are each one read, independent of job count.
    assert counting["folders.list"] == 1
    assert counting["progress.list"] == 1


async def test_the_jobs_list_does_not_load_aggregates(
    client: Any, services: Harness, monkeypatch: pytest.MonkeyPatch
) -> None:
    await _seed_jobs(services, 5)
    counting = _count_calls(services, monkeypatch)

    response = await client.get("/api/jobs")
    assert response.status_code == 200

    assert counting["jobs.summaries"] == 1
    assert counting["jobs.list"] == 0
    assert counting["jobs.source_text"] == 0


async def test_the_reader_detail_is_a_bounded_number_of_reads(
    client: Any, services: Harness, monkeypatch: pytest.MonkeyPatch
) -> None:
    job_ids = await _seed_jobs(services, 5)
    counting = _count_calls(services, monkeypatch)

    response = await client.get(f"/api/jobs/{job_ids[0]}")
    assert response.status_code == 200

    # Detail is allowed exactly one aggregate load and one source read; the
    # folder context comes from summaries, not from every job's chunks.
    assert counting["jobs.get"] == 1
    assert counting["jobs.list"] == 0
    assert counting["jobs.source_text"] == 1
    assert counting["jobs.summaries"] == 1


async def test_planning_a_job_reads_its_source_text_once_per_process(
    services: Harness, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The cache is the reason a book is not re-read on every tick."""
    job = await services.jobs.create_job(
        source_text="One sentence per chunk please. " * 400,
        source_kind="text",
        model_id=services.settings.runtime.default_model_id,
        voice_id="suzy",
    )
    counting = _count_calls(services, monkeypatch)

    for _ in range(4):
        await services.scheduler.run_once()

    # Planning keeps consuming the same document across ticks.
    assert counting["jobs.source_text_any"] == 1, counting
    summaries = await services.jobs.summaries_all()
    planned = next(summary for summary in summaries if summary.id == job.id)
    # The whole document was planned across those ticks, from one source read.
    assert planned.planner_cursor.exhausted
    assert planned.planner_cursor.chunks_emitted > 1


async def test_deleting_a_job_forgets_its_cached_source(services: Harness) -> None:
    job = await services.jobs.create_job(
        source_text="Cache me. " * 50,
        source_kind="text",
        model_id=services.settings.runtime.default_model_id,
        voice_id="suzy",
    )
    await services.scheduler.run_once()
    assert job.id in services.scheduler._source_cache

    services.scheduler.forget_source(job.id)

    assert job.id not in services.scheduler._source_cache


def _scheduler(services: Harness) -> SchedulerService:
    return services.scheduler


async def test_the_admin_queue_snapshot_is_the_only_heavy_read(
    services: Harness, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The inspector loads aggregates on purpose; it must stay admin-only."""
    await _seed_jobs(services, 3)
    counting = _count_calls(services, monkeypatch)

    snapshot = await _scheduler(services).queue_snapshot()

    assert snapshot.jobs
    # Documented exception: the queue inspector shows every chunk of every job,
    # which no summary can carry.
    assert counting["jobs.list_all"] == 1
    assert counting["jobs.summaries_all"] <= 2


def test_the_scheduler_helpers_the_probe_measures_still_exist() -> None:
    """The docs point at these; a rename must fail a test, not the probe."""
    names = {
        "run_once": SchedulerService.run_once,
        "_rank_renderable_chunks": SchedulerService._rank_renderable_chunks,
        "_ordered_for_dispatch": SchedulerService._ordered_for_dispatch,
    }
    assert all(callable(value) for value in names.values())
