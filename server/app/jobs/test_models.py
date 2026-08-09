"""Tests for chunk versioning and reprocessing models."""

from app.jobs.models import (
    ChunkRecord,
    ChunkStatus,
    Job,
    PlannerCursor,
)


class TestChunkStatus:
    """Tests for new ChunkStatus enum values."""

    def test_reprocessing_status_exists(self):
        assert ChunkStatus.REPROCESSING == "reprocessing"

    def test_max_retries_exceeded_status_exists(self):
        assert ChunkStatus.MAX_RETRIES_EXCEEDED == "max_retries_exceeded"

    def test_reprocessing_status_is_valid(self):
        status = ChunkStatus.REPROCESSING
        assert isinstance(status, ChunkStatus)
        assert status.value == "reprocessing"

    def test_max_retries_exceeded_status_is_valid(self):
        status = ChunkStatus.MAX_RETRIES_EXCEEDED
        assert isinstance(status, ChunkStatus)
        assert status.value == "max_retries_exceeded"


class TestChunkRecord:
    """Tests for ChunkRecord versioning fields."""

    def test_chunk_record_default_version_is_zero(self):
        chunk = ChunkRecord(
            job_id="test-job",
            index=0,
            text="Hello world",
            voice_id="suzy",
            plan_version=1,
            char_start=0,
            char_end=11,
        )
        assert chunk.version == 0

    def test_chunk_record_default_deprecated_is_false(self):
        chunk = ChunkRecord(
            job_id="test-job",
            index=0,
            text="Hello world",
            voice_id="suzy",
            plan_version=1,
            char_start=0,
            char_end=11,
        )
        assert chunk.deprecated is False

    def test_chunk_record_default_reprocessing_is_false(self):
        chunk = ChunkRecord(
            job_id="test-job",
            index=0,
            text="Hello world",
            voice_id="suzy",
            plan_version=1,
            char_start=0,
            char_end=11,
        )
        assert chunk.reprocessing is False

    def test_chunk_record_default_parent_chunk_index_is_none(self):
        chunk = ChunkRecord(
            job_id="test-job",
            index=0,
            text="Hello world",
            voice_id="suzy",
            plan_version=1,
            char_start=0,
            char_end=11,
        )
        assert chunk.parent_chunk_index is None

    def test_chunk_record_can_be_created_with_version(self):
        chunk = ChunkRecord(
            job_id="test-job",
            index=0,
            text="Hello world",
            voice_id="suzy",
            plan_version=1,
            char_start=0,
            char_end=11,
            version=2,
            deprecated=False,
            reprocessing=True,
            parent_chunk_index=0,
            status=ChunkStatus.REPROCESSING,
        )
        assert chunk.version == 2
        assert chunk.deprecated is False
        assert chunk.reprocessing is True
        assert chunk.parent_chunk_index == 0
        assert chunk.status == ChunkStatus.REPROCESSING

    def test_chunk_record_can_have_failed_status(self):
        chunk = ChunkRecord(
            job_id="test-job",
            index=0,
            text="Hello world",
            voice_id="suzy",
            plan_version=1,
            char_start=0,
            char_end=11,
            status=ChunkStatus.FAILED,
            error="Synthesis failed",
        )
        assert chunk.status == ChunkStatus.FAILED
        assert chunk.error == "Synthesis failed"

    def test_chunk_record_can_have_max_retries_exceeded_status(self):
        chunk = ChunkRecord(
            job_id="test-job",
            index=0,
            text="Hello world",
            voice_id="suzy",
            plan_version=1,
            char_start=0,
            char_end=11,
            status=ChunkStatus.MAX_RETRIES_EXCEEDED,
            error="Max retries exceeded",
        )
        assert chunk.status == ChunkStatus.MAX_RETRIES_EXCEEDED


class TestJobVersioning:
    """Tests for Job versioning methods."""

    def _create_job_with_chunk(
        self, chunk_index: int, version: int = 0, status: ChunkStatus = ChunkStatus.WRITTEN
    ) -> Job:
        chunk = ChunkRecord(
            job_id="test-job",
            index=chunk_index,
            text=f"Chunk {chunk_index} text",
            voice_id="suzy",
            plan_version=1,
            char_start=chunk_index * 10,
            char_end=(chunk_index + 1) * 10,
            version=version,
            status=status,
        )
        return Job(
            id="test-job",
            title="Test Job",
            source_kind="text",
            source_text="Chunk 0 textChunk 1 text",
            model_id="Qwen/Qwen3-TTS-12Hz-0.6B-Base",
            voice_id="suzy",
            chunks=[chunk],
        )

    def test_get_active_chunk_returns_none_for_unknown_index(self):
        job = self._create_job_with_chunk(0)
        active = job.get_active_chunk(99)
        assert active is None

    def test_get_active_chunk_returns_active_version(self):
        job = self._create_job_with_chunk(0, version=1)
        job.set_active_chunk_version(0, 1)
        active = job.get_active_chunk(0)
        assert active is not None
        assert active.version == 1

    def test_get_active_chunk_returns_none_when_active_version_not_found(self):
        job = self._create_job_with_chunk(0, version=0)
        job.set_active_chunk_version(0, 99)  # Non-existent version
        active = job.get_active_chunk(0)
        assert active is None

    def test_get_latest_chunk_version_returns_zero_for_single_chunk(self):
        job = self._create_job_with_chunk(0, version=0)
        assert job.get_latest_chunk_version(0) == 0

    def test_get_latest_chunk_version_returns_max_version(self):
        job = self._create_job_with_chunk(0, version=3)
        assert job.get_latest_chunk_version(0) == 3

    def test_get_latest_chunk_version_returns_negative_one_for_unknown_index(self):
        job = self._create_job_with_chunk(0)
        assert job.get_latest_chunk_version(99) == -1

    def test_get_latest_chunk_version_across_multiple_chunks(self):
        job = self._create_job_with_chunk(0, version=0)
        chunk1 = ChunkRecord(
            job_id="test-job",
            index=0,
            text="Chunk 0 v2",
            voice_id="suzy",
            plan_version=2,
            char_start=0,
            char_end=10,
            version=2,
            status=ChunkStatus.WRITTEN,
        )
        chunk2 = ChunkRecord(
            job_id="test-job",
            index=0,
            text="Chunk 0 v1",
            voice_id="suzy",
            plan_version=1,
            char_start=0,
            char_end=10,
            version=1,
            status=ChunkStatus.WRITTEN,
        )
        job.chunks.extend([chunk1, chunk2])
        assert job.get_latest_chunk_version(0) == 2

    def test_set_active_chunk_version_sets_version(self):
        job = self._create_job_with_chunk(0)
        job.set_active_chunk_version(0, 5)
        assert job.active_chunk_version[0] == 5

    def test_set_active_chunk_version_updates_timestamp(self):
        job = self._create_job_with_chunk(0)
        job.updated_at = 1000
        job.set_active_chunk_version(0, 1)
        assert job.updated_at != 1000

    def test_mark_all_chunk_versions_deprecated_marks_all(self):
        job = self._create_job_with_chunk(0, version=0)
        chunk_v1 = ChunkRecord(
            job_id="test-job",
            index=0,
            text="Chunk 0 v1",
            voice_id="suzy",
            plan_version=2,
            char_start=0,
            char_end=10,
            version=1,
            status=ChunkStatus.WRITTEN,
        )
        job.chunks.append(chunk_v1)
        assert all(not c.deprecated for c in job.chunks if c.index == 0)
        job.mark_all_chunk_versions_deprecated(0)
        assert all(c.deprecated for c in job.chunks if c.index == 0)

    def test_mark_all_chunk_versions_deprecated_only_affects_target_index(self):
        job = self._create_job_with_chunk(0)
        chunk_index_1 = ChunkRecord(
            job_id="test-job",
            index=1,
            text="Chunk 1",
            voice_id="suzy",
            plan_version=1,
            char_start=10,
            char_end=20,
            version=0,
            status=ChunkStatus.WRITTEN,
        )
        job.chunks.append(chunk_index_1)
        job.mark_all_chunk_versions_deprecated(0)
        assert all(c.deprecated for c in job.chunks if c.index == 0)
        assert not chunk_index_1.deprecated


class TestJobVersionedMethods:
    """Tests for Job versioned chunk tracking methods."""

    def _create_job_with_multiple_versions(self) -> Job:
        chunks = [
            ChunkRecord(
                job_id="test-job",
                index=0,
                text="Chunk 0 v0",
                voice_id="suzy",
                plan_version=1,
                char_start=0,
                char_end=10,
                version=0,
                status=ChunkStatus.WRITTEN,
            ),
            ChunkRecord(
                job_id="test-job",
                index=0,
                text="Chunk 0 v1",
                voice_id="suzy",
                plan_version=2,
                char_start=0,
                char_end=10,
                version=1,
                status=ChunkStatus.WRITTEN,
            ),
            ChunkRecord(
                job_id="test-job",
                index=1,
                text="Chunk 1 v0",
                voice_id="suzy",
                plan_version=1,
                char_start=10,
                char_end=20,
                version=0,
                status=ChunkStatus.QUEUED,
            ),
        ]
        job = Job(
            id="test-job",
            title="Test Job",
            source_kind="text",
            source_text="Chunk 0 textChunk 1 text",
            model_id="Qwen/Qwen3-TTS-12Hz-0.6B-Base",
            voice_id="suzy",
            chunks=chunks,
            active_chunk_version={0: 1, 1: 0},
        )
        return job

    def test_versioned_pending_chunks_returns_pending_active_versions(self):
        job = self._create_job_with_multiple_versions()
        pending = job.versioned_pending_chunks()
        # Only chunk index 1 is pending (queued)
        assert len(pending) == 1
        assert pending[0].index == 1

    def test_versioned_written_chunks_returns_written_active_versions(self):
        job = self._create_job_with_multiple_versions()
        written = job.versioned_written_chunks()
        # Only chunk index 0 is written (active version is v1)
        assert len(written) == 1
        assert written[0].index == 0
        assert written[0].version == 1

    def test_versioned_pending_chunks_includes_reprocessing(self):
        chunks = [
            ChunkRecord(
                job_id="test-job",
                index=0,
                text="Chunk 0 v1",
                voice_id="suzy",
                plan_version=2,
                char_start=0,
                char_end=10,
                version=1,
                status=ChunkStatus.REPROCESSING,
            ),
        ]
        job = Job(
            id="test-job",
            title="Test Job",
            source_kind="text",
            source_text="Chunk 0 text",
            model_id="Qwen/Qwen3-TTS-12Hz-0.6B-Base",
            voice_id="suzy",
            chunks=chunks,
            active_chunk_version={0: 1},
        )
        pending = job.versioned_pending_chunks()
        assert len(pending) == 1
        assert pending[0].status == ChunkStatus.REPROCESSING

    def test_versioned_methods_empty_when_no_active_versions(self):
        job = Job(
            id="test-job",
            title="Test Job",
            source_kind="text",
            source_text="",
            model_id="Qwen/Qwen3-TTS-12Hz-0.6B-Base",
            voice_id="suzy",
            chunks=[],
            active_chunk_version={},
        )
        assert len(job.versioned_pending_chunks()) == 0
        assert len(job.versioned_written_chunks()) == 0


class TestJobCompletion:
    """Tests for version-aware job completion logic."""

    def test_job_not_completed_with_versioned_pending(self):
        """Job should not complete while there are pending versioned chunks."""
        chunks = [
            ChunkRecord(
                job_id="test-job",
                index=0,
                text="Chunk 0",
                voice_id="suzy",
                plan_version=1,
                char_start=0,
                char_end=10,
                version=0,
                status=ChunkStatus.WRITTEN,
            ),
            ChunkRecord(
                job_id="test-job",
                index=1,
                text="Chunk 1",
                voice_id="suzy",
                plan_version=1,
                char_start=10,
                char_end=20,
                version=0,
                status=ChunkStatus.QUEUED,
            ),
        ]
        job = Job(
            id="test-job",
            title="Test Job",
            source_kind="text",
            source_text="Chunk 0Chunk 1",
            model_id="Qwen/Qwen3-TTS-12Hz-0.6B-Base",
            voice_id="suzy",
            chunks=chunks,
            active_chunk_version={0: 0, 1: 0},
            planner_cursor=PlannerCursor(offset=-1),
        )
        # Chunk 0 is written, chunk 1 is queued (pending)
        written = job.versioned_written_chunks()
        pending = job.versioned_pending_chunks()
        assert len(written) == 1
        assert len(pending) == 1
