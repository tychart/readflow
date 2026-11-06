from __future__ import annotations

import pytest

from app.library.tree import (
    LibraryError,
    assert_move_is_acyclic,
    descendant_folder_ids,
    folder_children,
    folder_path,
    job_children,
    next_position,
    normalize_order,
    subtree_counts,
)
from tests.unit.library_helpers import build_folder, build_job


def test_children_are_deleted_filtered_and_position_ordered():
    folders = [
        build_folder("b", position=1),
        build_folder("a", position=0),
        build_folder("nested", parent_id="a"),
    ]
    hid = build_folder("hidden", position=0)
    hid.deleted_at = 1.0
    folders.append(hid)

    assert [folder.id for folder in folder_children(folders, None)] == ["a", "b"]
    assert [folder.id for folder in folder_children(folders, "a")] == ["nested"]

    jobs = [
        build_job("second", position=1),
        build_job("first", position=0),
    ]
    deleted = build_job("gone", position=2)
    deleted.deleted_at = 1.0
    jobs.append(deleted)

    assert [job.id for job in job_children(jobs, None)] == ["first", "second"]
    assert job_children(jobs, "a") == []


def test_folder_path_is_root_to_folder():
    folders = [
        build_folder("top"),
        build_folder("mid", parent_id="top"),
        build_folder("leaf", parent_id="mid"),
    ]
    assert [folder.id for folder in folder_path(folders, "leaf")] == [
        "top",
        "mid",
        "leaf",
    ]
    assert folder_path(folders, None) == []
    # A dangling parent must not loop forever.
    assert [folder.id for folder in folder_path(folders, "missing")] == []


def test_descendants_include_root_and_nested_folders():
    folders = [
        build_folder("a"),
        build_folder("b", parent_id="a"),
        build_folder("c", parent_id="b"),
        build_folder("other"),
    ]
    assert descendant_folder_ids(folders, "a") == {"a", "b", "c"}


def test_move_cycle_is_rejected():
    folders = [build_folder("a"), build_folder("b", parent_id="a")]
    assert_move_is_acyclic(folders, ["b"], None)
    assert_move_is_acyclic(folders, ["b"], "a")
    with pytest.raises(LibraryError):
        assert_move_is_acyclic(folders, ["a"], "a")
    with pytest.raises(LibraryError):
        assert_move_is_acyclic(folders, ["a"], "b")


def test_normalize_order_requires_exactly_the_current_children():
    assert normalize_order(["a", "b"], ["b", "a"]) == ["b", "a"]
    with pytest.raises(LibraryError):
        normalize_order(["a", "b"], ["a"])
    with pytest.raises(LibraryError):
        normalize_order(["a", "b"], ["a", "c"])
    with pytest.raises(LibraryError):
        normalize_order(["a", "b"], ["a", "a"])


def test_next_position_appends_after_the_current_max():
    assert next_position([]) == 0
    assert next_position([0, 4, 1]) == 5


def test_subtree_counts_are_recursive_and_ignore_deleted():
    folders = [
        build_folder("a"),
        build_folder("b", parent_id="a"),
        build_folder("hidden", parent_id="a"),
    ]
    folders[2].deleted_at = 1.0
    jobs = [
        build_job("j1", folder_id="a"),
        build_job("j2", folder_id="b"),
        build_job("deleted", folder_id="b"),
    ]
    jobs[2].deleted_at = 1.0

    counts = subtree_counts(folders, jobs)
    assert counts["a"] == 2
    assert counts["b"] == 1
    assert "hidden" not in counts


def test_job_children_break_position_ties_by_submission_time():
    jobs = [
        build_job("later", position=0, submitted_at=20.0),
        build_job("earlier", position=0, submitted_at=10.0),
    ]
    assert [job.id for job in job_children(jobs, None)] == ["earlier", "later"]
