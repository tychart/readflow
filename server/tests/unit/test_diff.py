"""The chunk dirty diff.

A job's chunk list is append-only and a book has thousands of rows, so `save`
must write only what changed. The failure modes are asymmetric and both bad:
missing an update loses an edit silently, and reporting a spurious one rewrites
a whole table on every save.
"""

from __future__ import annotations

from app.db.postgres.mapping import (
    CHUNK_MUTABLE_FIELDS,
    changed_chunks,
    chunk_snapshot,
    chunk_snapshots,
)
from app.jobs.models import ChunkStatus
from tests.unit.library_helpers import build_chunk


def _chunks():
    return [build_chunk("job-1", index) for index in range(3)]


def test_an_unchanged_aggregate_produces_no_writes() -> None:
    chunks = _chunks()
    updates, inserts = changed_chunks(chunk_snapshots(chunks), chunks)
    assert updates == []
    assert inserts == []


def test_only_the_touched_chunk_is_updated() -> None:
    chunks = _chunks()
    snapshots = chunk_snapshots(chunks)

    chunks[1].status = ChunkStatus.WRITTEN
    chunks[1].duration_seconds = 12.5

    updates, inserts = changed_chunks(snapshots, chunks)
    assert [chunk.index for chunk in updates] == [1]
    assert inserts == []


def test_a_new_take_is_an_insert_not_an_update() -> None:
    chunks = _chunks()
    snapshots = chunk_snapshots(chunks)
    chunks.append(build_chunk("job-1", 0, version=1))

    updates, inserts = changed_chunks(snapshots, chunks)
    assert updates == []
    assert [(chunk.index, chunk.version) for chunk in inserts] == [(0, 1)]


def test_deprecating_a_take_is_an_update() -> None:
    chunks = _chunks()
    snapshots = chunk_snapshots(chunks)
    chunks[0].deprecated = True

    updates, _inserts = changed_chunks(snapshots, chunks)
    assert [chunk.index for chunk in updates] == [0]


def test_every_mutable_field_is_part_of_the_snapshot() -> None:
    """A field the scheduler writes must be in the diff, or the write is lost."""
    chunk = build_chunk("job-1", 0)
    snapshot = chunk_snapshot(chunk)
    for name in CHUNK_MUTABLE_FIELDS:
        assert len(snapshot) == len(CHUNK_MUTABLE_FIELDS)
        assert hasattr(chunk, name)
    assert "status" in CHUNK_MUTABLE_FIELDS
    assert "duration_seconds" in CHUNK_MUTABLE_FIELDS
    assert "deprecated" in CHUNK_MUTABLE_FIELDS
    assert "attempts" in CHUNK_MUTABLE_FIELDS
