from itertools import pairwise

from app.chunking.planner import ChunkPlanner, PlannedChunk
from app.core.config import RuntimeConfig
from app.jobs.manager import JobManager
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

    planned = [chunk for chunk in chunks if chunk is not None]
    assert len(planned) == len(chunks)
    first = planned[0]
    last = planned[-1]
    assert len(first.text) >= 70
    assert len(last.text) >= 70


def test_planner_chunks_cover_the_entire_canonical_document():
    """Regression guard: chunk offsets must tile the canonical text exactly.

    Planning used to re-normalize the whole source text on every call, which
    made long documents quadratic. The planner now reads the text as stored
    (already canonical), so offsets must still line up end to end.
    """
    manager = JobManager()
    sentence = "Sentence number one is here. Sentence number two follows it. "
    source = ("\r\n\r\n".join([sentence * 6] * 150)) + ("\r\n\r\nClosing section. " * 40)
    job = manager.create_job(
        source_text=source,
        source_kind="text",
        model_id="Qwen/Qwen3-TTS-12Hz-0.6B-Base",
        voice_id="suzy",
    )
    planner = ChunkPlanner(RuntimeConfig(chunk_target_chars=700))

    planned: list[PlannedChunk] = []
    while (chunk := planner.plan_next(job)) is not None:
        planned.append(chunk)

    assert len(planned) > 20
    assert planned[0].char_start == 0
    for previous, current in pairwise(planned):
        assert current.char_start == previous.char_end
    assert planned[-1].char_end == len(job.source_text)
    assert (
        "".join(job.source_text[chunk.char_start : chunk.char_end] for chunk in planned)
        == job.source_text
    )
