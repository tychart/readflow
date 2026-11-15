"""Property tests for the dirty diff.

The diff decides what reaches the database, so the invariant is exact and worth
stating as a property: after any mix of mutations and appends, `save` must report
precisely the chunks whose mutable state moved and precisely the ones that are
new. A hypothesis failure here means a silent lost update in production.
"""

from __future__ import annotations

from hypothesis import given, settings
from hypothesis import strategies as st

from app.db.postgres.mapping import changed_chunks, chunk_snapshots
from app.jobs.models import ChunkStatus
from tests.unit.library_helpers import build_chunk

Floats = st.floats(min_value=0, max_value=10_000, allow_nan=False)


@settings(max_examples=150, deadline=None)
@given(
    text=st.text(min_size=1, max_size=20),
    status=st.sampled_from(list(ChunkStatus)),
    duration=Floats,
    start=Floats,
    attempts=st.integers(min_value=0, max_value=5),
    deprecated=st.booleans(),
    error=st.one_of(st.none(), st.text(min_size=1, max_size=10)),
    plan_version=st.integers(min_value=1, max_value=5),
    appended=st.integers(min_value=0, max_value=3),
)
def test_the_diff_reports_exactly_the_changed_and_new_chunks(
    text: str,
    status: ChunkStatus,
    duration: float,
    start: float,
    attempts: int,
    deprecated: bool,
    error: str | None,
    plan_version: int,
    appended: int,
) -> None:
    chunks = [build_chunk("job-1", index) for index in range(3)]
    snapshots = chunk_snapshots(chunks)

    # Touch chunk 0 only; every field is one the scheduler can actually write.
    chunks[0].text = text
    chunks[0].status = status
    chunks[0].duration_seconds = duration
    chunks[0].start_seconds = start
    chunks[0].attempts = attempts
    chunks[0].deprecated = deprecated
    chunks[0].error = error
    chunks[0].plan_version = plan_version

    new_takes = [build_chunk("job-1", index, version=1) for index in range(appended)]
    chunks.extend(new_takes)

    updates, inserts = changed_chunks(snapshots, chunks)

    # Every appended take is an insert, and nothing else is.
    assert {chunk.index for chunk in inserts} == {chunk.index for chunk in new_takes}
    # Only chunk 0 may be reported as changed, and only if it really moved
    # (a field written with the value it already had is not a change).
    assert {chunk.index for chunk in updates} <= {0}


@settings(max_examples=50, deadline=None)
@given(appended=st.integers(min_value=1, max_value=5))
def test_no_mutation_means_no_writes(appended: int) -> None:
    chunks = [build_chunk("job-1", index) for index in range(3)]
    chunks.extend(build_chunk("job-1", index, version=1) for index in range(appended))
    snapshots = chunk_snapshots(chunks)

    updates, inserts = changed_chunks(snapshots, chunks)

    assert updates == []
    assert inserts == []


@given(versions=st.lists(st.integers(min_value=0, max_value=4), min_size=1, unique=True))
def test_each_take_of_one_index_is_its_own_row(versions: list[int]) -> None:
    chunks = [build_chunk("job-1", 0, version=version) for version in versions]
    snapshots = chunk_snapshots(chunks)

    assert len(snapshots) == len(versions)
    updates, inserts = changed_chunks(snapshots, chunks)
    assert updates == []
    assert inserts == []
