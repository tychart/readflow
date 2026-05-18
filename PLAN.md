# Chunk Reprocessing & Versioning

## Context

Users need to reprocess individual chunks — whether to retry a failed synthesis, re-synthesize a written chunk for a different voice/quality/model, or edit the chunk text. The feature should add new versions of chunks (not overwrite), keep old versions as fallback, show version selection in the UI, and auto-switch when a new version arrives. Completed jobs can be revived for reprocessing and return to completed when done.

---

## Approach

Introduce per-chunk **versions** throughout the pipeline. A chunk has a `version` number starting at `0` (the original). Reprocessing creates a new chunk with the same index but `version + 1`, marks the old one deprecated, and lets the scheduler queue it normally. The frontend tracks an **active version** per chunk index and provides a dropdown to switch between versions. A "reprocessing" status shows a reload icon while the new version renders.

---

## Files to Modify

### Server

| File | What |
|---|---|
| `server/app/jobs/models.py` | New chunk statuses; `version` field on `ChunkRecord`; `active_chunk_version` dict, `total_versioned_chunks`, `total_versioned_completed` on `Job`; helper methods |
| `server/app/jobs/manager.py` | `add_versioned_chunk()` and `set_active_chunk_version()` methods; `mark_chunk_written()` updated to count active versions |
| `server/app/media/store.py` | `segment_path()` and `wav_path()` accept optional `version` param |
| `server/app/api/router.py` | New `POST /jobs/{job_id}/chunks/{chunk_index}/reprocess` endpoint; new `POST /jobs/{job_id}/chunks/{chunk_index}/set-active-version` endpoint |
| `server/app/schemas/api.py` | Add `version` to `ChunkResponse`; update `chunk_to_response()` |
| `server/app/scheduler/service.py` | `renderable_chunks()` skips deprecated chunks (only render highest pending version) |

### Frontend

| File | What |
|---|---|
| `web/src/types/api.ts` | Add `version` field to `Chunk` interface |
| `web/src/lib/api.ts` | Add `reprocessChunk()` and `setActiveVersion()` functions |
| `web/src/features/reader/ReaderPage.tsx` | Major rewrite: version dropdown, text edit with inline textarea, reprocess button, version-aware timeline rendering, reprocessing state management |

---

## Reuse

- **Existing chunk lifecycle** — uses the same `planned → queued → rendering → written` flow for new versions
- **Existing scheduler batching** — new version chunks go through `_rank_renderable_chunks()` and `_render_next_batch()`
- **Existing WebSocket events** — `job_updated` broadcast after reprocess/activation; `chunk_ready` for new version completion
- **Existing `job_to_detail()`** serialization — just needs the `version` field propagated
- **Existing `useMediaSourcePlayer`** — version switching updates the manifest; player continues current version until new one is ready

---

## Steps

### Step 1 — Server data model changes (`server/app/jobs/models.py`)

**New statuses:**
- `ChunkStatus.REPROCESSING` — old version is superseded, new version queued
- `ChunkStatus.MAX_RETRIES_EXCEEDED` — failed 3 times during reprocessing

**New `ChunkRecord` fields:**
```python
version: int = 0
parent_chunk_index: int | None = None  # the index it replaces
deprecated: bool = False  # True when superseded by a higher version
reprocessing: bool = False  # True when this chunk is being re-processed
```

**New `Job` fields:**
```python
active_chunk_version: dict[int, int] = field(default_factory=dict)  # index -> version
total_versioned_chunks: int = 0
total_versioned_completed: int = 0
```

**New `Job` methods:**
```python
def get_active_chunk(self, index: int) -> ChunkRecord | None
    """Return the currently active version of a chunk, or None if not found."""
    version = self.active_chunk_version.get(index)
    for chunk in self.chunks:
        if chunk.index == index and chunk.version == version:
            return chunk
    return None

def set_active_chunk_version(self, index: int, version: int) -> None
    """Mark a specific version as the active one for a chunk index."""
    self.active_chunk_version[index] = version
    self.updated_at = time()

def get_latest_chunk_version(self, index: int) -> int
    """Return the highest version number for a chunk index."""
    return max((c.version for c in self.chunks if c.index == index), default=-1)

def versioned_pending_chunks(self) -> list[ChunkRecord]:
    """Return active-version chunks that still need rendering."""
    result = []
    for index, version in self.active_chunk_version.items():
        for chunk in self.chunks:
            if chunk.index == index and chunk.version == version:
                if chunk.status in {ChunkStatus.PLANNED, ChunkStatus.QUEUED, ChunkStatus.REPROCESSING}:
                    result.append(chunk)
                break
    return result

def mark_all_chunk_versions_deprecated(self, index: int) -> None
    """Mark all versions of a chunk as deprecated."""
    for chunk in self.chunks:
        if chunk.index == index:
            chunk.deprecated = True
            chunk.updated_at = time()
```

### Step 2 — JobManager methods (`server/app/jobs/manager.py`)

**New `add_versioned_chunk()` method:**
```python
def add_versioned_chunk(
    self,
    job_id: str,
    *,
    text: str,
    char_start: int,
    char_end: int,
    plan_version: int,
    voice_id: str,
    parent_index: int,
    retries: int = 0,
) -> Job:
    """Add a new version of a chunk. Marks lower versions as deprecated."""
    job = self.get_job(job_id)
    latest_version = job.get_latest_chunk_version(parent_index)
    new_version = latest_version + 1

    # Mark all existing versions of this chunk as deprecated
    job.mark_all_chunk_versions_deprecated(parent_index)

    # Create the new versioned chunk
    chunk = ChunkRecord(
        job_id=job_id,
        index=parent_index,
        text=text,
        voice_id=voice_id,
        language=job.language,
        plan_version=plan_version,
        char_start=char_start,
        char_end=char_end,
        version=new_version,
        parent_chunk_index=parent_index,
        status=ChunkStatus.PLANNED,
        reprocessing=True,
    )
    job.chunks.append(chunk)
    job.total_chunks_emitted = len(job.chunks)

    # Set as active version
    job.set_active_chunk_version(parent_index, new_version)
    job.total_versioned_chunks = len({c.index for c in job.chunks})
    job.updated_at = time()
    return job
```

**New `set_active_chunk_version()` method:**
```python
def set_active_chunk_version(self, job_id: str, chunk_index: int, version: int) -> Job:
    job = self.get_job(job_id)
    job.set_active_chunk_version(chunk_index, version)

    # Ensure the active version is not deprecated
    for chunk in job.chunks:
        if chunk.index == chunk_index and chunk.version == version:
            chunk.deprecated = False
            break

    job.updated_at = time()
    return job
```

**New `reactivate_job()` method:**
```python
def reactivate_job(self, job_id: str) -> Job:
    """Reactivate a completed or failed job so it can be reprocessed."""
    job = self.get_job(job_id)
    if job.status not in {JobStatus.COMPLETED, JobStatus.FAILED}:
        return job
    job.status = JobStatus.QUEUED
    job.is_active_listening = False
    job.playback_state.is_playing = False
    job.updated_at = time()
    return job
```

**Update `mark_chunk_written()` to count active versions:**
- Replace the old `total_chunks_completed` completion check with `total_versioned_completed`
- Only count active versions (use `versioned_pending_chunks()`)

### Step 3 — Media store versioned paths (`server/app/media/store.py`)

Update `segment_path()` and `wav_path()` to accept an optional `version` parameter:

```python
def segment_path(self, job_id: str, chunk_index: int, version: int = 0) -> Path:
    suffix = f"_v{version}" if version > 0 else ""
    return self.job_dir(job_id) / f"{chunk_index:05d}{suffix}.m4s"

def wav_path(self, job_id: str, chunk_index: int, version: int = 0) -> Path:
    suffix = f"_v{version}" if version > 0 else ""
    return self.job_dir(job_id) / f"{chunk_index:05d}{suffix}.wav"
```

Update `package_wav_chunk()` to accept `version` and pass it to the path methods.

### Step 4 — Scheduler skips deprecated chunks (`server/app/scheduler/service.py`)

Update `renderable_chunks()` to only yield chunks where `deprecated == False`:

```python
def renderable_chunks(self) -> Iterable[ChunkRecord]:
    for job in self.list_jobs():
        for chunk in job.chunks:
            if (chunk.status == ChunkStatus.PLANNED
                and chunk.plan_version == job.plan_version
                and not chunk.deprecated):
                yield chunk
```

### Step 5 — API router endpoints (`server/app/api/router.py`)

**New endpoint: `POST /jobs/{job_id}/chunks/{chunk_index}/reprocess`**
```python
@router.post("/jobs/{job_id}/chunks/{chunk_index}/reprocess", response_model=JobDetailResponse)
async def reprocess_chunk(
    job_id: str,
    chunk_index: int,
    new_text: str | None = None,
    new_voice_id: str | None = None,
    app_services: AppServices = Depends(services),
) -> JobDetailResponse:
    try:
        job = app_services.job_manager.get_job(job_id)
    except KeyError:
        raise HTTPException(404, "Job not found")

    # Check if chunk exists
    chunk = None
    for c in job.chunks:
        if c.index == chunk_index:
            chunk = c
            break
    if chunk is None:
        raise HTTPException(404, "Chunk not found")

    # Revive completed/failed jobs
    if job.status in {JobStatus.COMPLETED, JobStatus.FAILED}:
        app_services.job_manager.reactivate_job(job_id)

    # Check retry limit (max 3 total attempts including original)
    latest_version = job.get_latest_chunk_version(chunk_index)
    if latest_version >= 3:  # V0 original + 3 retries = max
        raise HTTPException(409, "Maximum retry attempts exceeded")

    # Determine text and voice for the new version
    text = new_text if new_text is not None else chunk.text
    voice = new_voice_id if new_voice_id is not None else job.voice_id

    # Get the original text ranges from the source
    normalized = job.planner.normalize_text(job.source_text)
    char_start = chunk.char_start
    char_end = chunk.char_end

    job = app_services.job_manager.add_versioned_chunk(
        job_id,
        text=text,
        char_start=char_start,
        char_end=char_end,
        plan_version=job.plan_version,
        voice_id=voice,
        parent_index=chunk_index,
        retries=latest_version,
    )

    detail = job_to_detail(job)
    await app_services.hub.broadcast(
        WsEnvelope(type="job_updated", payload={"job": detail.model_dump()}).model_dump()
    )
    return JobDetailResponse(**detail.model_dump())
```

**New endpoint: `POST /jobs/{job_id}/chunks/{chunk_index}/set-active-version`**
```python
@router.post("/jobs/{job_id}/chunks/{chunk_index}/set-active-version", response_model=JobDetailResponse)
async def set_active_chunk_version(
    job_id: str,
    chunk_index: int,
    version: int,
    app_services: AppServices = Depends(services),
) -> JobDetailResponse:
    try:
        job = app_services.job_manager.get_job(job_id)
    except KeyError:
        raise HTTPException(404, "Job not found")

    job = app_services.job_manager.set_active_chunk_version(job_id, chunk_index, version)

    detail = job_to_detail(job)
    await app_services.hub.broadcast(
        WsEnvelope(type="job_updated", payload={"job": detail.model_dump()}).model_dump()
    )
    return JobDetailResponse(**detail.model_dump())
```

### Step 6 — Schema update (`server/app/schemas/api.py`)

Add `version` field to `ChunkResponse`:
```python
class ChunkResponse(BaseModel):
    index: int
    status: str
    duration_seconds: float
    start_seconds: float
    plan_version: int
    version: int = 0
    voice_id: str
    segment_url: str | None
    deprecated: bool = False
    reprocessing: bool = False
```

Update `chunk_to_response()` to populate `deprecated`, `reprocessing`, and `version` from `ChunkRecord`.

### Step 7 — Frontend API types (`web/src/types/api.ts`)

Add to `Chunk` interface:
```typescript
export interface Chunk {
  index: number;
  status: ChunkStatus;
  duration_seconds: number;
  start_seconds: number;
  plan_version: number;
  version: number;
  voice_id: string;
  segment_url: string | null;
  deprecated: boolean;
  reprocessing: boolean;
}
```

### Step 8 — Frontend API functions (`web/src/lib/api.ts`)

```typescript
/** Reprocess a specific chunk, optionally with new text/voice. */
reprocessChunk: (jobId: string, chunkIndex: number, options?: {
  new_text?: string;
  new_voice_id?: string;
}) =>
  request<JobDetail>(apiPath(`/jobs/${jobId}/chunks/${chunkIndex}/reprocess`), {
    method: "POST",
    body: JSON.stringify(options ?? {}),
  }),

/** Set the active version for a chunk index. */
setActiveVersion: (jobId: string, chunkIndex: number, version: number) =>
  request<JobDetail>(apiPath(`/jobs/${jobId}/chunks/${chunkIndex}/set-active-version`), {
    method: "POST",
    body: JSON.stringify({ version }),
  }),
```

### Step 9 — ReaderPage major rewrite (`web/src/features/reader/ReaderPage.tsx`)

**New state variables (local):**
```typescript
const [activeVersions, setActiveVersions] = useState<Map<number, number>>(new Map());
const [editingChunkIndex, setEditingChunkIndex] = useState<number | null>(null);
const [editText, setEditText] = useState("");
const [reprocessingChunkIndex, setReprocessingChunkIndex] = useState<number | null>(null);
const [reprocessError, setReprocessError] = useState<string | null>(null);
```

**Active version derivation from job data:**
When `job` or `manifest` updates, compute `activeVersions` from `job.active_chunk_version` if available, falling back to highest version per index.

**Chunk detail panel redesign** — the existing box showing "Chunk 9 / Status: active / 28.6s ready" becomes a richer card:

```
┌─────────────────────────────────────┐
│ Chunk 9                            ▼│  ← version dropdown (V1, V2, V3)
│                                     │
│ The quick brown fox... [Edit]       │  ← truncated text + edit button
│                                     │
│ [Reprocess] [Retry 1/3]            │  ← reprocess button (with retry count)
│                                     │
│ Status: active • 28.6s ready        │
└─────────────────────────────────────┘
```

When "Edit" is clicked, the text area expands:
```
┌─────────────────────────────────────┐
│ Chunk 9                            ▼│
│                                     │
│ ┌───────────────────────────────┐   │
│ │ The quick brown fox jumped... │   │  ← inline textarea
│ └───────────────────────────────┘   │
│ [Save & Reprocess] [Cancel]         │
└─────────────────────────────────────┘
```

**Text computation** — derive chunk text from `job.source_text.slice(chunk.char_start, chunk.char_end)` using the existing `char_start`/`char_end` fields.

**Reprocess handler:**
```typescript
const handleReprocess = useCallback(async (chunkIndex: number, newText?: string) => {
  if (!job) return;
  try {
    setReprocessingChunkIndex(chunkIndex);
    setReprocessError(null);
    const nextJob = await api.reprocessChunk(job.id, chunkIndex, {
      new_text: newText,
      new_voice_id: undefined, // could allow voice change too
    });
    setJob(nextJob);
    setManifest((prev) => buildManifestFromEvent(nextJob, prev));
    // Refresh after a short delay to catch the first scheduler update
    setTimeout(() => refreshReaderState("reprocess"), 1000);
  } catch (err) {
    setReprocessError(err instanceof Error ? err.message : "Reprocessing failed");
  } finally {
    setReprocessingChunkIndex(null);
    setEditingChunkIndex(null);
  }
}, [job, refreshReaderState]);
```

**Version dropdown handler:**
```typescript
const handleVersionChange = useCallback(async (chunkIndex: number, version: number) => {
  if (!job) return;
  try {
    const nextJob = await api.setActiveVersion(job.id, chunkIndex, version);
    setJob(nextJob);
    setManifest((prev) => buildManifestFromEvent(nextJob, prev));
  } catch (err) {
    setError(err instanceof Error ? err.message : "Version switch failed");
  }
}, [job]);
```

**Timeline rendering changes:**
- For each timeline slot, resolve the **active version** of the chunk
- If the active version has status `PLANNED`/`QUEUED`/`REPROCESSING`, show grey background with a reload icon (⏎ or a refresh SVG)
- If a chunk has `reprocessing === true` (new version being rendered), show the reload icon on its timeline slot
- When a `chunk_ready` event arrives for a chunk index, check if it's a newer version — if so, auto-switch the active version and refresh
- Deprecated chunks show as dimmed if clicked but allow version switch

**Auto-switch on chunk_ready:**
In the WebSocket event handler, when a `chunk_ready` event arrives:
```typescript
if (lastEvent.type === "chunk_ready" && payload?.chunk_index !== undefined) {
  const chunkIndex = payload.chunk_index;
  // The new version is now ready — auto-switch to it
  setActiveVersions(prev => {
    const next = new Map(prev);
    // Set the active version to this chunk's version (it's the latest)
    next.set(chunkIndex, next.get(chunkIndex) ?? 0);
    return next;
  });
}
```

**Status text in detail panel:**
- `active` → current version is playing/active
- `ready` → current version is ready, not playing
- `reprocessing` → new version being rendered (reload icon in timeline too)
- `failed` → current version failed
- `deprecated` → this version is superseded (shown in dropdown context)
- `max retries exceeded` → 3 retries used up, show as failed with message

**Timeline slot styling for reprocessing:**
- Use a subtle animation (pulsing green-grey) for the reload icon
- Grey background when playhead hasn't reached it
- Accent color background when playhead is on/through it
- The reload icon is a small `↻` or SVG refresh icon in the top-right corner of the slot

### Step 10 — Edge cases & polish

- **Max retries (3)**: When `latest_version >= 3` on the server, return 409. Frontend shows "Max retries exceeded (3/3)" in red with no reprocess button.
- **Reprocess on failed chunk**: Creates a fresh PLANNED version; old FAILED chunk stays as historical record.
- **Reprocess on written chunk**: Creates PLANNED version; old WRITTEN chunk stays as fallback. User can switch back via dropdown.
- **Job revival**: When reprocessing a completed job, the `reactivate_job()` call changes status to QUEUED. The WebSocket broadcasts `job_updated`. When all reprocessed chunks finish, `mark_chunk_written()` sets status back to COMPLETED.
- **Timeline click on reprocessing chunk**: If the active version is ready, play it. If it's reprocessing, allow version switch via dropdown. If failed, show error but allow reprocess (if under retry limit).
- **Edit text with original ranges**: Use `char_start`/`char_end` from the chunk to extract the text range from `job.source_text` for the edit field. Send the edited text to the server as `new_text`.

---

## Verification

1. **Happy path reprocess**: Create a job with text, wait for a chunk to render. Click "Reprocess" on a ready chunk. Verify: new version appears, reload icon shows in timeline, old version still playable via dropdown.
2. **Failed chunk retry**: Trigger a failed chunk (or simulate). Reprocess it. Verify: new version renders, job status stays in-progress.
3. **Text edit**: Click edit on a chunk, change text, save. Verify: new version renders with new text, old version preserved.
4. **Version switching**: Reprocess a chunk twice. Use dropdown to switch between V1, V2, V3. Verify: each version plays its own audio, timeline shows correct active version.
5. **Completed job revival**: Complete a job. Click reprocess on a chunk. Verify: job goes back to QUEUED, reprocessing starts, returns to COMPLETED when done.
6. **Max retries**: Reprocess a chunk 4 times. Verify: 4th attempt is rejected, UI shows "Max retries (3/3)".
7. **WebSocket sync**: Reprocess while WebSocket is connected. Verify: UI updates in real-time without polling.
8. **Auto-switch**: Reprocess a chunk and wait for the new version to render. Verify: the new version auto-selects in the dropdown.
