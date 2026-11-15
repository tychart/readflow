"""Row <-> domain mapping for the Postgres adapter.

Two rules are enforced here and nowhere else:

- **Instants cross the boundary here.** Every `*_at` column is `timestamptz` and
  every domain instant is an epoch float; `to_datetime` / `from_datetime` are the
  only conversion. Durations and positions are plain floats in both directions.
- **JSONB keys are strings, domain keys are ints.** `active_chunk_version` and
  `heard` are `{index: version}` in Python and `{"0": 3}` in JSON, so the
  conversion is explicit in both directions. A missed conversion shows up as a
  lost heard mark, which is exactly the kind of bug a contract test should catch.

`changed_chunks` is the dirty diff: a job's chunk list is append-only, so a save
only needs the rows whose mutable fields actually moved. It is a pure function so
it can be property-tested without a database.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Any, NamedTuple

from app.core.time import from_datetime, to_datetime
from app.db.models import Session, User
from app.jobs.models import (
    ChunkRecord,
    ChunkStatus,
    Job,
    JobStatus,
    JobSummary,
    PlannerCursor,
    PlaybackState,
)
from app.library.models import Folder, JobProgress, TrashEntry, TrashKind

# Fields the scheduler mutates on a chunk after it has been inserted. `index`,
# `version` and `job_id` are the primary key and never change; everything else
# that can move is listed here so the diff cannot miss a column that a new
# feature starts writing.
CHUNK_MUTABLE_FIELDS: tuple[str, ...] = (
    "text",
    "voice_id",
    "language",
    "plan_version",
    "char_start",
    "char_end",
    "status",
    "start_seconds",
    "duration_seconds",
    "segment_path",
    "wav_path",
    "error",
    "parent_chunk_index",
    "deprecated",
    "reprocessing",
    "attempts",
    "updated_at",
)

JOB_COLUMNS: tuple[str, ...] = (
    "id",
    "user_id",
    "title",
    "source_kind",
    "source_char_count",
    "folder_id",
    "position",
    "deleted_at",
    "trash_entry_id",
    "plan_version",
    "audio_epoch",
    "status",
    "is_active_listening",
    "render_to_end",
    "model_id",
    "voice_id",
    "language",
    "submitted_at",
    "updated_at",
    "planner_offset",
    "planner_chunks_emitted",
    "next_chunk_index",
    "active_chunk_version",
    "buffered_seconds",
    "completed_seconds",
    "total_chunks_completed",
    "contiguous_written_seconds",
    "written_seconds",
    "last_written_index",
    "unfinished_chunks",
    "unwritten_chars",
    "pending_chunks",
    "playback_current_time_seconds",
    "playback_is_playing",
    "playback_last_event_at",
    "failed_reason",
)


class ChunkKey(NamedTuple):
    index: int
    version: int


def _optional_instant(value: float | None) -> Any:
    return None if value is None else to_datetime(value)


def _float_or_zero(value: float | None) -> float:
    return 0.0 if value is None else value


# ── users / sessions ────────────────────────────────────────────────────────


def user_row(user: User) -> dict[str, Any]:
    return {
        "id": user.id,
        "username": user.username,
        "display_name": user.display_name,
        "password_hash": user.password_hash,
        "is_admin": user.is_admin,
        "is_active": user.is_active,
        "created_at": to_datetime(user.created_at),
        "preferred_model_id": user.preferred_model_id,
        "preferred_voice_id": user.preferred_voice_id,
    }


def user_from_row(row: Mapping[str, Any]) -> User:
    return User(
        id=row["id"],
        username=row["username"],
        display_name=row["display_name"],
        password_hash=row["password_hash"],
        is_admin=row["is_admin"],
        is_active=row["is_active"],
        created_at=from_datetime(row["created_at"]),
        preferred_model_id=row["preferred_model_id"],
        preferred_voice_id=row["preferred_voice_id"],
    )


def session_row(session: Session) -> dict[str, Any]:
    return {
        "id": session.id,
        "user_id": session.user_id,
        "token_hash": session.token_hash,
        "created_at": to_datetime(session.created_at),
        "last_seen_at": to_datetime(session.last_seen_at),
        "expires_at": to_datetime(session.expires_at),
    }


def session_from_row(row: Mapping[str, Any]) -> Session:
    return Session(
        id=row["id"],
        user_id=row["user_id"],
        token_hash=bytes(row["token_hash"]),
        created_at=from_datetime(row["created_at"]),
        last_seen_at=from_datetime(row["last_seen_at"]),
        expires_at=from_datetime(row["expires_at"]),
    )


# ── folders ─────────────────────────────────────────────────────────────────


def folder_row(folder: Folder) -> dict[str, Any]:
    return {
        "id": folder.id,
        "user_id": folder.user_id,
        "name": folder.name,
        "parent_id": folder.parent_id,
        "position": folder.position,
        "created_at": to_datetime(folder.created_at),
        "updated_at": to_datetime(folder.updated_at),
        "deleted_at": _optional_instant(folder.deleted_at),
        "trash_entry_id": folder.trash_entry_id,
    }


def folder_from_row(row: Mapping[str, Any]) -> Folder:
    return Folder(
        id=row["id"],
        name=row["name"],
        user_id=row["user_id"],
        parent_id=row["parent_id"],
        position=row["position"],
        created_at=from_datetime(row["created_at"]),
        updated_at=from_datetime(row["updated_at"]),
        deleted_at=None if row["deleted_at"] is None else from_datetime(row["deleted_at"]),
        trash_entry_id=row["trash_entry_id"],
    )


# ── jobs ────────────────────────────────────────────────────────────────────


def job_row(job: Job) -> dict[str, Any]:
    return {
        "id": job.id,
        "user_id": job.user_id,
        "title": job.title,
        "source_kind": job.source_kind,
        "source_char_count": job.source_char_count,
        "folder_id": job.folder_id,
        "position": job.position,
        "deleted_at": _optional_instant(job.deleted_at),
        "trash_entry_id": job.trash_entry_id,
        "plan_version": job.plan_version,
        "audio_epoch": job.audio_epoch,
        "status": str(job.status),
        "is_active_listening": job.is_active_listening,
        "render_to_end": job.render_to_end,
        "model_id": job.model_id,
        "voice_id": job.voice_id,
        "language": job.language,
        "submitted_at": to_datetime(job.submitted_at),
        "updated_at": to_datetime(job.updated_at),
        "planner_offset": job.planner_cursor.offset,
        "planner_chunks_emitted": job.planner_cursor.chunks_emitted,
        "next_chunk_index": job.next_chunk_index,
        "active_chunk_version": {
            str(index): version for index, version in job.active_chunk_version.items()
        },
        "buffered_seconds": job.buffered_seconds,
        "completed_seconds": job.completed_seconds,
        "total_chunks_completed": job.total_chunks_completed,
        "contiguous_written_seconds": job.contiguous_written_seconds,
        "written_seconds": job.written_seconds,
        "last_written_index": job.last_written_index,
        "unfinished_chunks": job.unfinished_chunks,
        "unwritten_chars": job.unwritten_chars,
        "pending_chunks": job.pending_chunks,
        "playback_current_time_seconds": job.playback_state.current_time_seconds,
        "playback_is_playing": job.playback_state.is_playing,
        "playback_last_event_at": to_datetime(job.playback_state.last_event_at),
        "failed_reason": job.failed_reason,
    }


def job_from_row(row: Mapping[str, Any], chunks: Sequence[ChunkRecord]) -> Job:
    """Rebuild one aggregate from its job row and its chunk rows."""
    job = Job(
        id=row["id"],
        title=row["title"],
        source_kind=row["source_kind"],
        source_char_count=row["source_char_count"],
        model_id=row["model_id"],
        voice_id=row["voice_id"],
        language=row["language"],
        user_id=row["user_id"],
        folder_id=row["folder_id"],
        position=row["position"],
        deleted_at=None if row["deleted_at"] is None else from_datetime(row["deleted_at"]),
        trash_entry_id=row["trash_entry_id"],
        plan_version=row["plan_version"],
        audio_epoch=row["audio_epoch"],
        status=JobStatus(row["status"]),
        is_active_listening=row["is_active_listening"],
        render_to_end=row["render_to_end"],
        submitted_at=from_datetime(row["submitted_at"]),
        updated_at=from_datetime(row["updated_at"]),
        planner_cursor=PlannerCursor(
            offset=row["planner_offset"],
            chunks_emitted=row["planner_chunks_emitted"],
        ),
        next_chunk_index=row["next_chunk_index"],
        active_chunk_version={
            int(index): int(version)
            for index, version in (row["active_chunk_version"] or {}).items()
        },
        buffered_seconds=_float_or_zero(row["buffered_seconds"]),
        completed_seconds=_float_or_zero(row["completed_seconds"]),
        total_chunks_completed=row["total_chunks_completed"],
        contiguous_written_seconds=_float_or_zero(row["contiguous_written_seconds"]),
        written_seconds=_float_or_zero(row["written_seconds"]),
        last_written_index=row["last_written_index"],
        unfinished_chunks=row["unfinished_chunks"],
        unwritten_chars=row["unwritten_chars"],
        pending_chunks=row["pending_chunks"],
        playback_state=PlaybackState(
            current_time_seconds=_float_or_zero(row["playback_current_time_seconds"]),
            is_playing=row["playback_is_playing"],
            last_event_at=from_datetime(row["playback_last_event_at"]),
        ),
        failed_reason=row["failed_reason"],
    )
    job.chunks = list(chunks)
    return job


def job_summary_from_row(row: Mapping[str, Any]) -> JobSummary:
    """One flat read-model row: no chunk list, no source text."""
    return JobSummary(
        id=row["id"],
        title=row["title"],
        status=JobStatus(row["status"]),
        voice_id=row["voice_id"],
        model_id=row["model_id"],
        language=row["language"],
        user_id=row["user_id"],
        folder_id=row["folder_id"],
        position=row["position"],
        deleted_at=None if row["deleted_at"] is None else from_datetime(row["deleted_at"]),
        trash_entry_id=row["trash_entry_id"],
        plan_version=row["plan_version"],
        audio_epoch=row["audio_epoch"],
        is_active_listening=row["is_active_listening"],
        render_to_end=row["render_to_end"],
        submitted_at=from_datetime(row["submitted_at"]),
        updated_at=from_datetime(row["updated_at"]),
        planner_cursor=PlannerCursor(
            offset=row["planner_offset"], chunks_emitted=row["planner_chunks_emitted"]
        ),
        next_chunk_index=row["next_chunk_index"],
        active_chunk_version={
            int(index): int(version)
            for index, version in (row["active_chunk_version"] or {}).items()
        },
        buffered_seconds=_float_or_zero(row["buffered_seconds"]),
        completed_seconds=_float_or_zero(row["completed_seconds"]),
        total_chunks_completed=row["total_chunks_completed"],
        contiguous_written_seconds=_float_or_zero(row["contiguous_written_seconds"]),
        written_seconds=_float_or_zero(row["written_seconds"]),
        last_written_index=row["last_written_index"],
        unfinished_chunks=row["unfinished_chunks"],
        unwritten_chars=row["unwritten_chars"],
        pending_chunks=row["pending_chunks"],
        source_char_count=row["source_char_count"],
        playback_state=PlaybackState(
            current_time_seconds=_float_or_zero(row["playback_current_time_seconds"]),
            is_playing=row["playback_is_playing"],
            last_event_at=from_datetime(row["playback_last_event_at"]),
        ),
        failed_reason=row["failed_reason"],
    )


# ── chunks ──────────────────────────────────────────────────────────────────


def chunk_row(chunk: ChunkRecord) -> dict[str, Any]:
    return {
        "job_id": chunk.job_id,
        "index": chunk.index,
        "version": chunk.version,
        "text": chunk.text,
        "voice_id": chunk.voice_id,
        "language": chunk.language,
        "plan_version": chunk.plan_version,
        "char_start": chunk.char_start,
        "char_end": chunk.char_end,
        "status": str(chunk.status),
        "start_seconds": chunk.start_seconds,
        "duration_seconds": chunk.duration_seconds,
        "segment_path": chunk.segment_path,
        "wav_path": chunk.wav_path,
        "error": chunk.error,
        "parent_chunk_index": chunk.parent_chunk_index,
        "deprecated": chunk.deprecated,
        "reprocessing": chunk.reprocessing,
        "attempts": chunk.attempts,
        "created_at": to_datetime(chunk.created_at),
        "updated_at": to_datetime(chunk.updated_at),
    }


def chunk_from_row(row: Mapping[str, Any]) -> ChunkRecord:
    return ChunkRecord(
        job_id=row["job_id"],
        index=row["index"],
        text=row["text"],
        voice_id=row["voice_id"],
        language=row["language"],
        plan_version=row["plan_version"],
        char_start=row["char_start"],
        char_end=row["char_end"],
        version=row["version"],
        status=ChunkStatus(row["status"]),
        start_seconds=_float_or_zero(row["start_seconds"]),
        duration_seconds=_float_or_zero(row["duration_seconds"]),
        segment_path=row["segment_path"],
        wav_path=row["wav_path"],
        error=row["error"],
        parent_chunk_index=row["parent_chunk_index"],
        deprecated=row["deprecated"],
        reprocessing=row["reprocessing"],
        attempts=row["attempts"],
        created_at=from_datetime(row["created_at"]),
        updated_at=from_datetime(row["updated_at"]),
    )


def chunk_snapshot(chunk: ChunkRecord) -> tuple[Any, ...]:
    """The mutable state of one chunk, for the dirty diff."""
    return tuple(getattr(chunk, name) for name in CHUNK_MUTABLE_FIELDS)


def chunk_snapshots(chunks: Sequence[ChunkRecord]) -> dict[ChunkKey, tuple[Any, ...]]:
    return {ChunkKey(chunk.index, chunk.version): chunk_snapshot(chunk) for chunk in chunks}


def changed_chunks(
    snapshots: Mapping[ChunkKey, tuple[Any, ...]], chunks: Sequence[ChunkRecord]
) -> tuple[list[ChunkRecord], list[ChunkRecord]]:
    """Split a job's chunks into (rows to update, rows to insert).

    Chunks are append-only, so the only operations are "changed" and "new".
    Superseded takes are never deleted — they stay as history for the queue
    inspector and for switching a take back.
    """
    updates: list[ChunkRecord] = []
    inserts: list[ChunkRecord] = []
    for chunk in chunks:
        key = ChunkKey(chunk.index, chunk.version)
        previous = snapshots.get(key)
        if previous is None:
            inserts.append(chunk)
        elif previous != chunk_snapshot(chunk):
            updates.append(chunk)
    return updates, inserts


# ── progress / trash ────────────────────────────────────────────────────────


def progress_row(progress: JobProgress) -> dict[str, Any]:
    return {
        "user_id": progress.user_id,
        "job_id": progress.job_id,
        "position_seconds": progress.position_seconds,
        "audio_epoch": progress.audio_epoch,
        "heard": {str(index): version for index, version in progress.heard.items()},
        "heard_seconds": progress.heard_seconds,
        "updated_at": to_datetime(progress.updated_at),
    }


def progress_from_row(row: Mapping[str, Any]) -> JobProgress:
    return JobProgress(
        user_id=row["user_id"],
        job_id=row["job_id"],
        position_seconds=_float_or_zero(row["position_seconds"]),
        audio_epoch=row["audio_epoch"],
        heard={int(index): int(version) for index, version in (row["heard"] or {}).items()},
        heard_seconds=_float_or_zero(row["heard_seconds"]),
        updated_at=from_datetime(row["updated_at"]),
    )


def trash_row(entry: TrashEntry) -> dict[str, Any]:
    return {
        "id": entry.id,
        "user_id": entry.user_id,
        "kind": str(entry.kind),
        "root_id": entry.root_id,
        "name": entry.name,
        "parent_id": entry.parent_id,
        "job_count": entry.job_count,
        "created_at": to_datetime(entry.created_at),
    }


def trash_from_row(row: Mapping[str, Any]) -> TrashEntry:
    return TrashEntry(
        id=row["id"],
        user_id=row["user_id"],
        kind=TrashKind(row["kind"]),
        root_id=row["root_id"],
        name=row["name"],
        parent_id=row["parent_id"],
        job_count=row["job_count"],
        created_at=from_datetime(row["created_at"]),
    )
