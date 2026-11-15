"""SQLAlchemy Core metadata: the single source of truth for the schema.

No ORM. These are table definitions only: the Postgres adapter issues Core
statements against them, and Alembic autogenerates revisions from this metadata,
so a column added here and nowhere else still reaches a real database.

Two type rules, and they are not stylistic:

- **Instants are `timestamptz`.** Every `*_at` / `deleted_at` / `expires_at`
  column. The adapter opens connections with `options=-c timezone=UTC`, so
  Postgres stores UTC and `psql`/`pg_dump` read UTC no matter the host's zone.
- **Durations and positions are `double precision`.** `duration_seconds`,
  `start_seconds`, `position_seconds`, `buffered_seconds`,
  `completed_seconds`, `contiguous_written_seconds`, `written_seconds`,
  `heard_seconds`. Never a timestamp, never `numeric` (a float round trip must
  not start rounding).

The canonical source text lives in `job_sources`, one row per job, so listing
jobs never materialises a book. `active_chunk_version` and `heard` are JSONB
with **integer keys in the domain and string keys in JSON**; the adapter
converts in both directions.
"""

from __future__ import annotations

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

metadata = sa.MetaData()

TIMESTAMP = sa.DateTime(timezone=True)


users = sa.Table(
    "users",
    metadata,
    sa.Column("id", sa.Text, primary_key=True),
    # Login handle. Unique and compared case-insensitively by the auth service
    # (stored lower-cased), so two accounts cannot differ only by case.
    sa.Column("username", sa.Text, nullable=False, unique=True),
    sa.Column("display_name", sa.Text, nullable=False),
    sa.Column("password_hash", sa.Text, nullable=False),
    sa.Column("is_admin", sa.Boolean, nullable=False, server_default=sa.false()),
    sa.Column("is_active", sa.Boolean, nullable=False, server_default=sa.true()),
    sa.Column("created_at", TIMESTAMP, nullable=False),
    sa.Column("preferred_model_id", sa.Text, nullable=True),
    sa.Column("preferred_voice_id", sa.Text, nullable=True),
)

sessions = sa.Table(
    "sessions",
    metadata,
    sa.Column("id", sa.Text, primary_key=True),
    sa.Column(
        "user_id",
        sa.Text,
        sa.ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
    ),
    # sha256(token): a database read cannot be replayed as a login.
    sa.Column("token_hash", sa.LargeBinary, nullable=False, unique=True),
    sa.Column("created_at", TIMESTAMP, nullable=False),
    sa.Column("last_seen_at", TIMESTAMP, nullable=False),
    sa.Column("expires_at", TIMESTAMP, nullable=False),
)
sa.Index("sessions_user_id_idx", sessions.c.user_id)

folders = sa.Table(
    "folders",
    metadata,
    sa.Column("id", sa.Text, primary_key=True),
    sa.Column("user_id", sa.Text, nullable=False),
    sa.Column("name", sa.Text, nullable=False),
    # `ondelete="RESTRICT"` on purpose: moving and trash semantics are service
    # decisions, not cascade accidents.
    sa.Column(
        "parent_id",
        sa.Text,
        sa.ForeignKey("folders.id", ondelete="RESTRICT"),
        nullable=True,
    ),
    sa.Column("position", sa.Integer, nullable=False),
    sa.Column("created_at", TIMESTAMP, nullable=False),
    sa.Column("updated_at", TIMESTAMP, nullable=False),
    sa.Column("deleted_at", TIMESTAMP, nullable=True),
    sa.Column("trash_entry_id", sa.Text, nullable=True),
)
sa.Index(
    "folders_user_live_idx",
    folders.c.user_id,
    folders.c.deleted_at,
    folders.c.parent_id,
    folders.c.position,
)

jobs = sa.Table(
    "jobs",
    metadata,
    sa.Column("id", sa.Text, primary_key=True),
    # Users are disabled, never deleted, so this cascade is a safety net rather
    # than a supported workflow.
    sa.Column(
        "user_id",
        sa.Text,
        sa.ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
    ),
    sa.Column("title", sa.Text, nullable=True),
    sa.Column("source_kind", sa.Text, nullable=False),
    # Length of the canonical text in `job_sources`; every derived number works
    # from this instead of loading the text.
    sa.Column("source_char_count", sa.Integer, nullable=False),
    sa.Column(
        "folder_id",
        sa.Text,
        sa.ForeignKey("folders.id", ondelete="RESTRICT"),
        nullable=True,
    ),
    sa.Column("position", sa.Integer, nullable=False),
    sa.Column("deleted_at", TIMESTAMP, nullable=True),
    sa.Column("trash_entry_id", sa.Text, nullable=True),
    sa.Column("plan_version", sa.Integer, nullable=False),
    sa.Column("audio_epoch", sa.Integer, nullable=False),
    sa.Column("status", sa.Text, nullable=False),
    sa.Column("is_active_listening", sa.Boolean, nullable=False),
    sa.Column("render_to_end", sa.Boolean, nullable=False),
    sa.Column("model_id", sa.Text, nullable=False),
    sa.Column("voice_id", sa.Text, nullable=False),
    sa.Column("language", sa.Text, nullable=False),
    sa.Column("submitted_at", TIMESTAMP, nullable=False),
    sa.Column("updated_at", TIMESTAMP, nullable=False),
    # Planner cursor, stored as two columns so `exhausted` (offset < 0) survives.
    sa.Column("planner_offset", sa.Integer, nullable=False),
    sa.Column("planner_chunks_emitted", sa.Integer, nullable=False),
    sa.Column("next_chunk_index", sa.Integer, nullable=False),
    sa.Column(
        "active_chunk_version",
        postgresql.JSONB,
        nullable=False,
        server_default=sa.text("'{}'::jsonb"),
    ),
    # Rollups: single writer is JobManager._refresh_derived.
    sa.Column("buffered_seconds", sa.Float(53), nullable=False),
    sa.Column("completed_seconds", sa.Float(53), nullable=False),
    sa.Column("total_chunks_completed", sa.Integer, nullable=False),
    sa.Column("contiguous_written_seconds", sa.Float(53), nullable=False),
    sa.Column("written_seconds", sa.Float(53), nullable=False),
    sa.Column("last_written_index", sa.Integer, nullable=True),
    sa.Column("unfinished_chunks", sa.Integer, nullable=False),
    sa.Column("unwritten_chars", sa.Integer, nullable=False),
    sa.Column("pending_chunks", sa.Integer, nullable=False),
    # PlaybackState, flattened. `playback_last_event_at` is an instant.
    sa.Column("playback_current_time_seconds", sa.Float(53), nullable=False),
    sa.Column("playback_is_playing", sa.Boolean, nullable=False),
    sa.Column("playback_last_event_at", TIMESTAMP, nullable=False),
    sa.Column("failed_reason", sa.Text, nullable=True),
)
sa.Index(
    "jobs_user_live_idx",
    jobs.c.user_id,
    jobs.c.deleted_at,
    jobs.c.folder_id,
    jobs.c.position,
)
sa.Index("jobs_user_submitted_idx", jobs.c.user_id, jobs.c.submitted_at.desc())

job_sources = sa.Table(
    "job_sources",
    metadata,
    sa.Column(
        "job_id",
        sa.Text,
        sa.ForeignKey("jobs.id", ondelete="CASCADE"),
        primary_key=True,
    ),
    sa.Column("text", sa.Text, nullable=False),
)

chunks = sa.Table(
    "chunks",
    metadata,
    sa.Column(
        "job_id",
        sa.Text,
        sa.ForeignKey("jobs.id", ondelete="CASCADE"),
        nullable=False,
    ),
    sa.Column("index", sa.Integer, nullable=False),
    sa.Column("version", sa.Integer, nullable=False),
    sa.Column("text", sa.Text, nullable=False),
    sa.Column("voice_id", sa.Text, nullable=False),
    sa.Column("language", sa.Text, nullable=False),
    sa.Column("plan_version", sa.Integer, nullable=False),
    sa.Column("char_start", sa.Integer, nullable=False),
    sa.Column("char_end", sa.Integer, nullable=False),
    sa.Column("status", sa.Text, nullable=False),
    sa.Column("start_seconds", sa.Float(53), nullable=False),
    sa.Column("duration_seconds", sa.Float(53), nullable=False),
    sa.Column("segment_path", sa.Text, nullable=True),
    sa.Column("wav_path", sa.Text, nullable=True),
    sa.Column("error", sa.Text, nullable=True),
    sa.Column("parent_chunk_index", sa.Integer, nullable=True),
    sa.Column("deprecated", sa.Boolean, nullable=False),
    sa.Column("reprocessing", sa.Boolean, nullable=False),
    sa.Column("attempts", sa.Integer, nullable=False),
    sa.Column("created_at", TIMESTAMP, nullable=False),
    sa.Column("updated_at", TIMESTAMP, nullable=False),
    sa.PrimaryKeyConstraint("job_id", "index", "version"),
)
sa.Index("chunks_job_idx", chunks.c.job_id, chunks.c.index)
# Partial indexes for the two scheduler reads that must not scan a book.
sa.Index("chunks_planned_idx", chunks.c.status, postgresql_where=chunks.c.status == "planned")
sa.Index("chunks_rendering_idx", chunks.c.status, postgresql_where=chunks.c.status == "rendering")

job_progress = sa.Table(
    "job_progress",
    metadata,
    sa.Column(
        "user_id",
        sa.Text,
        sa.ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
    ),
    sa.Column(
        "job_id",
        sa.Text,
        sa.ForeignKey("jobs.id", ondelete="CASCADE"),
        nullable=False,
    ),
    sa.Column("position_seconds", sa.Float(53), nullable=False),
    sa.Column("audio_epoch", sa.Integer, nullable=False),
    sa.Column(
        "heard",
        postgresql.JSONB,
        nullable=False,
        server_default=sa.text("'{}'::jsonb"),
    ),
    sa.Column("heard_seconds", sa.Float(53), nullable=False),
    sa.Column("updated_at", TIMESTAMP, nullable=False),
    sa.PrimaryKeyConstraint("user_id", "job_id"),
)

trash_entries = sa.Table(
    "trash_entries",
    metadata,
    sa.Column("id", sa.Text, primary_key=True),
    sa.Column("user_id", sa.Text, nullable=False),
    sa.Column("kind", sa.Text, nullable=False),
    sa.Column("root_id", sa.Text, nullable=False),
    sa.Column("name", sa.Text, nullable=False),
    sa.Column("parent_id", sa.Text, nullable=True),
    sa.Column("job_count", sa.Integer, nullable=False),
    sa.Column("created_at", TIMESTAMP, nullable=False),
)
sa.Index("trash_user_idx", trash_entries.c.user_id, trash_entries.c.created_at.desc())
