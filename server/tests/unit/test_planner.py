from app.chunking.planner import ChunkPlanner
from app.core.config import RuntimeConfig
from app.jobs.models import Job


def test_planner_prefers_sentence_boundaries():
    planner = ChunkPlanner(RuntimeConfig(chunk_target_chars=120))
    job = Job(
        id="job-1",
        title="Example",
        source_kind="text",
        source_text=(
            "This is a longer first sentence that should be captured completely. "
            "Second sentence is slightly longer, but should still be held "
            "for the next chunk.\n\nThird paragraph starts here."
        ),
        model_id="Qwen/Qwen3-TTS-12Hz-0.6B-Base",
        voice_id="suzy",
    )

    first = planner.plan_next(job)
    second = planner.plan_next(job)

    assert first is not None
    assert second is not None
    assert first.text == "This is a longer first sentence that should be captured completely."
    assert second.text.startswith("Second sentence")


def test_planner_produces_uniform_chunk_sizes():
    planner = ChunkPlanner(
        RuntimeConfig(
            chunk_target_chars=180,
        )
    )
    text = " ".join(f"Sentence {index}." for index in range(1, 81))
    job = Job(
        id="job-2",
        title="Example",
        source_kind="text",
        source_text=text,
        model_id="Qwen/Qwen3-TTS-12Hz-0.6B-Base",
        voice_id="suzy",
    )

    chunks = [planner.plan_next(job) for _ in range(4)]

    assert all(chunk is not None for chunk in chunks)
    first = chunks[0]
    last = chunks[-1]
    assert len(first.text) >= 70
    assert len(last.text) >= 70
