from __future__ import annotations

import re

_WHITESPACE_RUN = re.compile(r"[ \t]+")
_EXCESS_NEWLINES = re.compile(r"\n{3,}")


def normalize_source_text(text: str) -> str:
    """Canonicalize job source text.

    Every character offset the system exposes (`ChunkRecord.char_start` /
    `char_end`, the reader's text slicing) indexes into this canonical form, so
    the transform must stay stable and idempotent:

    - ``\\r\\n`` / ``\\r`` collapse to ``\\n``
    - runs of spaces and tabs collapse to a single space
    - runs of three or more newlines collapse to a blank line
    - leading/trailing whitespace is stripped

    This is deliberately the *only* normalization step in the pipeline. It runs
    once when a job is created; planners and clients then treat the stored text
    as already canonical. Normalizing per chunk turned long documents (whole
    books) into O(n^2) work, so do not reintroduce a second call site.
    """
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    text = _WHITESPACE_RUN.sub(" ", text)
    text = _EXCESS_NEWLINES.sub("\n\n", text)
    return text.strip()
