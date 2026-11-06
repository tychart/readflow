from itertools import pairwise

from app.chunking.normalize import normalize_source_text
from app.chunking.planner import ChunkPlan, ChunkPlanner
from app.core.config import RuntimeConfig
from app.db.memory import MemoryDatabase
from app.jobs.manager import JobManager


def _planner(target_chars: int) -> ChunkPlanner:
    return ChunkPlanner(RuntimeConfig(chunk_target_chars=target_chars))


def _plan_all(planner: ChunkPlanner, text: str) -> list[ChunkPlan]:
    """Drive the planner the way the manager does: continue at `char_end`."""
    plans: list[ChunkPlan] = []
    offset = 0
    while (plan := planner.plan_next(text, offset)) is not None:
        plans.append(plan)
        offset = plan.char_end
    return plans


def test_planner_prefers_sentence_boundaries():
    text = (
        "This is a longer first sentence that should be captured completely. "
        "Second sentence is slightly longer, but should still be held "
        "for the next chunk.\n\nThird paragraph starts here."
    )

    first = _planner(120).plan_next(text, 0)
    assert first is not None
    second = _planner(120).plan_next(text, first.char_end)

    assert first.text == "This is a longer first sentence that should be captured completely."
    assert second is not None
    assert second.text.startswith("Second sentence")


def test_planner_produces_uniform_chunk_sizes():
    text = " ".join(f"Sentence {index}." for index in range(1, 81))

    planned = _plan_all(_planner(180), text)

    assert len(planned) >= 4
    assert len(planned[0].text) >= 70
    assert all(len(plan.text) >= 70 for plan in planned[:-1])


def test_planner_chunks_cover_the_entire_canonical_document():
    """Regression guard: chunk offsets must tile the canonical text exactly.

    Planning used to re-normalize the whole source text on every call, which
    made long documents quadratic. The planner now reads the text as stored
    (already canonical), so offsets must still line up end to end.
    """
    sentence = "Sentence number one is here. Sentence number two follows it. "
    source = ("\r\n\r\n".join([sentence * 6] * 150)) + ("\r\n\r\nClosing section. " * 40)
    text = normalize_source_text(source)

    planned = _plan_all(_planner(700), text)

    assert len(planned) > 20
    assert planned[0].char_start == 0
    for previous, current in pairwise(planned):
        assert current.char_start == previous.char_end
    assert planned[-1].char_end == len(text)
    # No gaps and no overlap: slicing every span reproduces the document.
    assert "".join(text[plan.char_start : plan.char_end] for plan in planned) == text
    # Each span's text is exactly the stripped slice it describes.
    for plan in planned:
        assert plan.text == text[plan.char_start : plan.char_end].strip()


def test_planner_reports_exhaustion_on_the_final_plan():
    text = "One short paragraph only."

    plans = _plan_all(_planner(700), text)

    assert len(plans) == 1
    assert plans[0].char_end == len(text)
    assert plans[0].text == text
    # Once exhausted, planning stays exhausted.
    assert _planner(700).plan_next(text, -1) is None


def test_planner_ignores_trailing_whitespace_only():
    text = "A final sentence."

    assert _planner(700).plan_next(text, 0) is not None
    assert _planner(700).plan_next(text, len(text)) is None
    assert _planner(700).plan_next(f"{text}\n\n   \n", len(text)) is None


def test_planner_is_pure_so_an_unused_plan_cannot_skip_text():
    """Planning and storing are separate steps, and only storing advances.

    The planner used to mutate `job.planner_cursor` while producing a chunk, so
    a plan that was never appended (an aborted tick, an exception in the
    manager) silently dropped that slice of the document.
    """
    manager = JobManager(MemoryDatabase())
    job = manager.create_job(
        source_text="First sentence here. Second sentence follows. " * 8,
        source_kind="text",
        model_id="Qwen/Qwen3-TTS-12Hz-0.6B-Base",
        voice_id="suzy",
    )
    planner = _planner(120)

    discarded = planner.plan_next(job.source_text, job.planner_cursor.offset)
    assert discarded is not None
    assert job.planner_cursor.offset == 0
    assert job.chunks == []

    first = planner.plan_next(job.source_text, job.planner_cursor.offset)
    assert first is not None
    manager.add_planned_chunk(job.id, first)

    assert job.planner_cursor.offset == first.char_end
    assert job.planner_cursor.chunks_emitted == 1
    assert [chunk.text for chunk in job.chunks] == [first.text]
    assert job.chunks[0].char_start == 0


def test_finish_planning_marks_the_cursor_exhausted():
    manager = JobManager(MemoryDatabase())
    job = manager.create_job(
        source_text="Only text.",
        source_kind="text",
        model_id="Qwen/Qwen3-TTS-12Hz-0.6B-Base",
        voice_id="suzy",
    )
    plan = _planner(700).plan_next(job.source_text, 0)
    assert plan is not None
    manager.add_planned_chunk(job.id, plan)

    # add_planned_chunk already recorded exhaustion for a terminal plan.
    assert job.planner_cursor.exhausted

    manager.finish_planning(job.id)
    assert job.planner_cursor.exhausted


def test_planning_a_long_document_stays_window_bounded():
    """Only ~1.2 targets past the cursor may influence a chunk.

    Slicing the whole remainder (`text[offset:]`) made planning a book quadratic
    in copied characters. Two documents that agree inside the window must plan
    the same chunk, whatever follows it.
    """
    planner = _planner(120)
    window = int(120 * 1.2) + 1
    prefix = "Sentence one is here. Sentence two follows it. Sentence three too. "
    prefix = prefix[:window]

    short = planner.plan_next(prefix, 0)
    long = planner.plan_next(prefix + "x" * 2_000_000, 0)

    assert short is not None and long is not None
    assert short == long
    assert short.char_end <= len(prefix)


def test_planner_never_stalls_on_a_whitespace_run_after_normalization():
    text = normalize_source_text("End of one.\n\n\n\n   \n\nStart of two.")
    plans = _plan_all(_planner(700), text)
    assert "".join(text[plan.char_start : plan.char_end] for plan in plans) == text
