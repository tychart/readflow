"""The scheduler's source-text cache.

Two properties matter and both are easy to get wrong: the budget must be
respected (or a library of books grows without bound), and a forgotten job must
actually be gone (or a re-created job id is planned from an old document).
"""

from __future__ import annotations

from app.scheduler.source_cache import SourceTextCache


def test_a_cached_text_is_returned_and_counted() -> None:
    cache = SourceTextCache(100)
    cache.put("job-1", "hello")

    assert cache.get("job-1") == "hello"
    assert cache.chars == 5
    assert len(cache) == 1


def test_an_unknown_job_is_a_miss() -> None:
    cache = SourceTextCache(100)
    assert cache.get("nope") is None
    assert cache.chars == 0


def test_least_recently_used_text_is_evicted_first() -> None:
    cache = SourceTextCache(10)
    cache.put("a", "aaaaa")  # 5
    cache.put("b", "bbbbb")  # 5 -> full

    # Touching `a` makes `b` the least recently used entry.
    assert cache.get("a") == "aaaaa"
    cache.put("c", "ccccc")

    assert cache.get("a") == "aaaaa"
    assert cache.get("b") is None
    assert cache.get("c") == "ccccc"
    assert cache.chars == 10


def test_putting_the_same_job_again_does_not_double_count() -> None:
    cache = SourceTextCache(100)
    cache.put("a", "aaaaa")
    cache.put("a", "aaaaa")

    assert cache.chars == 5
    assert len(cache) == 1


def test_a_text_larger_than_the_budget_is_not_cached() -> None:
    """One book must not evict everything and then thrash the cache."""
    cache = SourceTextCache(10)
    cache.put("small", "12345")
    cache.put("book", "x" * 11)

    assert cache.get("book") is None
    assert cache.get("small") == "12345"
    assert cache.chars == 5


def test_a_zero_budget_disables_caching() -> None:
    cache = SourceTextCache(0)
    cache.put("a", "aaa")
    assert cache.get("a") is None
    assert cache.chars == 0


def test_forget_drops_one_entry_and_its_characters() -> None:
    cache = SourceTextCache(100)
    cache.put("a", "aaaaa")
    cache.put("b", "bbb")

    cache.forget("a")

    assert cache.get("a") is None
    assert cache.get("b") == "bbb"
    assert cache.chars == 3


def test_forget_of_an_unknown_job_is_harmless() -> None:
    cache = SourceTextCache(10)
    cache.forget("nope")
    assert cache.chars == 0


def test_clear_empties_the_cache() -> None:
    cache = SourceTextCache(100)
    cache.put("a", "aaa")
    cache.clear()
    assert len(cache) == 0
    assert cache.chars == 0
