"""Pure tree and ordering helpers for the library.

Everything here is a function over plain lists so the rules that are easy to get
wrong (ordering, cycle prevention, subtree collection) are unit-tested without a
database or a service.
"""

from __future__ import annotations

from collections.abc import Iterable, Sequence
from dataclasses import dataclass

from app.jobs.models import Job
from app.library.models import Folder


@dataclass(frozen=True, slots=True)
class LibraryItem:
    """A reference to a folder or a job, as sent by a bulk action."""

    kind: str  # "folder" | "job"
    id: str


class LibraryError(ValueError):
    """A rejected library mutation (bad parent, cycle, unknown item)."""


def folder_children(folders: Iterable[Folder], parent_id: str | None) -> list[Folder]:
    """Direct, live child folders in manual order."""
    return sorted(
        (
            folder
            for folder in folders
            if folder.parent_id == parent_id and folder.deleted_at is None
        ),
        key=lambda folder: (folder.position, folder.name, folder.id),
    )


def job_children(jobs: Iterable[Job], folder_id: str | None) -> list[Job]:
    """Direct, live jobs in manual order."""
    return sorted(
        (job for job in jobs if job.folder_id == folder_id and job.deleted_at is None),
        key=lambda job: (job.position, job.submitted_at, job.id),
    )


def folder_path(folders: Iterable[Folder], folder_id: str | None) -> list[Folder]:
    """Root-to-folder chain, or [] for the root library."""
    by_id = {folder.id: folder for folder in folders}
    chain: list[Folder] = []
    seen: set[str] = set()
    current = folder_id
    while current is not None:
        folder = by_id.get(current)
        if folder is None or folder.id in seen:
            break
        seen.add(folder.id)
        chain.append(folder)
        current = folder.parent_id
    chain.reverse()
    return chain


def descendant_folder_ids(folders: Iterable[Folder], root_id: str) -> set[str]:
    """`root_id` plus every folder below it (deleted ones included)."""
    children_by_parent: dict[str | None, list[str]] = {}
    for folder in folders:
        children_by_parent.setdefault(folder.parent_id, []).append(folder.id)
    found: set[str] = set()
    stack = [root_id]
    while stack:
        current = stack.pop()
        if current in found:
            continue
        found.add(current)
        stack.extend(children_by_parent.get(current, []))
    return found


def assert_move_is_acyclic(
    folders: Iterable[Folder], folder_ids: Sequence[str], new_parent_id: str | None
) -> None:
    """Reject moving a folder into itself or one of its own descendants."""
    if new_parent_id is None:
        return
    folders = list(folders)
    for folder_id in folder_ids:
        if new_parent_id == folder_id or new_parent_id in descendant_folder_ids(folders, folder_id):
            raise LibraryError(f"Cannot move folder '{folder_id}' inside itself")


def normalize_order(current_ids: Sequence[str], requested_ids: Sequence[str]) -> list[str]:
    """Validate that a reorder covers exactly the current children.

    A drag-and-drop result is only meaningful for the exact set of children the
    client saw. Anything else (a stale list, a dropped id) is rejected instead of
    silently producing a half-applied order.
    """
    current = list(current_ids)
    requested = list(requested_ids)
    if len(requested) != len(set(requested)):
        raise LibraryError("Reorder list contains duplicates")
    if set(requested) != set(current):
        raise LibraryError(
            "Reorder list does not match the folder's current children; reload and try again"
        )
    return requested


def next_position(positions: Iterable[int]) -> int:
    """Append at the end of a manual order."""
    return max(positions, default=-1) + 1


def subtree_counts(
    folders: Sequence[Folder],
    jobs: Sequence[Job],
    folders_by_parent: dict[str | None, list[Folder]] | None = None,
) -> dict[str, int]:
    """Recursive live job count for every folder (including nested folders)."""
    index = folders_by_parent or _group_folders(folders)
    counts: dict[str, int] = {}

    def count(folder_id: str, seen: set[str]) -> int:
        if folder_id in counts:
            return counts[folder_id]
        if folder_id in seen:
            return 0
        seen.add(folder_id)
        total = sum(1 for job in jobs if job.folder_id == folder_id and job.deleted_at is None)
        for child in index.get(folder_id, []):
            if child.deleted_at is None:
                total += count(child.id, seen)
        counts[folder_id] = total
        return total

    for folder in folders:
        if folder.deleted_at is None:
            count(folder.id, set())
    return counts


def _group_folders(folders: Iterable[Folder]) -> dict[str | None, list[Folder]]:
    grouped: dict[str | None, list[Folder]] = {}
    for folder in folders:
        grouped.setdefault(folder.parent_id, []).append(folder)
    return grouped
