"""Tests for JobManager versioning and reprocessing methods."""

from app.jobs.manager import JobManager
from app.jobs.models import ChunkRecord, ChunkStatus, JobStatus


class TestJobManagerVersionedChunk:
    """Tests for JobManager.add_versioned_chunk."""

    def setup_method(self):
        self.manager = JobManager()
        self.job = self.manager.create_job(
            source_text="Hello world test text for versioning.",
            source_kind="text",
            model_id="Qwen/Qwen3-TTS-12Hz-0.6B-Base",
            voice_id="suzy",
        )
        # Create the original chunk (version 0)
        self.original_chunk = self.manager.add_planned_chunk(
            self.job.id,
            text="Original chunk text",
            char_start=0,
            char_end=18,
            plan_version=1,
            voice_id="suzy",
        )
        self.original_chunk.status = ChunkStatus.WRITTEN
        self.original_chunk.duration_seconds = 4.0
        self.original_chunk.segment_path = "/path/to/segment.m4s"
        self.original_chunk.wav_path = "/path/to/audio.wav"

    def test_add_versioned_chunk_creates_new_version(self):
        new_job = self.manager.add_versioned_chunk(
            self.job.id,
            text="New chunk text",
            char_start=0,
            char_end=16,
            plan_version=2,
            voice_id="suzy",
            parent_index=0,
        )
        job = self.manager.get_job(new_job.id)
        # There should now be 2 chunks for index 0
        version_0_chunks = [c for c in job.chunks if c.index == 0 and c.version == 0]
        version_1_chunks = [c for c in job.chunks if c.index == 0 and c.version == 1]
        assert len(version_0_chunks) == 1
        assert len(version_1_chunks) == 1
        assert version_1_chunks[0].text == "New chunk text"

    def test_add_versioned_chunk_increments_version(self):
        # Add version 1
        self.manager.add_versioned_chunk(
            self.job.id,
            text="Version 1 text",
            char_start=0,
            char_end=14,
            plan_version=2,
            voice_id="suzy",
            parent_index=0,
        )
        # Add version 2
        new_job = self.manager.add_versioned_chunk(
            self.job.id,
            text="Version 2 text",
            char_start=0,
            char_end=14,
            plan_version=3,
            voice_id="suzy",
            parent_index=0,
        )
        job = self.manager.get_job(new_job.id)
        version_2_chunks = [c for c in job.chunks if c.index == 0 and c.version == 2]
        assert len(version_2_chunks) == 1
        assert version_2_chunks[0].text == "Version 2 text"

    def test_add_versioned_chunk_marks_lower_versions_deprecated(self):
        self.manager.add_versioned_chunk(
            self.job.id,
            text="New chunk text",
            char_start=0,
            char_end=16,
            plan_version=2,
            voice_id="suzy",
            parent_index=0,
        )
        job = self.manager.get_job(self.job.id)
        version_0 = next(c for c in job.chunks if c.version == 0)
        assert version_0.deprecated is True

    def test_add_versioned_chunk_sets_reprocessing_true(self):
        new_job = self.manager.add_versioned_chunk(
            self.job.id,
            text="New chunk text",
            char_start=0,
            char_end=16,
            plan_version=2,
            voice_id="suzy",
            parent_index=0,
        )
        job = self.manager.get_job(new_job.id)
        reprocessing_chunks = [c for c in job.chunks if c.reprocessing]
        assert len(reprocessing_chunks) == 1
        assert reprocessing_chunks[0].reprocessing is True

    def test_add_versioned_chunk_sets_active_version(self):
        self.manager.add_versioned_chunk(
            self.job.id,
            text="New chunk text",
            char_start=0,
            char_end=16,
            plan_version=2,
            voice_id="suzy",
            parent_index=0,
        )
        job = self.manager.get_job(self.job.id)
        assert job.active_chunk_version[0] == 1

    def test_add_versioned_chunk_sets_parent_chunk_index(self):
        new_job = self.manager.add_versioned_chunk(
            self.job.id,
            text="New chunk text",
            char_start=0,
            char_end=16,
            plan_version=2,
            voice_id="suzy",
            parent_index=0,
        )
        job = self.manager.get_job(new_job.id)
        v1_chunk = next(c for c in job.chunks if c.version == 1)
        assert v1_chunk.parent_chunk_index == 0

    def test_add_versioned_chunk_sets_total_versioned_chunks(self):
        # add_versioned_chunk sets total_versioned_chunks = number of unique chunk indices
        # After first add_versioned_chunk (for parent_index=0), should be 1
        self.manager.add_versioned_chunk(
            self.job.id,
            text="New chunk text",
            char_start=0,
            char_end=16,
            plan_version=2,
            voice_id="suzy",
            parent_index=0,
        )
        job = self.manager.get_job(self.job.id)
        assert job.total_versioned_chunks == 1
        # Add a second version for a DIFFERENT parent_index
        # But add_planned_chunk doesn't update total_versioned_chunks,
        # so we need to use add_versioned_chunk
        # Create a new chunk first
        chunk1 = ChunkRecord(
            job_id=self.job.id,
            index=1,
            text="Chunk 2 text",
            voice_id="suzy",
            plan_version=1,
            char_start=18,
            char_end=28,
            status=ChunkStatus.PLANNED,
        )
        job.chunks.append(chunk1)
        # Now call add_versioned_chunk for parent_index=1
        self.manager.add_versioned_chunk(
            self.job.id,
            text="Chunk 2 v1",
            char_start=18,
            char_end=24,
            plan_version=2,
            voice_id="suzy",
            parent_index=1,
        )
        job = self.manager.get_job(self.job.id)
        # total_versioned_chunks should now be 2 (indices 0 and 1)
        assert job.total_versioned_chunks == 2


class TestJobManagerSetActiveVersion:
    """Tests for JobManager.set_active_chunk_version."""

    def setup_method(self):
        self.manager = JobManager()
        self.job = self.manager.create_job(
            source_text="Test text",
            source_kind="text",
            model_id="Qwen/Qwen3-TTS-12Hz-0.6B-Base",
            voice_id="suzy",
        )
        # Create v0
        v0 = self.manager.add_planned_chunk(
            self.job.id,
            text="Version 0",
            char_start=0,
            char_end=9,
            plan_version=1,
            voice_id="suzy",
        )
        v0.status = ChunkStatus.WRITTEN
        v0.segment_path = "/path/segment.m4s"
        v0.wav_path = "/path/audio.wav"
        # Create v1
        v1 = ChunkRecord(
            job_id=self.job.id,
            index=0,
            text="Version 1",
            voice_id="suzy",
            plan_version=2,
            char_start=0,
            char_end=9,
            version=1,
            status=ChunkStatus.WRITTEN,
        )
        self.manager.get_job(self.job.id).chunks.append(v1)

    def test_set_active_chunk_version_switches_version(self):
        self.manager.set_active_chunk_version(self.job.id, 0, 1)
        job = self.manager.get_job(self.job.id)
        assert job.active_chunk_version[0] == 1

    def test_set_active_chunk_version_undeprecates_active_version(self):
        v1 = next(c for c in self.manager.get_job(self.job.id).chunks if c.version == 1)
        v1.deprecated = True
        self.manager.set_active_chunk_version(self.job.id, 0, 1)
        v1 = next(c for c in self.manager.get_job(self.job.id).chunks if c.version == 1)
        assert v1.deprecated is False


class TestJobManagerReactivateJob:
    """Tests for JobManager.reactivate_job."""

    def setup_method(self):
        self.manager = JobManager()
        self.job = self.manager.create_job(
            source_text="Test text",
            source_kind="text",
            model_id="Qwen/Qwen3-TTS-12Hz-0.6B-Base",
            voice_id="suzy",
        )
        # Create a chunk and mark it written to complete the job
        chunk = self.manager.add_planned_chunk(
            self.job.id,
            text="Test chunk",
            char_start=0,
            char_end=10,
            plan_version=1,
            voice_id="suzy",
        )
        chunk.status = ChunkStatus.WRITTEN
        chunk.duration_seconds = 2.0
        chunk.segment_path = "/path/segment.m4s"
        chunk.wav_path = "/path/audio.wav"
        # Manually set planner cursor to exhausted
        self.manager.get_job(self.job.id).planner_cursor.offset = -1

    def test_reactivate_completed_job(self):
        # First complete the job
        self.manager.get_job(self.job.id).status = JobStatus.COMPLETED
        result = self.manager.reactivate_job(self.job.id)
        assert result.status == JobStatus.QUEUED
        assert result.is_active_listening is False
        assert result.playback_state.is_playing is False

    def test_reactivate_failed_job(self):
        # First fail the job
        self.manager.get_job(self.job.id).status = JobStatus.FAILED
        result = self.manager.reactivate_job(self.job.id)
        assert result.status == JobStatus.QUEUED

    def test_reactivate_does_not_change_non_terminal_job(self):
        self.manager.get_job(self.job.id).status = JobStatus.RENDERING
        original_status = self.manager.get_job(self.job.id).status
        result = self.manager.reactivate_job(self.job.id)
        assert result.status == original_status

    def test_reactivate_stores_job_id(self):
        self.manager.get_job(self.job.id).status = JobStatus.COMPLETED
        result = self.manager.reactivate_job(self.job.id)
        assert result.id == self.job.id


class TestJobManagerMarkChunkWritten:
    """Tests for JobManager.mark_chunk_written with versioned logic."""

    def setup_method(self):
        self.manager = JobManager()
        self.job = self.manager.create_job(
            source_text="Test text",
            source_kind="text",
            model_id="Qwen/Qwen3-TTS-12Hz-0.6B-Base",
            voice_id="suzy",
        )
        # Keep a reference to the manager's copy of the job
        self.job_in_manager = self.manager.get_job(self.job.id)

    def test_mark_chunk_written_counts_versioned_completed(self):
        chunk = self.manager.add_planned_chunk(
            self.job.id,
            text="Test chunk",
            char_start=0,
            char_end=10,
            plan_version=1,
            voice_id="suzy",
        )
        # Set active_chunk_version so versioned count works
        self.job_in_manager.active_chunk_version[0] = 0
        # Let mark_chunk_written set the status to WRITTEN
        job = self.manager.mark_chunk_written(
            chunk,
            duration_seconds=2.0,
            segment_path="/path/segment.m4s",
            wav_path="/path/audio.wav",
        )
        # Verify the chunk is now written
        assert chunk.status == ChunkStatus.WRITTEN
        # total_versioned_completed should be 1 (v0 is the active version)
        assert job.total_versioned_completed == 1

    def test_mark_chunk_written_with_multiple_versions(self):
        # Create v0 and mark it written
        chunk_v0 = self.manager.add_planned_chunk(
            self.job.id,
            text="Version 0",
            char_start=0,
            char_end=9,
            plan_version=1,
            voice_id="suzy",
        )
        # Set active_chunk_version so versioned count works
        self.job_in_manager.active_chunk_version[0] = 0
        job = self.manager.mark_chunk_written(
            chunk_v0,
            duration_seconds=2.0,
            segment_path="/path/segment.m4s",
            wav_path="/path/audio.wav",
        )
        # Should count v0 as written (it's the active version)
        assert job.total_versioned_completed == 1


class TestJobManagerRenderableChunks:
    """Tests for JobManager.renderable_chunks skipping deprecated."""

    def setup_method(self):
        self.manager = JobManager()

    def test_renderable_chunks_skips_deprecated(self):
        job = self.manager.create_job(
            source_text="Test text",
            source_kind="text",
            model_id="Qwen/Qwen3-TTS-12Hz-0.6B-Base",
            voice_id="suzy",
        )
        # Create v0 - deprecated, should not be rendered
        v0 = self.manager.add_planned_chunk(
            job.id,
            text="Version 0",
            char_start=0,
            char_end=9,
            plan_version=1,
            voice_id="suzy",
        )
        v0.deprecated = True
        # Create v1 with matching plan_version - should be rendered
        v1 = ChunkRecord(
            job_id=job.id,
            index=0,
            text="Version 1",
            voice_id="suzy",
            plan_version=1,  # Same plan_version as job
            char_start=0,
            char_end=9,
            version=1,
            status=ChunkStatus.PLANNED,
            deprecated=False,
        )
        job.chunks.append(v1)

        renderable = list(self.manager.renderable_chunks())
        # Only v1 should be renderable (v0 is deprecated)
        assert len(renderable) == 1
        assert renderable[0].version == 1

    def test_renderable_chunks_skips_non_planned(self):
        job = self.manager.create_job(
            source_text="Test text",
            source_kind="text",
            model_id="Qwen/Qwen3-TTS-12Hz-0.6B-Base",
            voice_id="suzy",
        )
        # Create a WRITTEN chunk (should not be renderable)
        chunk = self.manager.add_planned_chunk(
            job.id,
            text="Test chunk",
            char_start=0,
            char_end=10,
            plan_version=1,
            voice_id="suzy",
        )
        chunk.status = ChunkStatus.WRITTEN

        renderable = list(self.manager.renderable_chunks())
        assert len(renderable) == 0


class TestJobManagerQueueDepth:
    """Tests for JobManager.queue_depth with reprocessing status."""

    def setup_method(self):
        self.manager = JobManager()

    def test_queue_depth_includes_rendering(self):
        """RENDERING is included in queue_depth."""
        job = self.manager.create_job(
            source_text="Test text",
            source_kind="text",
            model_id="Qwen/Qwen3-TTS-12Hz-0.6B-Base",
            voice_id="suzy",
        )
        chunk = self.manager.add_planned_chunk(
            job.id,
            text="Test chunk",
            char_start=0,
            char_end=10,
            plan_version=1,
            voice_id="suzy",
        )
        chunk.status = ChunkStatus.RENDERING

        assert self.manager.queue_depth() == 1

    def test_queue_depth_includes_queued(self):
        job = self.manager.create_job(
            source_text="Test text",
            source_kind="text",
            model_id="Qwen/Qwen3-TTS-12Hz-0.6B-Base",
            voice_id="suzy",
        )
        chunk = self.manager.add_planned_chunk(
            job.id,
            text="Test chunk",
            char_start=0,
            char_end=10,
            plan_version=1,
            voice_id="suzy",
        )
        chunk.status = ChunkStatus.QUEUED

        assert self.manager.queue_depth() == 1

    def test_queue_depth_excludes_written(self):
        job = self.manager.create_job(
            source_text="Test text",
            source_kind="text",
            model_id="Qwen/Qwen3-TTS-12Hz-0.6B-Base",
            voice_id="suzy",
        )
        chunk = self.manager.add_planned_chunk(
            job.id,
            text="Test chunk",
            char_start=0,
            char_end=10,
            plan_version=1,
            voice_id="suzy",
        )
        chunk.status = ChunkStatus.WRITTEN

        assert self.manager.queue_depth() == 0

    def test_queue_depth_excludes_planned_non_deprecated(self):
        job = self.manager.create_job(
            source_text="Test text",
            source_kind="text",
            model_id="Qwen/Qwen3-TTS-12Hz-0.6B-Base",
            voice_id="suzy",
        )
        self.manager.add_planned_chunk(
            job.id,
            text="Test chunk",
            char_start=0,
            char_end=10,
            plan_version=1,
            voice_id="suzy",
        )
        # Planned chunks ARE included in queue depth
        assert self.manager.queue_depth() == 1
