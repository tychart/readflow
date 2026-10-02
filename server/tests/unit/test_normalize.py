from app.chunking.normalize import normalize_source_text


def test_normalize_collapses_carriage_returns_and_space_runs():
    text = "Line one  \t with   gaps.\r\n\r\n\r\nLine two.\r\n"

    assert normalize_source_text(text) == "Line one with gaps.\n\nLine two."


def test_normalize_strips_surrounding_whitespace():
    assert normalize_source_text("\n\n   Padded text.   \n\n") == "Padded text."


def test_normalize_is_idempotent():
    text = "First  line.\r\n\r\n\r\n\r\nSecond\tline.\n\n\n\nThird."

    once = normalize_source_text(text)

    assert normalize_source_text(once) == once
