from app.chunking.planner import ChunkPlanner
from app.core.config import RuntimeConfig
from app.jobs.models import Job


def test_planner_prefers_sentence_boundaries_for_startup_chunk():
    planner = ChunkPlanner(RuntimeConfig(chunk_startup_target_chars=80))
    job = Job(
        id="job-1",
        title="Example",
        source_kind="text",
        source_text=(
            "First sentence is compact. "
            "Second sentence is slightly longer, but should still be held "
            "for the next chunk.\n\nThird paragraph starts here."
        ),
        model_id="qwen3-tts-0.6b",
        voice_id="suzy",
    )

    first = planner.plan_next(job)
    second = planner.plan_next(job)

    assert first is not None
    assert second is not None
    assert first.text == "First sentence is compact."
    assert second.text.startswith("Second sentence")


def test_planner_enters_steady_state_after_first_three_chunks():
    planner = ChunkPlanner(
        RuntimeConfig(
            chunk_startup_target_chars=50,
            chunk_safety_target_chars=90,
            chunk_steady_target_chars=180,
        )
    )
    text = " ".join(f"Sentence {index}." for index in range(1, 41))
    job = Job(
        id="job-2",
        title="Example",
        source_kind="text",
        source_text=text,
        model_id="qwen3-tts-0.6b",
        voice_id="suzy",
    )

    chunks = [planner.plan_next(job) for _ in range(4)]

    assert all(chunk is not None for chunk in chunks)
    first = chunks[0]
    second = chunks[1]
    fourth = chunks[3]

    assert first is not None
    assert second is not None
    assert fourth is not None
    assert len(first.text) <= 60
    assert len(fourth.text) >= len(second.text)
