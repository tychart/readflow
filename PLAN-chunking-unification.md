# Plan: Unified Chunk Sizing

## Context

The current chunking system uses three tiers of chunk sizes that the user experiences as a fragmented, multi-stall playback:

| Phase | Chunks | Target Size | Est. Duration |
|-------|--------|-------------|---------------|
| Startup | #0 | 140 chars | ~8s |
| Safety | #1-2 | 260 chars | ~14s |
| Steady | #3+ | 700 chars | ~39s |

Additionally, the scheduler groups chunks into **separate batch buckets by size** (`_length_bucket` → short/medium/long), meaning chunks of different sizes never get batched together. This compounds the problem: small chunks finish fast, big chunks each get their own turn, and the user experiences "quick, quick, WAIT, quick, WAIT."

**Goal:** Replace all three tiers with a single unified chunk size (~700 chars, matching current steady-state). Keep all boundary-priority logic (paragraph → sentence → punctuation → space) and all priority/batching/scheduler logic intact.

## Approach

1. **Replace 3 config values with 1** in `RuntimeConfig`
2. **Simplify the planner** — remove `_target_chars` tiering and `startup_mode` parameter
3. **Simplify the scheduler** — remove `_length_bucket` since all chunks will be the same size, which actually **improves batching** (more chunks share the same batch key)
4. **Update tests** to reflect the simplified logic

## Files to Modify

### 1. `server/app/core/config.py`

**Change:** Replace 3 config values with 1.

```python
# Remove these three:
chunk_startup_target_chars: int = 140
chunk_safety_target_chars: int = 260
chunk_steady_target_chars: int = 700

# Add this one:
chunk_target_chars: int = 700
```

### 2. `server/app/chunking/planner.py`

**Change 2a:** Simplify `_target_chars` to return a single value:

```python
# Remove:
def _target_chars(self, job: Job) -> int:
    emitted = job.planner_cursor.chunks_emitted
    if emitted == 0:
        return self._config.chunk_startup_target_chars
    if emitted < 3:
        return self._config.chunk_safety_target_chars
    return self._config.chunk_steady_target_chars

# Replace with:
def _target_chars(self, job: Job) -> int:
    return self._config.chunk_target_chars
```

**Change 2b:** Remove `startup_mode` parameter from `_find_boundary` call and method signature:

```python
# Line 45 — change:
char_end = self._find_boundary(remaining, target_chars, startup_mode=emitted == 0)

# To:
char_end = self._find_boundary(remaining, target_chars)

# Line 78 — change signature:
def _find_boundary(self, text: str, target_chars: int, *, startup_mode: bool) -> int:
# To:
def _find_boundary(self, text: str, target_chars: int) -> int:

# Line 87 — remove the startup_mode conditional:
minimum_boundary = 20 if startup_mode else max(40, int(target_chars * 0.45))
# To:
minimum_boundary = max(40, int(target_chars * 0.45))
```

The boundary detection priority stays exactly the same: paragraph breaks (`\n\n+`) → sentence-ending punctuation (`.!?`) → comma/semicolon/colon punctuation → hard limit + space fallback. Only the startup-mode exception (allowing 20-char boundaries) is removed.

### 3. `server/app/scheduler/service.py`

**Change:** Remove `_length_bucket` method and its usage in the batch key.

```python
# Line 119 — in _render_next_batch, remove the _length_bucket dimension from the key:
key = (
    job.model_id,
    job.language,
    chunk.voice_id,
    self._length_bucket(chunk),   # REMOVE THIS LINE
)
# To:
key = (
    job.model_id,
    job.language,
    chunk.voice_id,
)

# Remove the entire _length_bucket method (lines 156-160):
def _length_bucket(self, chunk: ChunkRecord) -> str:
    length = len(chunk.text)
    if length < 150:
        return "short"
    if length < 500:
        return "medium"
    return "long"
```

This is a **beneficial change** — removing the size bucket from the batch key means all chunks with the same model+language+voice get batched together. Previously, chunks of different sizes were forced into separate batches, limiting throughput. Now with unified sizes, every eligible chunk can be batched.

### 4. `server/tests/unit/test_planner.py`

**Change:** Update existing tests for the new unified behavior.

- `test_planner_prefers_sentence_boundaries_for_startup_chunk` — Remove the "startup" framing. The test still validates boundary detection works, just no longer tests a special "startup" tier. Rename and adjust expectations.
- `test_planner_enters_steady_state_after_first_three_chunks` — Remove this test entirely. It tests the tiering behavior that no longer exists. Replace with a simpler test verifying all chunks come out at the unified target size.

### 5. `server/tests/unit/test_scheduler.py`

**No changes needed.** None of the 3 existing tests reference `_length_bucket`, chunk sizes, or chunk tiers. They test:
- Active-listening priority
- VRAM-based batch size reduction
- Single-voice batching

All of these are unaffected.

## What Does NOT Change

- **Priority system** — Active listening jobs still get band 0 priority, passive jobs get band 2. Unchanged.
- **Pre-buffer logic** — Active listening jobs plan up to 5 chunks (bounded by `max_prebuffer_seconds`). With unified 700-char chunks, 5 chunks ≈ 194s of audio. Well within the 300s limit.
- **Inactive job ahead** — `inactive_job_ahead_chunks = 1` means inactive jobs plan 1 chunk ahead. With 700 chars = ~39s of audio. This is a reasonable amount of pre-rendering.
- **Batching logic** — Still groups by (model_id, language, voice_id). Now with one fewer dimension, batching is actually more effective.
- **VRAM management** — `_choose_batch_size` and all memory caps are unchanged.
- **Boundary detection** — Paragraph breaks → sentence punctuation → other punctuation → space fallback all stay the same.
- **Media pipeline** — `SynthesisWorker`, `MediaStore`, provider layer all work with chunk text unchanged.

## Steps

- [x] Edit `server/app/core/config.py` — replace 3 chunk config values with `chunk_target_chars: int = 700`
- [x] Edit `server/app/chunking/planner.py` — simplify `_target_chars`, remove `startup_mode` from `_find_boundary`
- [x] Edit `server/app/scheduler/service.py` — remove `_length_bucket` method and its usage in batch key (also fixed batch key unpacking from 4-tuple to 3-tuple)
- [x] Edit `server/tests/unit/test_planner.py` — update tests for unified sizing
- [x] Run `uv run pytest tests/unit/test_planner.py tests/unit/test_scheduler.py` to verify — **25 passed, 2 skipped (real model tests)**

## Verification

1. **Unit tests pass:** `uv run pytest tests/unit/test_planner.py tests/unit/test_scheduler.py`
2. **Full test suite:** `uv run pytest` (all ~70 tests)
3. **Manual verification:** Start the server with a long text. Observe that:
   - First chunk is ~700 chars (not 140)
   - All subsequent chunks are ~700 chars
   - Batching groups chunks more effectively (no size-based separation)
   - Active listening still pre-buffers correctly


Honnestly we dont' really even need a deprecated identifier, because maybe the user didn't like the latest item and they actually want to use v4 instead of v5 or something. Would you just be able to put in a "current" identifier that is set to indicate that that version of the chunk is the one that the user selected most recently? That way if they leave the interface and come back it remembers whichever was the latest chunk that the user had selected. Would this make sense? Are there any problems you forsee with this approach?