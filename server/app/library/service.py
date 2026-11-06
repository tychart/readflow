"""Library commands: folders, manual ordering, moves and trash.

Every method is one transaction over the storage seam. Validation happens before
any mutation so a rejected move/reorder leaves the library exactly as it was
(the in-memory adapter does not snapshot in-place edits).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from time import time
from uuid import uuid4

from app.core.identity import DEFAULT_USER_ID
from app.db.protocols import Database, UnitOfWork
from app.jobs.models import Job
from app.library.models import Folder, JobProgress, TrashEntry, TrashKind
from app.library.tree import (
    LibraryError,
    LibraryItem,
    assert_move_is_acyclic,
    descendant_folder_ids,
    normalize_order,
)
from app.library.tree import (
    folder_path as build_folder_path,
)


@dataclass(frozen=True, slots=True)
class LibrarySnapshot:
    """Everything the library page needs in one consistent read."""

    folders: list[Folder]
    jobs: list[Job]
    progress: dict[str, JobProgress] = field(default_factory=dict)
    trash_count: int = 0


class LibraryService:
    def __init__(self, database: Database, *, user_id: str = DEFAULT_USER_ID) -> None:
        self._db = database
        self._user_id = user_id

    # ── reads ───────────────────────────────────────────────────────────────

    def snapshot(self) -> LibrarySnapshot:
        with self._db.transaction() as uow:
            folders = uow.folders.list(self._user_id)
            jobs = uow.jobs.list(self._user_id)
            progress = {row.job_id: row for row in uow.progress.list(self._user_id)}
            trash_count = len(uow.trash.list(self._user_id))
        return LibrarySnapshot(
            folders=folders, jobs=jobs, progress=progress, trash_count=trash_count
        )

    def folder_path(self, folder_id: str | None) -> list[Folder]:
        with self._db.transaction() as uow:
            folders = uow.folders.list(self._user_id)
        return build_folder_path(folders, folder_id)

    def get_job(self, job_id: str, *, include_deleted: bool = False) -> Job:
        with self._db.transaction() as uow:
            job = uow.jobs.get(self._user_id, job_id, include_deleted=include_deleted)
            if job is None:
                raise KeyError(f"Unknown job '{job_id}'")
            return job

    # ── folders ─────────────────────────────────────────────────────────────

    def create_folder(self, name: str, parent_id: str | None = None) -> Folder:
        clean_name = self._clean_name(name)
        now = time()
        with self._db.transaction() as uow:
            self._require_live_folder(uow, parent_id)
            folder = Folder(
                id=str(uuid4()),
                name=clean_name,
                user_id=self._user_id,
                parent_id=parent_id,
                position=uow.folders.next_position(self._user_id, parent_id),
                created_at=now,
                updated_at=now,
            )
            uow.folders.add(folder)
            return folder

    def rename_folder(self, folder_id: str, name: str) -> Folder:
        clean_name = self._clean_name(name)
        with self._db.transaction() as uow:
            folder = self._require_folder(uow, folder_id)
            folder.name = clean_name
            folder.updated_at = time()
            uow.folders.save(folder)
            return folder

    def rename_job(self, job_id: str, title: str) -> Job:
        clean_title = self._clean_title(title)
        with self._db.transaction() as uow:
            job = self._require_live_job(uow, job_id)
            job.title = clean_title
            job.updated_at = time()
            uow.jobs.save(job)
            return job

    # ── ordering and moves ──────────────────────────────────────────────────

    def reorder(
        self,
        parent_id: str | None,
        folder_ids: list[str],
        job_ids: list[str],
    ) -> None:
        """Write the manual order of one folder's direct children.

        Folders and jobs have separate position sequences because the UI always
        renders folders first. The request must name exactly the current
        children, otherwise a stale drag result is rejected.
        """
        with self._db.transaction() as uow:
            self._require_live_folder(uow, parent_id)
            folders = uow.folders.list(self._user_id)
            jobs = uow.jobs.list(self._user_id)
            current_folder_ids = [folder.id for folder in folders if folder.parent_id == parent_id]
            current_job_ids = [job.id for job in jobs if job.folder_id == parent_id]
            ordered_folders = normalize_order(current_folder_ids, folder_ids)
            ordered_jobs = normalize_order(current_job_ids, job_ids)

            by_folder_id = {folder.id: folder for folder in folders}
            for position, folder_id in enumerate(ordered_folders):
                folder = by_folder_id[folder_id]
                folder.position = position
                folder.updated_at = time()
                uow.folders.save(folder)
            by_job_id = {job.id: job for job in jobs}
            for position, job_id in enumerate(ordered_jobs):
                job = by_job_id[job_id]
                job.position = position
                job.updated_at = time()
                uow.jobs.save(job)

    def move(self, items: list[LibraryItem], folder_id: str | None) -> None:
        """Move folders/jobs into `folder_id`, appended in the given order.

        Both the destination and every source parent are re-indexed afterwards,
        so moving an item out cannot leave a gap behind and moving within one
        folder cannot exceed its sibling count.

        A selection can contain a folder and something inside it (search results
        are flat). The child travels with its ancestor; moving it separately
        would flatten the tree, so nested items are dropped from the move.
        """
        if not items:
            return
        with self._db.transaction() as uow:
            self._require_live_folder(uow, folder_id)
            folder_items = [item.id for item in items if item.kind == "folder"]
            job_items = [item.id for item in items if item.kind == "job"]
            if len(folder_items) + len(job_items) != len(items):
                raise LibraryError("Items must be folders or jobs")

            folders = uow.folders.list(self._user_id)
            jobs = uow.jobs.list(self._user_id)
            folder_by_id = {folder.id: folder for folder in folders}
            job_by_id = {job.id: job for job in jobs}

            for item_id in folder_items:
                if item_id not in folder_by_id:
                    raise KeyError(f"Unknown folder '{item_id}'")
            for item_id in job_items:
                if item_id not in job_by_id:
                    raise KeyError(f"Unknown job '{item_id}'")
            assert_move_is_acyclic(folders, folder_items, folder_id)

            selected_folders = set(folder_items)
            moved_folder_ids = [
                item_id
                for item_id in folder_items
                if not self._has_selected_ancestor(folder_by_id, item_id, selected_folders)
            ]
            covered_folder_ids: set[str] = set()
            for item_id in moved_folder_ids:
                covered_folder_ids |= descendant_folder_ids(folders, item_id)
            moved_job_ids = [
                item_id
                for item_id in job_items
                if (job_by_id[item_id].folder_id or None) not in covered_folder_ids
            ]

            affected_folders: set[str | None] = {folder_id}
            affected_jobs: set[str | None] = {folder_id}
            for item_id in moved_folder_ids:
                affected_folders.add(folder_by_id[item_id].parent_id)
            for item_id in moved_job_ids:
                affected_jobs.add(job_by_id[item_id].folder_id)

            folder_position = uow.folders.next_position(self._user_id, folder_id)
            for offset, item_id in enumerate(moved_folder_ids):
                folder = folder_by_id[item_id]
                folder.parent_id = folder_id
                folder.position = folder_position + offset
                uow.folders.save(folder)

            job_position = uow.jobs.next_position(self._user_id, folder_id)
            for offset, item_id in enumerate(moved_job_ids):
                job = job_by_id[item_id]
                job.folder_id = folder_id
                job.position = job_position + offset
                uow.jobs.save(job)

            for parent_id in affected_folders:
                self._reindex_folders(uow, parent_id)
            for parent_id in affected_jobs:
                self._reindex_jobs(uow, parent_id)

    def _reindex_folders(self, uow: UnitOfWork, parent_id: str | None) -> None:
        now = time()
        children = sorted(
            (folder for folder in uow.folders.list(self._user_id) if folder.parent_id == parent_id),
            key=lambda folder: (folder.position, folder.name, folder.id),
        )
        for position, folder in enumerate(children):
            if folder.position == position:
                continue
            folder.position = position
            folder.updated_at = now
            uow.folders.save(folder)

    def _reindex_jobs(self, uow: UnitOfWork, folder_id: str | None) -> None:
        now = time()
        children = sorted(
            (job for job in uow.jobs.list(self._user_id) if job.folder_id == folder_id),
            key=lambda job: (job.position, job.submitted_at, job.id),
        )
        for position, job in enumerate(children):
            if job.position == position:
                continue
            job.position = position
            job.updated_at = now
            uow.jobs.save(job)

    # ── trash ───────────────────────────────────────────────────────────────

    def delete(self, items: list[LibraryItem]) -> list[TrashEntry]:
        """Soft-delete each top-level item, grouping folder subtrees."""
        if not items:
            return []
        now = time()
        entries: list[TrashEntry] = []
        with self._db.transaction() as uow:
            folders = uow.folders.list(self._user_id)
            jobs = uow.jobs.list(self._user_id)
            folder_by_id = {folder.id: folder for folder in folders}
            job_by_id = {job.id: job for job in jobs}

            selected_folders = {item.id for item in items if item.kind == "folder"}
            selected_jobs = {item.id for item in items if item.kind == "job"}
            for folder_id in selected_folders:
                if folder_id not in folder_by_id:
                    raise KeyError(f"Unknown folder '{folder_id}'")
            for job_id in selected_jobs:
                if job_id not in job_by_id:
                    raise KeyError(f"Unknown job '{job_id}'")

            # A folder already inside another selected folder comes along with
            # its ancestor; creating a second entry would split the restore.
            top_folders = [
                folder_id
                for folder_id in selected_folders
                if not self._has_selected_ancestor(folder_by_id, folder_id, selected_folders)
            ]
            for job_id in selected_jobs:
                job_folder_id = job_by_id[job_id].folder_id
                folder = folder_by_id.get(job_folder_id) if job_folder_id is not None else None
                # Skip jobs that are covered by a selected ancestor folder.
                current = folder
                nested = False
                while current is not None:
                    if current.id in top_folders:
                        nested = True
                        break
                    parent = current.parent_id
                    current = folder_by_id.get(parent) if parent is not None else None
                if nested:
                    continue
                job = job_by_id[job_id]
                entry = TrashEntry(
                    id=str(uuid4()),
                    user_id=self._user_id,
                    kind=TrashKind.JOB,
                    root_id=job.id,
                    name=job.title or "Untitled job",
                    parent_id=job.folder_id,
                    job_count=1,
                    created_at=now,
                )
                job.deleted_at = now
                job.trash_entry_id = entry.id
                job.updated_at = now
                uow.jobs.save(job)
                uow.trash.add(entry)
                entries.append(entry)

            for folder_id in top_folders:
                folder = folder_by_id[folder_id]
                subtree = descendant_folder_ids(folders, folder_id)
                affected_jobs = [
                    job for job in jobs if job.folder_id in subtree and job.deleted_at is None
                ]
                entry = TrashEntry(
                    id=str(uuid4()),
                    user_id=self._user_id,
                    kind=TrashKind.FOLDER,
                    root_id=folder.id,
                    name=folder.name,
                    parent_id=folder.parent_id,
                    job_count=len(affected_jobs),
                    created_at=now,
                )
                for child in folders:
                    if child.id in subtree and child.deleted_at is None:
                        child.deleted_at = now
                        child.trash_entry_id = entry.id
                        child.updated_at = now
                        uow.folders.save(child)
                for job in affected_jobs:
                    job.deleted_at = now
                    job.trash_entry_id = entry.id
                    job.updated_at = now
                    uow.jobs.save(job)
                uow.trash.add(entry)
                entries.append(entry)
        return entries

    def delete_folder_only(self, folder_id: str) -> TrashEntry:
        """Move the folder's children to its parent, then trash the folder.

        The explicit alternative to "delete folder and contents". Nothing is
        lost: the children stay in the library and the empty folder is
        restorable from the trash.
        """
        now = time()
        with self._db.transaction() as uow:
            folder = self._require_folder(uow, folder_id)
            parent_id = folder.parent_id
            folders = uow.folders.list(self._user_id)
            jobs = uow.jobs.list(self._user_id)

            child_folders = sorted(
                (item for item in folders if item.parent_id == folder_id),
                key=lambda item: (item.position, item.name, item.id),
            )
            folder_position = uow.folders.next_position(self._user_id, parent_id)
            for offset, child in enumerate(child_folders):
                child.parent_id = parent_id
                child.position = folder_position + offset
                child.updated_at = now
                uow.folders.save(child)

            child_jobs = sorted(
                (item for item in jobs if item.folder_id == folder_id),
                key=lambda item: (item.position, item.submitted_at, item.id),
            )
            job_position = uow.jobs.next_position(self._user_id, parent_id)
            for offset, job in enumerate(child_jobs):
                job.folder_id = parent_id
                job.position = job_position + offset
                job.updated_at = now
                uow.jobs.save(job)

            entry = TrashEntry(
                id=str(uuid4()),
                user_id=self._user_id,
                kind=TrashKind.FOLDER,
                root_id=folder.id,
                name=folder.name,
                parent_id=parent_id,
                job_count=0,
                created_at=now,
            )
            folder.deleted_at = now
            folder.trash_entry_id = entry.id
            folder.updated_at = now
            # Save the deletion *before* re-indexing, so the destination order is
            # computed without this folder as a sibling. Relying on the in-memory
            # object being mutated in place would break against a SQL adapter,
            # which only sees the row once it is written.
            uow.folders.save(folder)
            # Dense order at the destination.
            self._reindex_folders(uow, parent_id)
            self._reindex_jobs(uow, parent_id)
            uow.trash.add(entry)
            return entry

    def list_trash(self) -> list[TrashEntry]:
        with self._db.transaction() as uow:
            return uow.trash.list(self._user_id)

    def restore(self, entry_ids: list[str]) -> None:
        """Put trashed entries back where they were.

        Validation happens before any mutation, and every entry in the same
        call is treated as live when resolving a destination. Restoring a
        folder and a separately-trashed child in one request therefore keeps
        the child inside its parent regardless of the order the entries arrive
        in; resolving against the pre-call state used to scatter it to the root
        library.
        """
        if not entry_ids:
            return
        now = time()
        with self._db.transaction() as uow:
            folders = uow.folders.list(self._user_id, include_deleted=True)
            jobs = uow.jobs.list(self._user_id, include_deleted=True)

            entries: list[TrashEntry] = []
            for entry_id in dict.fromkeys(entry_ids):
                entry = uow.trash.get(self._user_id, entry_id)
                if entry is None:
                    raise KeyError(f"Unknown trash entry '{entry_id}'")
                entries.append(entry)

            selected_entry_ids = {entry.id for entry in entries}
            tagged_folders = [
                folder for folder in folders if folder.trash_entry_id in selected_entry_ids
            ]
            tagged_jobs = [job for job in jobs if job.trash_entry_id in selected_entry_ids]
            tagged_folder_ids = {folder.id for folder in tagged_folders}
            tagged_job_ids = {job.id for job in tagged_jobs}
            for entry in entries:
                if entry.kind == TrashKind.FOLDER and entry.root_id not in tagged_folder_ids:
                    raise KeyError(f"Trash entry '{entry.id}' has no folder to restore")
                if entry.kind == TrashKind.JOB and entry.root_id not in tagged_job_ids:
                    raise KeyError(f"Trash entry '{entry.id}' has no job to restore")

            # Folders that will be live by the end of this call, so a child can
            # be restored into a parent that is itself being restored.
            live_folder_ids = {
                folder.id for folder in folders if folder.deleted_at is None
            } | tagged_folder_ids

            # Append to the destination, counting from the current live order
            # and from everything restored earlier in this same call.
            folder_positions: dict[str | None, int] = {}
            for folder in folders:
                if folder.deleted_at is None:
                    folder_positions[folder.parent_id] = max(
                        folder_positions.get(folder.parent_id, 0), folder.position + 1
                    )
            job_positions: dict[str | None, int] = {}
            for job in jobs:
                if job.deleted_at is None:
                    job_positions[job.folder_id] = max(
                        job_positions.get(job.folder_id, 0), job.position + 1
                    )

            affected_folders: set[str | None] = set()
            affected_jobs: set[str | None] = set()
            for entry in entries:
                entry_folders = [
                    folder for folder in tagged_folders if folder.trash_entry_id == entry.id
                ]
                entry_jobs = [job for job in tagged_jobs if job.trash_entry_id == entry.id]

                if entry.kind == TrashKind.FOLDER:
                    root = next(
                        (folder for folder in entry_folders if folder.id == entry.root_id),
                        None,
                    )
                    if root is None:
                        raise KeyError(f"Trash entry '{entry.id}' has no folder to restore")
                    # Put it back where it was; if its parent is gone, the root
                    # library is the only safe destination.
                    target_parent = (
                        entry.parent_id
                        if entry.parent_id is None or entry.parent_id in live_folder_ids
                        else None
                    )
                    root.parent_id = target_parent
                    root.position = folder_positions.get(target_parent, 0)
                    folder_positions[target_parent] = root.position + 1
                    affected_folders.add(target_parent)
                else:
                    job = next(
                        (item for item in entry_jobs if item.id == entry.root_id),
                        None,
                    )
                    if job is None:
                        raise KeyError(f"Trash entry '{entry.id}' has no job to restore")
                    target_folder = (
                        entry.parent_id
                        if entry.parent_id is None or entry.parent_id in live_folder_ids
                        else None
                    )
                    job.folder_id = target_folder
                    job.position = job_positions.get(target_folder, 0)
                    job_positions[target_folder] = job.position + 1
                    affected_jobs.add(target_folder)

                for folder in entry_folders:
                    folder.deleted_at = None
                    folder.trash_entry_id = None
                    folder.updated_at = now
                    uow.folders.save(folder)
                for item in entry_jobs:
                    item.deleted_at = None
                    item.trash_entry_id = None
                    item.updated_at = now
                    uow.jobs.save(item)
                uow.trash.delete(self._user_id, entry.id)

            for parent_id in affected_folders:
                self._reindex_folders(uow, parent_id)
            for folder_id in affected_jobs:
                self._reindex_jobs(uow, folder_id)

    def purge(self, entry_ids: list[str] | None = None) -> list[str]:
        """Permanently delete trashed items. Returns job ids that were removed.

        The caller is responsible for releasing media for those job ids; the
        library only owns rows.
        """
        purged_job_ids: list[str] = []
        with self._db.transaction() as uow:
            entries = uow.trash.list(self._user_id)
            selected = (
                entries
                if entry_ids is None
                else [entry for entry in entries if entry.id in set(entry_ids)]
            )
            if entry_ids is not None:
                missing = set(entry_ids) - {entry.id for entry in selected}
                if missing:
                    raise KeyError(f"Unknown trash entries: {', '.join(sorted(missing))}")
            for entry in selected:
                tagged_jobs = [
                    job
                    for job in uow.jobs.list(self._user_id, include_deleted=True)
                    if job.trash_entry_id == entry.id
                ]
                tagged_folders = [
                    folder
                    for folder in uow.folders.list(self._user_id, include_deleted=True)
                    if folder.trash_entry_id == entry.id
                ]
                for job in tagged_jobs:
                    uow.jobs.delete(self._user_id, job.id)
                    purged_job_ids.append(job.id)
                for folder in tagged_folders:
                    uow.folders.delete(self._user_id, folder.id)
                uow.progress.delete_many(self._user_id, [job.id for job in tagged_jobs])
                uow.trash.delete(self._user_id, entry.id)
        return purged_job_ids

    # ── validation helpers ──────────────────────────────────────────────────

    def _require_folder(self, uow: UnitOfWork, folder_id: str) -> Folder:
        folder = uow.folders.get(self._user_id, folder_id)
        if folder is None:
            raise KeyError(f"Unknown folder '{folder_id}'")
        return folder

    def _require_live_folder(self, uow: UnitOfWork, folder_id: str | None) -> Folder | None:
        if folder_id is None:
            return None
        folder = uow.folders.get(self._user_id, folder_id)
        if folder is None:
            raise KeyError(f"Unknown folder '{folder_id}'")
        return folder

    def _require_live_job(self, uow: UnitOfWork, job_id: str) -> Job:
        job = uow.jobs.get(self._user_id, job_id)
        if job is None:
            raise KeyError(f"Unknown job '{job_id}'")
        return job

    @staticmethod
    def _clean_name(name: str) -> str:
        clean = name.strip()
        if not clean:
            raise LibraryError("Folder name cannot be empty")
        if len(clean) > 120:
            raise LibraryError("Folder name is too long")
        return clean

    @staticmethod
    def _clean_title(title: str) -> str:
        clean = title.strip()
        if not clean:
            raise LibraryError("Title cannot be empty")
        if len(clean) > 200:
            raise LibraryError("Title is too long")
        return clean

    @staticmethod
    def _has_selected_ancestor(
        folders: dict[str, Folder], folder_id: str, selected: set[str]
    ) -> bool:
        current = folders[folder_id].parent_id
        while current is not None:
            if current in selected:
                return True
            parent = folders.get(current)
            if parent is None:
                return False
            current = parent.parent_id
        return False
