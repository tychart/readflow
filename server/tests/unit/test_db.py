"""Contract tests for the storage boundary.

The same tests are meant to run against every adapter. Adding a SQL adapter
means adding it to `ADAPTER_FACTORIES`; any failure there is a real semantic
difference between the in-memory database and production, which is exactly the
drift this suite exists to catch.
"""

from __future__ import annotations

from collections.abc import Callable

import pytest

from app.chunking.planner import ChunkPlan
from app.core.identity import DEFAULT_USER_ID
from app.db.memory import MemoryDatabase, MemoryJobRepository
from app.db.models import User
from app.db.protocols import Database
from app.jobs.manager import JobManager
from app.jobs.models import Job

ADAPTER_FACTORIES: list[Callable[[], Database]] = [MemoryDatabase]


@pytest.fixture(params=ADAPTER_FACTORIES, ids=lambda factory: factory.__name__)
def database(request: pytest.FixtureRequest) -> Database:
    return request.param()


def _job(job_id: str, *, user_id: str = DEFAULT_USER_ID, title: str = "Job") -> Job:
    return Job(
        id=job_id,
        title=title,
        source_kind="text",
        source_char_count=len("Hello there."),
        model_id="Qwen/Qwen3-TTS-12Hz-0.6B-Base",
        voice_id="suzy",
        user_id=user_id,
    )


def test_default_user_is_seeded_once(database: Database) -> None:
    user = database.get_user(DEFAULT_USER_ID)
    assert isinstance(user, User)
    assert user.display_name
    assert database.get_user("does-not-exist") is None


def test_user_preferences_are_saved_through_the_unit_of_work(database: Database) -> None:
    """Profile data on the user row follows the same save contract as jobs."""
    with database.transaction() as uow:
        user = uow.users.get(DEFAULT_USER_ID)
        assert user is not None
        user.preferred_model_id = "Qwen/Qwen3-TTS-12Hz-1.7B-Base"
        user.preferred_voice_id = "howard"
        uow.users.save(user)

    stored = database.get_user(DEFAULT_USER_ID)
    assert stored is not None
    assert stored.preferred_model_id == "Qwen/Qwen3-TTS-12Hz-1.7B-Base"
    assert stored.preferred_voice_id == "howard"


def test_saving_an_unknown_user_raises(database: Database) -> None:
    with pytest.raises(KeyError):
        with database.transaction() as uow:
            uow.users.save(User(id="never-added"))


def test_add_get_list_and_delete_are_user_scoped(database: Database) -> None:
    with database.transaction() as uow:
        uow.jobs.add(_job("a"), source_text="Hello there.")
        uow.jobs.add(_job("b", title="Other title"), source_text="Hello there.")
        uow.jobs.add(_job("c", user_id="someone-else"), source_text="Hello there.")

    with database.transaction() as uow:
        assert uow.jobs.get(DEFAULT_USER_ID, "a") is not None
        assert uow.jobs.get(DEFAULT_USER_ID, "c") is None
        assert {job.id for job in uow.jobs.list(DEFAULT_USER_ID)} == {"a", "b"}

    with database.transaction() as uow:
        uow.jobs.delete(DEFAULT_USER_ID, "a")

    with database.transaction() as uow:
        assert uow.jobs.get(DEFAULT_USER_ID, "a") is None


def test_add_rejects_duplicate_ids(database: Database) -> None:
    with database.transaction() as uow:
        uow.jobs.add(_job("duplicate"), source_text="Hello there.")
    with pytest.raises(ValueError):
        with database.transaction() as uow:
            uow.jobs.add(_job("duplicate"), source_text="Hello there.")


def test_save_requires_an_existing_row(database: Database) -> None:
    with pytest.raises(KeyError):
        with database.transaction() as uow:
            uow.jobs.save(_job("never-added"))


def test_repeated_reads_return_the_same_instance(database: Database) -> None:
    """Identity within a transaction is what lets services mutate and save."""
    with database.transaction() as uow:
        uow.jobs.add(_job("same"), source_text="Hello there.")
    with database.transaction() as uow:
        first = uow.jobs.get(DEFAULT_USER_ID, "same")
        second = uow.jobs.get(DEFAULT_USER_ID, "same")
    assert first is second


def test_rollback_undoes_structural_changes(database: Database) -> None:
    with database.transaction() as uow:
        uow.jobs.add(_job("existing"), source_text="Hello there.")

    with pytest.raises(RuntimeError):
        with database.transaction() as uow:
            uow.jobs.add(_job("discarded"), source_text="Hello there.")
            uow.jobs.delete(DEFAULT_USER_ID, "existing")
            raise RuntimeError("abort")

    # The insert of `discarded` is gone and the delete of `existing` is undone.
    with database.transaction() as uow:
        assert uow.jobs.get(DEFAULT_USER_ID, "existing") is not None
        assert uow.jobs.get(DEFAULT_USER_ID, "discarded") is None


def test_commit_keeps_writes(database: Database) -> None:
    with database.transaction() as uow:
        uow.jobs.add(_job("kept"), source_text="Hello there.")
    with database.transaction() as uow:
        assert uow.jobs.get(DEFAULT_USER_ID, "kept") is not None


def test_manager_reads_and_writes_through_the_database(database: Database) -> None:
    manager = JobManager(database)
    job = manager.create_job(
        source_text="One. Two.",
        source_kind="text",
        model_id="Qwen/Qwen3-TTS-12Hz-0.6B-Base",
        voice_id="suzy",
        title="Through the seam",
    )
    assert job.user_id == DEFAULT_USER_ID

    # A second read comes from the database, not from a manager-side cache.
    with database.transaction() as uow:
        stored = uow.jobs.get(DEFAULT_USER_ID, job.id)
    assert stored is job

    manager.delete_job(job.id)
    with database.transaction() as uow:
        assert uow.jobs.get(DEFAULT_USER_ID, job.id) is None


def test_manager_cannot_see_another_users_job(database: Database) -> None:
    owner = JobManager(database)
    job = owner.create_job(
        source_text="Private.",
        source_kind="text",
        model_id="Qwen/Qwen3-TTS-12Hz-0.6B-Base",
        voice_id="suzy",
    )

    intruder = JobManager(database, user_id="intruder")
    assert intruder.list_jobs() == []
    with pytest.raises(KeyError):
        intruder.get_job(job.id)
    with pytest.raises(KeyError):
        intruder.activate_job(job.id)


def test_manager_mutations_are_saved(database: Database, monkeypatch: pytest.MonkeyPatch) -> None:
    """Every command must declare its write, not rely on shared memory."""
    saves: list[str] = []
    original_save = MemoryJobRepository.save

    def recording_save(self: MemoryJobRepository, job: Job) -> None:
        saves.append(job.id)
        original_save(self, job)

    monkeypatch.setattr(MemoryJobRepository, "save", recording_save)

    manager = JobManager(database)
    job = manager.create_job(
        source_text="One. Two.",
        source_kind="text",
        model_id="Qwen/Qwen3-TTS-12Hz-0.6B-Base",
        voice_id="suzy",
    )
    manager.add_planned_chunk(job.id, ChunkPlan(text="One.", char_start=0, char_end=4))
    manager.activate_job(job.id)
    manager.set_render_to_end(job.id, True)

    assert saves == [job.id, job.id, job.id]


def test_manager_queue_queries_are_user_scoped(database: Database) -> None:
    owner = JobManager(database)
    job = owner.create_job(
        source_text="One. Two.",
        source_kind="text",
        model_id="Qwen/Qwen3-TTS-12Hz-0.6B-Base",
        voice_id="suzy",
    )
    owner.add_planned_chunk(job.id, ChunkPlan(text="One.", char_start=0, char_end=4))

    other = JobManager(database, user_id="other")
    assert list(other.renderable_chunks()) == []
    assert other.queue_depth() == 0
    assert owner.queue_depth() == 1


def test_a_job_is_stored_with_its_source_text_in_its_own_row(database: Database) -> None:
    """The aggregate carries only the length; the text is a separate read."""
    job = _job("with-source")
    with database.transaction() as uow:
        uow.jobs.add(job, source_text="Hello there.")
        assert uow.sources.get(job.id) == "Hello there."
        assert uow.jobs.source_text(DEFAULT_USER_ID, job.id) == "Hello there."

    # Deleting the job takes the source row with it, like the SQL cascade.
    with database.transaction() as uow:
        uow.jobs.delete(DEFAULT_USER_ID, "with-source")
        assert uow.sources.get("with-source") is None


def test_source_text_is_user_scoped(database: Database) -> None:
    with database.transaction() as uow:
        uow.jobs.add(_job("mine"), source_text="Private.")

    with database.transaction() as uow:
        # Another user's job id is indistinguishable from a missing one.
        with pytest.raises(KeyError):
            uow.jobs.source_text("intruder", "mine")
        # The system-scoped read has no ownership check, by design.
        assert uow.jobs.source_text_any("mine") == "Private."


def test_summaries_match_the_aggregates(database: Database) -> None:
    manager = JobManager(database)
    job = manager.create_job(
        source_text="One. Two. Three.",
        source_kind="text",
        model_id="Qwen/Qwen3-TTS-12Hz-0.6B-Base",
        voice_id="suzy",
    )
    manager.add_planned_chunk(job.id, ChunkPlan(text="One.", char_start=0, char_end=4))

    with database.transaction() as uow:
        aggregate = uow.jobs.get(DEFAULT_USER_ID, job.id)
        summary = next(row for row in uow.jobs.summaries(DEFAULT_USER_ID) if row.id == job.id)
        all_summaries = [row for row in uow.jobs.summaries_all() if row.id == job.id]
    assert aggregate is not None
    assert summary == aggregate.summary()
    assert all_summaries == [summary]
    # A summary has no chunk list at all.
    assert not hasattr(summary, "chunks")


def test_planned_and_rendering_chunks_span_every_job(database: Database) -> None:
    manager = JobManager(database)
    first = manager.create_job(
        source_text="One. Two.",
        source_kind="text",
        model_id="Qwen/Qwen3-TTS-12Hz-0.6B-Base",
        voice_id="suzy",
    )
    second = manager.create_job(
        source_text="Three. Four.",
        source_kind="text",
        model_id="Qwen/Qwen3-TTS-12Hz-0.6B-Base",
        voice_id="suzy",
    )
    manager.add_planned_chunk(first.id, ChunkPlan(text="One.", char_start=0, char_end=4))
    chunk = manager.add_planned_chunk(second.id, ChunkPlan(text="Three.", char_start=0, char_end=6))
    manager.mark_chunk_rendering(chunk)

    with database.transaction() as uow:
        planned = uow.jobs.planned_chunks()
        rendering = uow.jobs.rendering_chunks()
    assert {item.job_id for item in planned} == {first.id}
    assert [item.job_id for item in rendering] == [second.id]

    # A paused job is excluded from dispatch, and a trashed job from both.
    manager.pause_job(first.id)
    with database.transaction() as uow:
        assert uow.jobs.planned_chunks() == []


def test_a_foreign_users_job_is_indistinguishable_from_a_missing_one(database: Database) -> None:
    with database.transaction() as uow:
        uow.jobs.add(_job("theirs", user_id="someone-else"), source_text="Theirs.")

    with database.transaction() as uow:
        assert uow.jobs.get(DEFAULT_USER_ID, "theirs") is None
        assert uow.jobs.get(DEFAULT_USER_ID, "never-existed") is None
        # The system scope is the only place it is visible.
        assert uow.jobs.get_any("theirs") is not None
