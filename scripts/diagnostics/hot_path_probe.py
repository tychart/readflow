#!/usr/bin/env python3
"""Measure the scheduler's hot path against the memory adapter.

This is the harness behind the Postgres/read-model work (see
``docs/plan-postgres-auth.md``): it builds the real service graph on the
in-memory database, wraps the storage boundary in a counter, and runs
scheduler ticks so we can compare "how much does one tick read and write"
before and after a change.

Run it from ``server/`` so the app package and its virtualenv are on the path::

    cd server && uv run python ../scripts/diagnostics/hot_path_probe.py --jobs 8

The same script runs at every phase boundary, so the numbers are comparable as
long as the arguments are. Nothing here is a test -- it only prints.

What is measured
----------------
Every call through ``Database``/``UnitOfWork`` is counted by name. "Bytes" is an
*estimate* of the aggregate materialised by a read: the canonical source text
plus every chunk's text and a fixed per-chunk overhead. It is a comparative
figure (before vs. after), not a wire measurement.

What a tick does
----------------
The probe replaces the worker's ``render_batch`` with a no-op that returns no
results. A tick therefore plans, ranks, marks a batch ``RENDERING`` and puts it
back in the queue, which is exactly the read/write shape of a real tick without
paying for synthesis. Warm-up ticks fill the plan-ahead window first so the
steady state is measured, not the empty-database start.
"""

from __future__ import annotations

import argparse
import asyncio
import sys
from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

SERVER_DIR = Path(__file__).resolve().parents[2] / "server"
if str(SERVER_DIR) not in sys.path:
    sys.path.insert(0, str(SERVER_DIR))

from app.core.config import RuntimeConfig, Settings  # noqa: E402
from app.core.services import AppServices, build_services  # noqa: E402
from app.db.memory import MemoryDatabase  # noqa: E402
from app.jobs.models import ChunkRecord, Job  # noqa: E402

# Rough per-chunk bookkeeping cost (ids, paths, timestamps, status). Kept
# explicit so the byte estimate is reproducible rather than magic.
CHUNK_OVERHEAD_BYTES = 240

# Repository methods whose result is a Job aggregate.
_AGGREGATE_METHODS = frozenset({"get", "get_any"})
_AGGREGATE_LIST_METHODS = frozenset({"list", "planned_chunks", "rendering_chunks"})


def job_bytes(job: Job, *, include_source: bool = True) -> int:
    """Approximate the in-memory size materialised by loading one aggregate."""
    total = 0
    if include_source:
        total += len(job.source_text.encode("utf-8"))
    for chunk in job.chunks:
        total += len(chunk.text.encode("utf-8")) + CHUNK_OVERHEAD_BYTES
    return total


@dataclass
class Counters:
    calls: Counter[str] = field(default_factory=Counter)
    bytes_read: int = 0

    def add_call(self, name: str) -> None:
        self.calls[name] += 1

    def reset(self) -> None:
        self.calls.clear()
        self.bytes_read = 0

    def call_count(self, name: str) -> int:
        return self.calls[name]

    @property
    def total(self) -> int:
        return sum(self.calls.values())


class CountingRepository:
    """Proxy that counts calls to one repository and the bytes it returns."""

    def __init__(
        self,
        inner: Any,
        counters: Counters,
        *,
        name: str,
        aggregate: bool = False,
    ) -> None:
        self._inner = inner
        self._counters = counters
        self._name = name
        self._aggregate = aggregate

    def __getattr__(self, attribute: str) -> Any:
        target = getattr(self._inner, attribute)
        if not callable(target):
            return target

        def counted(*args: Any, **kwargs: Any) -> Any:
            self._counters.add_call(f"{self._name}.{attribute}")
            result = target(*args, **kwargs)
            self._counters.bytes_read += self._result_bytes(attribute, result)
            return result

        return counted

    def _result_bytes(self, method: str, result: Any) -> int:
        if self._name != "jobs":
            if self._name == "sources" and method == "get" and isinstance(result, str):
                return len(result.encode("utf-8"))
            return 0
        if self._aggregate and method in _AGGREGATE_METHODS and isinstance(result, Job):
            return job_bytes(result)
        if self._aggregate and method in _AGGREGATE_LIST_METHODS:
            return sum(job_bytes(job) for job in result or ())
        return 0


class CountingUnitOfWork:
    def __init__(self, inner: Any, counters: Counters) -> None:
        self._inner = inner
        self._counters = counters
        counters.add_call("transaction")
        self.jobs = CountingRepository(inner.jobs, counters, name="jobs", aggregate=True)
        self.folders = CountingRepository(inner.folders, counters, name="folders")
        self.progress = CountingRepository(inner.progress, counters, name="progress")
        self.trash = CountingRepository(inner.trash, counters, name="trash")
        self.users = CountingRepository(inner.users, counters, name="users")

    def __enter__(self) -> CountingUnitOfWork:
        self._inner.__enter__()
        return self

    def __exit__(self, exc_type: Any, exc: Any, tb: Any) -> None:
        self._inner.__exit__(exc_type, exc, tb)

    def commit(self) -> None:
        self._inner.commit()

    def rollback(self) -> None:
        self._inner.rollback()


class CountingDatabase:
    def __init__(self, inner: Any) -> None:
        self.inner = inner
        self.counters = Counters()

    def transaction(self) -> CountingUnitOfWork:
        return CountingUnitOfWork(self.inner.transaction(), self.counters)

    def get_user(self, user_id: str) -> Any:
        self.counters.add_call("database.get_user")
        return self.inner.get_user(user_id)


def build_fixture(*, job_count: int, source_chars: int) -> tuple[AppServices, CountingDatabase]:
    settings = Settings(
        tts_provider="fake",
        scheduler_autostart=False,
        temp_dir_name=f"readflow-probe-{job_count}",
        runtime=RuntimeConfig(default_voice_id="suzy"),
    )
    counting = CountingDatabase(MemoryDatabase())
    services = build_services(settings, SERVER_DIR, database=counting)

    text = "The quick brown fox jumps over the lazy dog. " * (source_chars // 45 + 1)
    text = text[:source_chars]
    for index in range(job_count):
        services.job_manager.create_job(
            source_text=f"Probe job {index}\n\n{text}",
            source_kind="text",
            model_id=settings.runtime.default_model_id,
            voice_id=settings.runtime.default_voice_id,
        )

    async def no_render(model_id: str, chunks: list[ChunkRecord]) -> list[Any]:
        del model_id, chunks
        return []

    services.worker.render_batch = no_render  # type: ignore[method-assign]
    return services, counting


async def run_ticks(services: AppServices, *, warmup: int, ticks: int) -> list[Counters]:
    for _ in range(warmup):
        await services.scheduler.run_once()
    samples: list[Counters] = []
    database = services.database
    assert isinstance(database, CountingDatabase)
    for _ in range(ticks):
        database.counters.reset()
        await services.scheduler.run_once()
        samples.append(
            Counters(
                calls=Counter(database.counters.calls), bytes_read=database.counters.bytes_read
            )
        )
    return samples


def summarize(samples: list[Counters]) -> Counter[str]:
    totals: Counter[str] = Counter()
    for sample in samples:
        totals.update(sample.calls)
    averaged = Counter({name: count / len(samples) for name, count in totals.items()})
    return averaged


def main() -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("--jobs", type=int, default=8, help="number of jobs in the library")
    parser.add_argument("--chars", type=int, default=223 * 1024, help="source characters per job")
    parser.add_argument("--ticks", type=int, default=5, help="measured scheduler ticks")
    parser.add_argument(
        "--warmup", type=int, default=3, help="warm-up ticks (planning window fill)"
    )
    args = parser.parse_args()

    services, _database = build_fixture(job_count=args.jobs, source_chars=args.chars)
    samples = asyncio.run(run_ticks(services, warmup=args.warmup, ticks=args.ticks))

    averaged = summarize(samples)
    mean_bytes = sum(sample.bytes_read for sample in samples) / len(samples)

    print(
        f"hot path probe: {args.jobs} jobs x {args.chars} chars, "
        f"{args.ticks} ticks after {args.warmup} warm-up ticks\n"
    )
    print(f"  {'call':40s} {'per tick':>10s}")
    print(f"  {'-' * 40} {'-' * 10}")
    for name, count in sorted(averaged.items(), key=lambda item: (-item[1], item[0])):
        print(f"  {name:40s} {count:10.1f}")
    print(f"  {'-' * 40} {'-' * 10}")
    print(f"  {'TOTAL calls':40s} {sum(averaged.values()):10.1f}")
    print(f"\n  aggregate bytes read/tick: {mean_bytes / (1024 * 1024):.1f} MiB")
    print(
        "  transactions/tick: "
        f"{averaged['transaction']:.1f}   "
        f"jobs.get/tick: {averaged['jobs.get']:.1f}   "
        f"jobs.list/tick: {averaged['jobs.list']:.1f}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
