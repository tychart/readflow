"""Folder-aware priority: warm the next job a listener is about to reach."""

from __future__ import annotations

from app.jobs.models import JobStatus


def _job(services, title: str, *, folder_id: str | None, voice_id: str = "suzy"):
    return services.job_manager.create_job(
        source_text=f"{title} text with enough words to plan a chunk. " * 8,
        source_kind="text",
        model_id=services.settings.runtime.default_model_id,
        voice_id=voice_id,
        title=title,
        folder_id=folder_id,
    )


def test_the_next_job_in_a_playing_folder_is_warmed(services):
    folder = services.library.create_folder("Books")
    current = _job(services, "Current", folder_id=folder.id)
    following = _job(services, "Following", folder_id=folder.id)
    background = _job(services, "Background", folder_id=None)

    services.job_manager.activate_job(current.id)
    services.scheduler._refresh_up_next()

    following_job = services.job_manager.get_job(following.id)
    background_job = services.job_manager.get_job(background.id)
    assert services.scheduler._priority_band(following_job) == 1
    assert services.scheduler._priority_band(background_job) == 2


def test_warming_stops_once_the_next_job_has_its_prebuffer(services):
    folder = services.library.create_folder("Books")
    current = _job(services, "Current", folder_id=folder.id)
    following = _job(services, "Following", folder_id=folder.id)
    services.job_manager.activate_job(current.id)

    following_job = services.job_manager.get_job(following.id)
    following_job.contiguous_written_seconds = (
        services.settings.runtime.up_next_prebuffer_seconds + 1
    )

    services.scheduler._refresh_up_next()
    assert services.scheduler._priority_band(following_job) == 2


def test_warming_can_be_disabled_with_zero(services):
    folder = services.library.create_folder("Books")
    current = _job(services, "Current", folder_id=folder.id)
    following = _job(services, "Following", folder_id=folder.id)
    services.job_manager.activate_job(current.id)
    services.settings.runtime.up_next_prebuffer_seconds = 0

    services.scheduler._refresh_up_next()

    assert services.scheduler._priority_band(services.job_manager.get_job(following.id)) == 2


def test_a_paused_job_does_not_warm_its_successor(services):
    folder = services.library.create_folder("Books")
    current = _job(services, "Current", folder_id=folder.id)
    following = _job(services, "Following", folder_id=folder.id)
    services.job_manager.activate_job(current.id)
    services.job_manager.pause_job(current.id)

    services.scheduler._refresh_up_next()

    assert services.scheduler._priority_band(services.job_manager.get_job(following.id)) == 2


def test_the_last_job_and_root_jobs_have_nothing_to_warm(services):
    folder = services.library.create_folder("Books")
    only = _job(services, "Only", folder_id=folder.id)
    root = _job(services, "Root", folder_id=None)
    services.job_manager.activate_job(only.id)
    services.job_manager.activate_job(root.id)

    services.scheduler._refresh_up_next()

    assert services.scheduler._refresh_up_next() is None
    assert services.scheduler._up_next_job_ids == set()


def test_priority_info_labels_an_up_next_job(services):
    folder = services.library.create_folder("Books")
    current = _job(services, "Current", folder_id=folder.id)
    following = _job(services, "Following", folder_id=folder.id)
    services.job_manager.activate_job(current.id)
    services.scheduler._refresh_up_next()

    services.scheduler._ensure_planned_chunks()
    following_job = services.job_manager.get_job(following.id)
    chunk = next(
        chunk for chunk in services.job_manager.renderable_chunks() if chunk.job_id == following.id
    )
    band, label, reason = services.scheduler._priority_info(following_job, chunk)
    assert band == 1
    assert label == "Up next"
    assert "warming" in reason


def test_an_active_listener_keeps_its_urgent_band(services):
    """The clamp must never promote the warm job above the job being heard."""
    folder = services.library.create_folder("Books")
    current = _job(services, "Current", folder_id=folder.id)
    _job(services, "Following", folder_id=folder.id)
    services.job_manager.activate_job(current.id)
    services.scheduler._refresh_up_next()

    current_job = services.job_manager.get_job(current.id)
    current_job.buffered_seconds = 0.0
    assert services.scheduler._priority_band(current_job) == 0
    assert current_job.status == JobStatus.PLAYING


def test_a_finished_job_still_warms_its_folder_successor(services):
    """A completed book is played from local audio; the listener is still live.

    Warming used to require `playback_state.is_playing`, which a terminal job
    never reports, so the "finished book, next book is still rendering" case
    never warmed the thing the listener is about to reach.
    """
    folder = services.library.create_folder("Books")
    current = _job(services, "Current", folder_id=folder.id)
    following = _job(services, "Following", folder_id=folder.id)

    with services.database.transaction() as uow:
        stored = uow.jobs.get("local", current.id)
        assert stored is not None
        stored.status = JobStatus.COMPLETED
        uow.jobs.save(stored)

    services.job_manager.activate_job(current.id)
    services.scheduler._refresh_up_next()

    successor = services.job_manager.get_job(following.id)
    assert services.scheduler._priority_band(successor) == 1
    assert services.job_manager.get_job(current.id).status == JobStatus.COMPLETED


def test_a_finished_job_stops_warming_when_the_listener_pauses(services):
    folder = services.library.create_folder("Books")
    current = _job(services, "Current", folder_id=folder.id)
    following = _job(services, "Following", folder_id=folder.id)

    with services.database.transaction() as uow:
        stored = uow.jobs.get("local", current.id)
        assert stored is not None
        stored.status = JobStatus.COMPLETED
        uow.jobs.save(stored)

    services.job_manager.activate_job(current.id)
    services.job_manager.pause_job(current.id)
    services.scheduler._refresh_up_next()

    assert services.scheduler._priority_band(services.job_manager.get_job(following.id)) == 2
