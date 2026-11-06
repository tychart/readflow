from __future__ import annotations

import pytest

from app.chunking.planner import ChunkPlan
from app.db.memory import MemoryDatabase
from app.jobs.manager import JobManager
from app.library.service import LibraryService
from app.library.tree import LibraryError, LibraryItem


def _setup(user_id: str = "local"):
    database = MemoryDatabase()
    return (
        database,
        JobManager(database, user_id=user_id),
        LibraryService(database, user_id=user_id),
    )


def _job(manager: JobManager, title: str, *, folder_id: str | None = None, text: str = "One. Two."):
    return manager.create_job(
        source_text=text,
        source_kind="text",
        model_id="Qwen/Qwen3-TTS-12Hz-0.6B-Base",
        voice_id="suzy",
        title=title,
        folder_id=folder_id,
    )


def test_folders_nest_and_keep_their_own_order():
    _, _, library = _setup()
    books = library.create_folder("Books")
    scifi = library.create_folder("Sci-fi", books.id)
    history = library.create_folder("History", books.id)

    snapshot = library.snapshot()
    assert {folder.id for folder in snapshot.folders} == {books.id, scifi.id, history.id}
    assert (scifi.position, history.position) == (0, 1)
    assert scifi.parent_id == books.id


def test_rename_rejects_blank_names_and_unknown_folders():
    _, _, library = _setup()
    folder = library.create_folder("Books")
    renamed = library.rename_folder(folder.id, "  Reading  ")
    assert renamed.name == "Reading"
    with pytest.raises(LibraryError):
        library.rename_folder(folder.id, "   ")
    with pytest.raises(KeyError):
        library.rename_folder("nope", "Name")


def test_jobs_append_to_their_folder_and_can_be_renamed():
    _, manager, library = _setup()
    folder = library.create_folder("Books")
    first = _job(manager, "One", folder_id=folder.id)
    second = _job(manager, "Two", folder_id=folder.id)
    root = _job(manager, "Root")

    assert (first.position, second.position) == (0, 1)
    assert root.folder_id is None and root.position == 0

    renamed = library.rename_job(first.id, "First book")
    assert renamed.title == "First book"
    with pytest.raises(LibraryError):
        library.rename_job(first.id, " ")


def test_reorder_writes_dense_positions_for_both_types():
    _, manager, library = _setup()
    folder = library.create_folder("Books")
    child = library.create_folder("Nested", folder.id)
    first = _job(manager, "One", folder_id=folder.id)
    second = _job(manager, "Two", folder_id=folder.id)

    library.reorder(folder.id, [child.id], [second.id, first.id])

    snapshot = library.snapshot()
    by_id = {job.id: job for job in snapshot.jobs}
    assert by_id[second.id].position == 0
    assert by_id[first.id].position == 1
    assert {f.id: f.position for f in snapshot.folders}[child.id] == 0


def test_reorder_rejects_a_stale_child_set():
    _, manager, library = _setup()
    folder = library.create_folder("Books")
    _job(manager, "One", folder_id=folder.id)
    with pytest.raises(LibraryError):
        library.reorder(folder.id, [], [])


def test_move_appends_and_reindexes_the_destination():
    _, manager, library = _setup()
    source = library.create_folder("Source")
    target = library.create_folder("Target")
    first = _job(manager, "One", folder_id=source.id)
    second = _job(manager, "Two", folder_id=source.id)
    existing = _job(manager, "Existing", folder_id=target.id)

    library.move([LibraryItem(kind="job", id=first.id)], target.id)

    snapshot = library.snapshot()
    by_id = {job.id: job for job in snapshot.jobs}
    assert by_id[existing.id].position == 0
    assert by_id[first.id].folder_id == target.id
    assert by_id[first.id].position == 1
    assert by_id[second.id].position == 0

    # Moving within the same folder appends and leaves no gaps.
    library.move([LibraryItem(kind="job", id=existing.id)], target.id)
    snapshot = library.snapshot()
    by_id = {job.id: job for job in snapshot.jobs}
    assert [by_id[job_id].position for job_id in (first.id, existing.id)] == [0, 1]


def test_move_rejects_a_folder_into_its_own_descendant():
    _, _, library = _setup()
    top = library.create_folder("Top")
    middle = library.create_folder("Middle", top.id)
    library.move([LibraryItem(kind="folder", id=middle.id)], top.id)

    with pytest.raises(LibraryError):
        library.move([LibraryItem(kind="folder", id=top.id)], middle.id)

    # The rejected move must not have changed anything.
    snapshot = library.snapshot()
    assert next(folder for folder in snapshot.folders if folder.id == top.id).parent_id is None


def test_delete_folder_trashes_one_subtree_entry():
    _, manager, library = _setup()
    top = library.create_folder("Top")
    nested = library.create_folder("Nested", top.id)
    first = _job(manager, "One", folder_id=top.id)
    second = _job(manager, "Two", folder_id=nested.id)

    entries = library.delete(
        [
            LibraryItem(kind="folder", id=top.id),
            LibraryItem(kind="folder", id=nested.id),
        ]
    )

    assert len(entries) == 1
    assert entries[0].job_count == 2
    snapshot = library.snapshot()
    assert snapshot.folders == []
    assert snapshot.jobs == []
    assert snapshot.trash_count == 1

    library.restore([entries[0].id])
    snapshot = library.snapshot()
    assert {folder.id for folder in snapshot.folders} == {top.id, nested.id}
    assert {job.id for job in snapshot.jobs} == {first.id, second.id}
    assert next(folder for folder in snapshot.folders if folder.id == nested.id).parent_id == top.id


def test_delete_job_remembers_its_parent_for_restore():
    _, manager, library = _setup()
    folder = library.create_folder("Books")
    job = _job(manager, "One", folder_id=folder.id)

    entries = library.delete([LibraryItem(kind="job", id=job.id)])
    assert entries[0].parent_id == folder.id
    assert entries[0].job_count == 1
    assert library.snapshot().jobs == []

    library.restore([entries[0].id])
    restored = library.snapshot().jobs[0]
    assert restored.folder_id == folder.id
    assert restored.position == 0


def test_restore_falls_back_to_the_root_when_the_parent_is_gone():
    _, manager, library = _setup()
    folder = library.create_folder("Books")
    job = _job(manager, "One", folder_id=folder.id)

    job_entry = library.delete([LibraryItem(kind="job", id=job.id)])[0]
    folder_entry = library.delete([LibraryItem(kind="folder", id=folder.id)])[0]
    library.purge([folder_entry.id])

    library.restore([job_entry.id])
    restored = library.snapshot().jobs[0]
    assert restored.folder_id is None
    assert restored.position == 0


def test_delete_folder_only_moves_children_to_the_parent():
    _, manager, library = _setup()
    container = library.create_folder("Container")
    holder = library.create_folder("Holder", container.id)
    nested = library.create_folder("Nested", holder.id)
    job = _job(manager, "One", folder_id=holder.id)

    entry = library.delete_folder_only(holder.id)

    snapshot = library.snapshot()
    by_folder = {folder.id: folder for folder in snapshot.folders}
    assert by_folder[nested.id].parent_id == container.id
    assert next(item for item in snapshot.jobs if item.id == job.id).folder_id == container.id
    assert holder.id not in by_folder
    assert entry.job_count == 0

    library.restore([entry.id])
    restored = next(folder for folder in library.snapshot().folders if folder.id == holder.id)
    assert restored.parent_id == container.id


def test_purge_removes_rows_and_progress_and_returns_job_ids(services=None):
    database, manager, library = _setup()
    folder = library.create_folder("Books")
    job = _job(manager, "One", folder_id=folder.id)
    manager.add_planned_chunk(job.id, ChunkPlan(text="One.", char_start=0, char_end=4))
    from app.library.progress_service import ProgressService

    progress = ProgressService(database)
    progress.record(job.id, position_seconds=3.0)

    entry = library.delete([LibraryItem(kind="folder", id=folder.id)])[0]
    purged = library.purge([entry.id])

    assert purged == [job.id]
    assert library.snapshot().folders == []
    with database.transaction() as uow:
        assert uow.jobs.get("local", job.id, include_deleted=True) is None
        assert uow.progress.get("local", job.id) is None


def test_empty_trash_purges_every_entry():
    _, manager, library = _setup()
    for index in range(3):
        job = _job(manager, f"Job {index}")
        library.delete([LibraryItem(kind="job", id=job.id)])

    assert len(library.list_trash()) == 3
    purged = library.purge(None)
    assert len(purged) == 3
    assert library.list_trash() == []
    assert library.snapshot().trash_count == 0


def test_unknown_items_are_rejected_without_changing_anything():
    _, manager, library = _setup()
    job = _job(manager, "One")
    with pytest.raises(KeyError):
        library.delete([LibraryItem(kind="job", id="missing")])
    with pytest.raises(KeyError):
        library.move([LibraryItem(kind="job", id="missing")], None)
    assert [item.id for item in library.snapshot().jobs] == [job.id]


def test_library_is_user_scoped():
    database = MemoryDatabase()
    owner = JobManager(database)
    owner_library = LibraryService(database)
    folder = owner_library.create_folder("Books")
    job = _job(owner, "One", folder_id=folder.id)

    other_library = LibraryService(database, user_id="someone-else")
    assert other_library.snapshot().folders == []
    assert other_library.snapshot().jobs == []
    with pytest.raises(KeyError):
        other_library.rename_job(job.id, "Mine now")


def test_delete_folder_only_preserves_the_children_order():
    _, _, library = _setup()
    container = library.create_folder("Container")
    holder = library.create_folder("Holder", container.id)
    first = library.create_folder("First", holder.id)
    second = library.create_folder("Second", holder.id)
    library.reorder(holder.id, [second.id, first.id], [])

    library.delete_folder_only(holder.id)

    snapshot = library.snapshot()
    by_folder = {folder.id: folder for folder in snapshot.folders}
    assert by_folder[second.id].parent_id == container.id
    assert by_folder[first.id].parent_id == container.id
    assert by_folder[second.id].position == 0
    assert by_folder[first.id].position == 1


def test_move_drops_selected_children_covered_by_a_selected_folder():
    """Search selection is flat: a folder and its child can both be selected."""
    _, manager, library = _setup()
    destination = library.create_folder("Destination")
    parent = library.create_folder("Parent")
    child = library.create_folder("Child", parent.id)
    job = _job(manager, "Inside", folder_id=parent.id)

    library.move(
        [
            LibraryItem(kind="folder", id=parent.id),
            LibraryItem(kind="folder", id=child.id),
            LibraryItem(kind="job", id=job.id),
        ],
        destination.id,
    )

    snapshot = library.snapshot()
    by_folder = {folder.id: folder for folder in snapshot.folders}
    by_job = {item.id: item for item in snapshot.jobs}
    assert by_folder[parent.id].parent_id == destination.id
    # The child and the job traveled with their parent instead of being
    # flattened into the destination.
    assert by_folder[child.id].parent_id == parent.id
    assert by_job[job.id].folder_id == parent.id
