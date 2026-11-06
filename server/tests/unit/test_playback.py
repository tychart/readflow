from __future__ import annotations

from app.library.playback import (
    next_job_in_folder,
    ordered_folder_jobs,
    previous_job_in_folder,
    up_next_job_ids,
)
from tests.unit.library_helpers import build_job


def _playing(job, *, seconds: float = 0.0):
    job.is_active_listening = True
    job.playback_state.is_playing = True
    job.contiguous_written_seconds = seconds
    return job


def test_folder_order_and_neighbours():
    jobs = [
        build_job("b", folder_id="f", position=1),
        build_job("a", folder_id="f", position=0),
        build_job("c", folder_id="f", position=2),
        build_job("root"),
    ]
    by_id = {job.id: job for job in jobs}
    assert [job.id for job in ordered_folder_jobs(jobs, "f")] == ["a", "b", "c"]
    following = next_job_in_folder(jobs, by_id["a"])
    assert following is not None and following.id == "b"
    preceding = previous_job_in_folder(jobs, by_id["b"])
    assert preceding is not None and preceding.id == "a"
    assert next_job_in_folder(jobs, by_id["c"]) is None
    assert previous_job_in_folder(jobs, by_id["a"]) is None
    # Root jobs have no folder neighbours.
    assert next_job_in_folder(jobs, by_id["root"]) is None
    assert previous_job_in_folder(jobs, by_id["root"]) is None


def test_up_next_is_the_successor_of_a_playing_job():
    current = _playing(build_job("current", folder_id="f", position=0))
    following = build_job("next", folder_id="f", position=1)
    other = build_job("other", folder_id="g", position=0)
    jobs = [current, following, other]
    assert up_next_job_ids(jobs, prebuffer_seconds=120) == {"next"}
    assert up_next_job_ids(jobs, prebuffer_seconds=0) == set()


def test_up_next_honours_the_prebuffer_target():
    current = _playing(build_job("current", folder_id="f", position=0))
    following = build_job("next", folder_id="f", position=1)
    following.contiguous_written_seconds = 150.0
    assert up_next_job_ids([current, following], prebuffer_seconds=120) == set()
    assert up_next_job_ids([current, following], prebuffer_seconds=200) == {"next"}


def test_paused_or_inactive_jobs_do_not_warm_successors():
    current = _playing(build_job("current", folder_id="f", position=0))
    following = build_job("next", folder_id="f", position=1)
    current.is_active_listening = False
    assert up_next_job_ids([current, following], prebuffer_seconds=120) == set()

    current.is_active_listening = True
    current.playback_state.is_playing = False
    assert up_next_job_ids([current, following], prebuffer_seconds=120) == set()


def test_deleted_jobs_are_ignored_in_ordering_and_warming():
    current = _playing(build_job("current", folder_id="f", position=0))
    hidden = build_job("hidden", folder_id="f", position=1)
    hidden.deleted_at = 1.0
    following = build_job("next", folder_id="f", position=2)
    jobs = [current, hidden, following]
    assert [job.id for job in ordered_folder_jobs(jobs, "f")] == ["current", "next"]
    following_job = next_job_in_folder(jobs, current)
    assert following_job is not None and following_job.id == "next"
    assert up_next_job_ids(jobs, prebuffer_seconds=120) == {"next"}


def test_a_playing_root_job_warms_nothing():
    current = _playing(build_job("root"))
    following = build_job("next", folder_id="f")
    assert up_next_job_ids([current, following], prebuffer_seconds=120) == set()
