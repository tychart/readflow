# AGENTS.md

This file is the internal handoff document for future agents working in this repository.

When making modifications, these are what the user values:
- Building and fixing in the best practice possible way
- The user values long term maintainability and best practice archetecture
- Simplicity as much as possible, and maintainablity
- Best practice python code and best practice React and typescript

It is intentionally more operational and opinionated than `README.md`. Use it to understand:

- what the user asked for
- what was actually implemented
- which architectural decisions are intentional and should not be "cleaned up" casually
- how to test changes safely
- where the sharp edges are

If this file and the code disagree, the code is the source of truth. If this file and the original product brief disagree, prefer the implemented code plus the latest user instructions.

## Project Identity

Project name: `ReadFlow`

Purpose:

- long-form TTS web app
- single repo
- custom FastAPI backend
- custom React + TypeScript + Vite frontend
- official Qwen3-TTS backend usage
- optimized for a private single-machine setup
- one GPU, one loaded model, one synthesis loop, many queued jobs

Primary design goal order:

1. audio quality
2. keep listeners buffered
3. maintain aggregate throughput through batching
4. keep the system understandable and debuggable

This is **not** designed as a distributed inference platform.

## Non-Negotiable Product Decisions

These came directly from the user and should be preserved unless the user changes direction.

- Single repo with `server/` and `web/`
- No database
- No auth
- No accounts
- No Redis/Celery
- No distributed queue
- No multi-worker GPU contention
- No persistent jobs across restart
- No user-uploaded voices in v1
- No automatic transcription in v1
- No model switching mid-job in v1
- Backend owns chunking and scheduling
- Frontend stays thin and reactive
- Dynamic batching is core behavior, not a later optimization
- Browser-native media buffering via `MediaSource`/`SourceBuffer`
- Built-in server-side voices only
- VRAM should be releasable after idle timeout

## User Preferences That Matter to Future Agents

These are not generic repo facts; they are preferences the user explicitly emphasized during this conversation.

### 1. Tests must be treated as part of implementation

The user explicitly wants tests implemented and executed constantly during development.

Expected behavior for future agents:

- after meaningful backend changes, run targeted backend tests immediately
- after meaningful frontend changes, run targeted frontend tests immediately
- at natural checkpoints, run the fast combined verification path
- do not leave code untested when a relevant test path exists

Practical expectation:

- if you change scheduler/model/backend logic, rerun the affected server tests
- if you change media/playback/frontend behavior, rerun relevant frontend tests and likely Playwright smoke tests
- before calling a feature done, the fast suite should be green if possible

### 2. Be careful with `flash-attn`

The user explicitly warned that `flash-attn` compilation can take nearly an hour on their machine.

Do **not** casually change:

- `flash-attn` version
- Python/runtime assumptions that trigger rebuilds
- the server dependency layout in ways that force a reinstall

If changing the Qwen runtime stack is truly necessary, call that out clearly because it can impose a very expensive rebuild.

### 3. Use the official Qwen usage pattern the user already validated

The user provided working reference scripts outside the repo and explicitly asked that the app follow the same usage style rather than a generic or improvised integration.

That means future agents should preserve the current core Qwen call pattern:

- `Qwen3TTSModel.from_pretrained(...)`
- `create_voice_clone_prompt(ref_audio=..., ref_text=..., x_vector_only_mode=False)`
- `generate_voice_clone(text=[...], language=..., voice_clone_prompt=[...])`

Do not refactor the provider toward some different wrapper abstraction unless the user asks for that.

### 4. Prefer simple, stable playback fixes over clever browser-event guesswork

A lot of the recent work in this repo was about the custom streaming player. The user is explicitly fine with architectural changes during development if they make the system simpler and more reliable.

Practical implication for future agents:

- do not keep layering UI-only conditions on top of flaky media event behavior
- if playback state is wrong, fix it at the player/controller layer first
- treat user intent (`playIntent`) and actual media state as separate but synchronized concerns
- when the browser is inconsistent, prefer explicit local state transitions triggered by known user actions

The user cares more about a stable, debuggable implementation than preserving a previous abstraction.

## Current Architecture Snapshot

## Repo layout

```text
repo/
  server/
    app/
      api/
      chunking/
      core/
      jobs/
      media/
      scheduler/
      schemas/
      synthesis/
      telemetry/
      voices/
    tests/
    voices/
      suzy/
      howard/
    main.py
    pyproject.toml
  web/
    src/
      app/
      features/
      hooks/
      lib/
      state/
      types/
    e2e/
    bun.lock
    package.json
    vite.config.ts
    vitest.config.ts
  scripts/
    dev.sh
  .github/workflows/ci.yml
  Makefile
  package.json
  README.md
  AGENTS.md
```

Toolchain split — do not mix these up:

- **bun** owns every JS/TS task: `bun install`, `bun run <script>`, `bunx`, `web/bun.lock`.
  There is no `package-lock.json` and no root `node_modules`; the JS project is entirely in
  `web/`. The root `package.json` is a dependency-free alias file (`bun run dev` → `scripts/dev.sh`).
- **uv** owns every Python task: `uv sync`, `uv run`.
- Node is still required on PATH because the Vite/Vitest/Playwright binaries keep their
  `#!/usr/bin/env node` shebang, and `bun run` executes `node_modules/.bin/*` shims with Node
  by default (that is bun's documented behavior; `bun --bun run` forces bun's runtime instead).
  Playwright in particular requires Node. Do not "fix" this by adding `--bun` everywhere.

## Backend architecture

Key files:

- `server/app/core/app.py`
- `server/app/core/services.py`
- `server/app/core/hub.py` (WebSocketHub)
- `server/app/api/router.py`
- `server/app/scheduler/service.py`
- `server/app/synthesis/provider.py`
- `server/app/synthesis/model_manager.py`
- `server/app/synthesis/worker.py`
- `server/app/media/store.py`
- `server/app/media/mp4.py` (WAV → fragmented MP4 packaging)
- `server/app/voices/registry.py`

Core services:

- `JobManager`
- `ChunkPlanner`
- `SchedulerService`
- `ModelManager`
- `SynthesisWorker`
- `VoiceRegistry`
- `MediaStore`
- `TelemetryService`
- `WebSocketHub`

## Frontend architecture

Key files:

- `web/src/app/App.tsx`
- `web/src/features/jobs/JobsPage.tsx`
- `web/src/features/jobs/JobCreateForm.tsx`
- `web/src/features/reader/ReaderPage.tsx`
- `web/src/features/admin/AdminPage.tsx`
- `web/src/hooks/useAppBootstrap.ts`
- `web/src/lib/api.ts`
- `web/src/lib/transport.ts`
- `web/src/lib/media-source.ts`
- `web/src/state/store.ts`
- `web/src/types/api.ts`, `events.ts`, `player.ts`

Frontend stack:

- React 19
- TypeScript
- Vite
- Tailwind CSS v4
- Zustand
- bun as the package manager / script runner (Node runs the binaries; see the toolchain note above)

Test-config ownership (do not duplicate this):

- `web/vitest.config.ts` is the **only** place test config lives (`globals`, `setupFiles`,
  `css`, `include`/`exclude`, v8 coverage). Vitest prefers it over `vite.config.ts`.
- `web/vite.config.ts` must **not** contain a `test:` block. It used to, and it only
  typechecked under npm's hoisted layout because vitest's `declare module "vite"`
  augmentation happened to be in the program; under bun's layout the same file fails with
  `TS2769: 'test' does not exist in type 'UserConfigExport'`. `npm run typecheck` was green
  by accident, not by design.
- `web/package.json` scripts: `test` = vitest watch, `test:run` = one shot, `test:coverage`
  = `vitest run --coverage`. `@vitest/coverage-v8` is a devDependency because the coverage
  step could not run without it (it was missing, so `--coverage` errored).

## Reader / Player Architecture

This became one of the most iterated parts of the codebase. Future agents should understand the intended split before touching it.

Key files:

- `web/src/features/reader/ReaderPage.tsx` (orchestration: state, user intent, server sync)
- `web/src/features/reader/reader-model.ts` (pure: patch merging, version resolution, gap-aware playback model, slot states)
- `web/src/features/reader/reader-text.ts` + `ReaderText.tsx` (canonical-text layout + reader blocks)
- `web/src/features/reader/chunk-utils.ts` (chunk/version/status/text helpers, shared with the sidebar)
- `web/src/features/reader/transport.ts` (play-button label, spinner and status-pill rules)
- `web/src/features/reader/conveyor-physics.ts` (pure: conveyor gesture physics + layout)
- `web/src/lib/media-source.ts` (player hook: `<audio>`, `MediaSource`, append queue)
- `web/src/lib/waveform-timeline.ts` (pure: timeline geometry, bar math, slot peak selection)
- `web/src/components/WaveformSlot.tsx` (the shared waveform look, used by both bars)
- `web/src/components/WaveformTimeline.tsx` (whole-document overview bar)
- `web/src/components/ChunkConveyor.tsx` + `ReaderDock.tsx` (zoomed scrub strip; phone dock)
- `web/src/components/Playbar.tsx` + `TransportControls.tsx` + `PlaybackButtons.tsx`
- `web/src/components/ReaderSettingsMenu.tsx` + `web/src/state/reader-settings.ts`
- `web/src/hooks/useChunkWaveforms.ts`, `useElementWidth.ts`, `useMediaQuery.ts`, `usePlaybackShortcuts.ts`, `useReaderSettings.ts`
- `server/app/media/peaks.py`

Current architecture:

- `ReaderPage` owns reader-level state, user intent, timeline interactions, and server synchronization
- `reader-model.ts` holds the pure derivations so the tricky rules (patch merging, the contiguous rendered run, gap classification, slot states) are directly unit-testable instead of only through a mounted page
- `useMediaSourcePlayer` owns the hidden `<audio>` element, `MediaSource`, `SourceBuffer`, append queue, and low-level playback state
- the visible player is fully custom; the native audio controls are hidden

Important design rules:

- the browser keeps one appendable MSE stream per active job/anchor
- the custom UI should not depend solely on browser `waiting`/`ended` behavior to decide what the player is doing
- `playIntent` is user intent, not identical to "the browser is currently making sound"
- real playback state comes from the hook and must stay synchronized with the custom controls
- **the `<audio>` element is rendered in one stable wrapper for every reader state** (loading, error, loaded). `useMediaSourcePlayer` attaches its media event listeners from an effect guarded on the element existing, so a remount after loading silently drops `progress`/`seeking`/`playing` events for the rest of the session. This was a real bug: the element used to live only in the loaded branch, in a different tree shape, and got remounted once.

### Static waveform playbar (replaces the old live analyser)

The waveform is **static** — it never vibrates with playback. It is built from
backend-computed peaks, not live audio analysis.

How it works:

- `server/app/media/peaks.py` computes per-chunk max-amplitude peaks (256 bins,
  normalized per chunk) from the WAV during packaging and writes a small JSON
  file next to each `.m4s` segment
- each chunk response carries `peaks_url`, served by the router
- `useChunkWaveforms` fetches peaks per written chunk (keyed by `index:version`;
  reprocessing bumps the version and re-fetches) and exposes a
  `Map<chunkIndex, Float32Array>`
- `WaveformTimeline` renders thin pill bars at a px-based resolution that adapts
  to the container width; playback progress is the amber fill sweeping
  left-to-right as the playhead passes
- chunks without peaks yet (or unrendered) render a dim deterministic
  placeholder; missing/failed chunks keep the broken-signal pattern

Styling knobs (`BAR_WIDTH_PX`, `BAR_GAP_PX`, `MIN_BAR_HEIGHT`, …) live in a
single tunable constants block at the top of `WaveformTimeline.tsx`.

Do **not** reintroduce a live Web Audio analyser for the playbar visualization —
`useWaveformAnalyser.ts` was intentionally deleted. If playback visuals drift,
the fix belongs in the peaks pipeline or the timeline rendering, not in live
capture.

### Playhead coordinate rule (protect against a seek-position bug)

`WaveformTimeline` renders slots in **job-timeline coordinates** (0 = start of
the first slot). Its playhead prop (`playheadSeconds`) and playable-range prop
(`renderedDurationSeconds`) MUST be passed in those same coordinates.

The player's `currentTimeSeconds`/`renderedDurationSeconds` are
**stream-normalized** — the media stream resets to 0 at the playback anchor —
so they must be shifted by `anchorOffset` before reaching the timeline.
`ReaderPage` owns this conversion: `displayTimeSeconds` (clock + timeline
playhead) and `displayRenderedDurationSeconds` (timeline playhead maximum).

Historical bug this protects against: when a stream-normalized position leaked
into the timeline, any seek to a later chunk made the amber fill jump to the
beginning of the timeline and sweep from the left, because the playhead was
compared against wrong coordinates. Do not "fix" playhead drift by re-deriving
positions inside `WaveformTimeline`; the coordinate conversion belongs in
`ReaderPage`/`Playbar`.

Drag-seeking commits exactly one `onSeek` on pointer-up; while dragging, the
fill previews the pointer position via local `dragPreviewSeconds` (standard
scrubber behavior). Do not add per-pointer-move `onSeek` calls — that used to
trigger a backend activation HTTP call on every drag frame.

### Pending-seek ownership (player hook, not the reader)

Applying a timeline seek is owned by `useMediaSourcePlayer` via the
`pendingSeekSeconds` option (stream-normalized target) + `onSeekApplied`
callback. `ReaderPage` only converts the click position (original coords →
stream coords via `anchorOffset`) and clears its `seekOverride` state when the
hook reports the seek applied.

Historical bug this protects against: the seek application previously lived in
a `ReaderPage` effect that ran in the **same commit** as the player's
stream-reset effect (anchor change = stream rebuild). The reader's effect read
stale state from the old stream (primed + buffered), applied the seek against
the new, not-yet-opened MediaSource (clamped to 0), and consumed the pending
seek — so the first click on a different chunk always landed at the start of
that chunk, and only a second click landed at the real position.

The hook avoids this by gating the pending seek on `isStreamPrimedRef` /
`bufferedUntilRef`, which the stream-reset effect updates **synchronously**
(state closures are stale within the same effect flush; refs are not). The
pending-seek effect is defined after the stream-setup effect so it always runs
after the reset within a commit. Do not move seek application back into
`ReaderPage`; cross-component effect ordering cannot guarantee this.

While a seek is pending the stream is rebuilding and `currentTimeSeconds` is
stale (reset to 0 at the new anchor), so `ReaderPage` shows the seek target
itself as the display playhead (`displayTimeSeconds = seekOverride ??
currentTimeSeconds + anchorOffset`). Do not "simplify" that back to always
`currentTimeSeconds + anchorOffset` — it makes the fill snap to the start of
the anchored chunk on release and then jump to the seeked position once the
seek applies.

### Chunk jump controls, skip buttons and keyboard shortcuts

Navigating a book-sized job needs controls that do not depend on the top
playbar's resolution, so the reader adds three:

- **per-chunk jump button** in each block's header row (`ReaderText.tsx`). It is
always rendered for every chunk (low emphasis, brightening on hover/focus) and
replaced by a non-interactive now-playing marker on the chunk currently playing.
Clicking routes through the same `handleSeekToChunk` path as a timeline click, so
play/pause state is preserved and a paused reader is never activated.
- **−10s / +10s** flanking play/pause, from `usePlaybackShortcuts`'
`SKIP_STEP_SECONDS`. Skips clamp to `renderedDurationSeconds` via the pure
`skipTargetSeconds`, so skipping past the end lands on the last playable position
and lets the player enter its waiting state instead of seeking into silence.
- **page-wide keyboard shortcuts** (`usePlaybackShortcuts`), attached to `window`
by design: the reader should never require clicking the controls first. The map is
`Space`/`K` toggle, `←/→` ±10s, `Shift+←/→` ±5s, `↑/↓` ±30s, `J`/`L` ±10s.

Rules that are easy to break:

- `resolvePlaybackShortcut` is a pure function so the whole map is tested without
a DOM. Handlers are held in a ref and the listener attaches once — the reader
re-renders ~20x/s during playback and resubscribing per render would add/remove a
window listener at that rate.
- Keys are ignored inside text entry, form widgets and any `[role="dialog"]` layer
(the settings panel owns the keyboard while it is open). Nothing else is ignored.
- Space and the arrows are therefore captured page-wide, so **Space no longer
scrolls the text**. That was a deliberate trade: shortcuts are consistent
regardless of focus.
- `PlayButton`/`SkipButton` (`PlaybackButtons.tsx`) and `TransportControls` are
shared by the top playbar and the phone dock. The play button's action follows its
**label** (`showPauseIcon ? onPause : onPlay`), so clicking a buffering play button
cancels the pending play rather than firing another activate request.

### Reader settings

`web/src/state/reader-settings.ts` is a tiny external store (`useSyncExternalStore`)
persisted to `localStorage` under `readflow.reader-settings.v1`, consumed through
`web/src/hooks/useReaderSettings.ts`.

- These are device-local UI preferences, not job state, so they deliberately do
NOT live in the workspace `zustand` store or the backend (no database, no
accounts).
- `sanitizeReaderSettings` validates **field by field**, so one corrupt or
outdated value cannot reset everything else, and unreadable storage falls back to
defaults rather than breaking the reader.
- `resolveAnimatedMotion(mode, prefersReducedMotion)` is the single decision point
combining the user's override with the OS preference; `useReaderMotion()` is its
hook. Do not re-derive motion in a component.
- The panel is an anchored popover on desktop and a bottom sheet on phones, both
rendering one shared body. It uses native `input`s on purpose: the page-wide
shortcut handler leaves form controls alone, so radios/checkboxes keep their own
keyboard behaviour with no custom ARIA. Keep the label and the description
separate (`htmlFor` + `aria-describedby`) — wrapping both in one `<label>` made the
accessible name swallow the description.
- The gear lives in the playbar's top row, not the metadata row: the metadata row
fades out as the playbar compacts, and settings must stay reachable.

### Chunk conveyor (the sub playbar)

`web/src/components/ChunkConveyor.tsx` + `web/src/features/reader/conveyor-physics.ts`.

A **conveyor, not another timeline**: a fixed playhead marker sits at the
horizontal centre and the chunk track slides under it, so the strip's position IS
the timeline value being edited. This exists because the whole-document playbar
has no resolution on a phone.

Gesture contract (all of it pure and unit-tested in `conveyor-physics.ts`):

- drag the track 1:1 with the finger (**drag right = earlier audio**)
- a **tap** is not a drag: it moves the strip so the tapped point lands under the
playhead (`alignmentOffsetSeconds`, gated by `TAP_SLOP_PX`)
- a **flick** coasts with exponential friction, then an underdamped spring settles
it with a small overshoot. Touching during the glide cancels it and resumes the
drag.
- **playback is committed only when the strip is at rest and no pointer is down,
and only once per gesture.** Audio keeps playing throughout the scrub; only the
commit jumps. This is the whole point: audio never chases the finger and never
lands on a moving strip.
- `advanceConveyor` returns `restSeconds` exactly once, guarded by
`SettlingGesture.hasReportedRest`. Two bugs already came from getting this wrong:
the spring used to pull its *displacement* toward zero instead of pulling the
strip toward the commit target (so it settled at the drag position), and a settled
gesture re-reported rest on every subsequent frame.
- A fling stops at the **end of rendered audio**, not at the end of the document,
so it never overshoots into silence or needs a long snap-back. A deliberate *drag*
may be taken further and settles back.
- A **tap on a chunk that already has audio** may commit past the contiguous
rendered run (`allowsUnrenderedTarget`, set from the tapped slot's state via
`isRenderedState`), because that is an explicit request to go there — the same
thing a click on the main timeline does. Momentum never gets that allowance, and
a tap on a chunk with no audio clamps. `commitSeek` deliberately does NOT re-clamp
to rendered audio: the physics has already resolved the target, and clamping twice
is how the allowance got lost.
- Reduced motion drops the sliding, the inertia and the jiggle and advances one
chunk at a time instead.

Rendering rules:

- The track is one `translate3d` on a single element and the **only** thing that
animates: no layout changes per frame. The idle slide is smoothed by a 60ms linear
transform transition because the playhead prop only updates at ~20Hz; the
transition is switched off during a gesture so the track tracks the finger exactly.
- `touch-action: pan-y` so vertical page scrolling still works over the strip.
- The conveyor passes `interactive={false}` to `WaveformSlot`: gestures are handled
at strip level (it needs the tap position, not the slot), and nesting ARIA sliders
inside a slider is invalid. The chunk states are already exposed as real sliders by
the main timeline.
- Scale is duration-proportional at one global px/second from the average chunk
duration, so scroll speed is constant and a 30s chunk draws wider than a 3s one.
Do not re-derive priority or state in the conveyor; it consumes the same
`TimelineSlotData[]` as the main bar.

### Phone bottom dock

On phone widths (`(max-width: 767px)`) the transport and the conveyor move into
`ReaderDock.tsx`, fixed to the bottom in the thumb zone, and the top playbar keeps
the overview waveform, the clock and the settings gear (`showTransport={false}`).

- `useMediaQuery` takes an explicit `initiallyMatches` derived from
`window.innerWidth`, because jsdom reports every query as non-matching and the
first render would otherwise disagree with the CSS breakpoints.
- The dock adds `padding-bottom: env(safe-area-inset-bottom)` and the reader adds
bottom padding so the dock cannot cover the last text block.
- `ReaderSidebar` takes `overlayTogglePositionClassName` to lift its floating toggle
above the dock. Without it the two controls overlap on a phone.

### Two historical bugs worth protecting against

1. **Never define a component inside `ReaderPage`.** `ReaderContent` was once
   defined inline, giving it a new identity on every render; during playback
   the reader re-renders ~20×/s, so React unmounted/remounted the whole content
   subtree (including the sidebar toggle button) on every tick, swallowing
   clicks. It now lives at module scope and takes props. If you add a new
   sub-render, keep it a module-level component.

2. **A finished terminal job must converge to "ended" without a browser
   `ended` event.** MSE does not always fire `ended` at the end of the stream.
   `useMediaSourcePlayer.updatePlaybackState` reconciles this: for a terminal
   job whose playhead is frozen at the end of the fully-buffered stream
   (within `TERMINAL_END_EPSILON_SECONDS`), it pauses the audio and clears
   `isActuallyPlaying`/`isWaitingForData`, which lets `ReaderPage` reset
   `playIntent` and clears the stuck spinner. Do not gate this on extra UI
   conditions in `Playbar` — fix it in the player/controller layer.

### Gap-aware playback model

The frontend intentionally supports the backend finishing chunks out of order.

Implemented behavior:

- timeline can show later written chunks even if earlier chunks are still missing
- automatic playback only follows the contiguous written run from the current playback anchor
- if chunks `1,2,3,6` exist, normal playback stops after `3` and waits for `4`
- chunks `4` and `5` show as expected-but-missing
- chunk `6` shows as ready-after-gap, but is not auto-played
- clicking a later ready chunk is allowed and creates a new playback anchor

This is intentional. Do not "simplify" it back to auto-skipping gaps unless the user explicitly asks.

### Timeline rendering model

The user strongly preferred the more continuous-looking playbar over the earlier equal-width chunk-slot version.

Current visual behavior:

- written chunks use real duration-based sizing
- missing/unrendered chunks use fixed placeholder sizing
- the bar should still feel like one continuous timeline rather than a row of disconnected boxes
- seeking within a playable chunk is granular and based on exact click/drag position

If changing the playbar, preserve that overall feel unless the user asks for a redesign.

### Completed-job local playback rules

Completed jobs behave differently from in-progress jobs.

Implemented behavior:

- completed jobs are local-only from the reader's perspective
- play/pause/playback heartbeats should not keep talking to the backend for completed jobs
- download remains available
- local playback after completion still needs to keep the custom play/pause button honest

Important historical lesson:

- reaching the end of a completed job should be treated as a real ended/paused state
- if the user then seeks on the timeline, that explicit seek may need to re-arm local playback intent immediately rather than waiting for inconsistent browser follow-up events

If you see bugs where the hidden audio plays but the button still says `Play`, or where the button says `Pause` after ending, look at the synchronization between:

- terminal-job audio events in `ReaderPage`
- `playIntent`
- explicit timeline seek handlers

### Reader text rendering (canonical text + upcoming tail)

The reader renders blocks derived from the canonical text, never from the raw
paste:

- one block per planned chunk (these carry the active/played styling, the refs
  used for scroll sync, and the chunk numbers)
- one trailing dimmed block for text the planner has not reached yet

That trailing block is load-bearing. Chunk planning is deliberately lazy
(`_needs_more_planning` keeps only a few chunks ahead), so before it existed a
long paste looked truncated: the DOM simply stopped after the last planned chunk.
`buildReaderTextSegments` renders the whole tail when it is under
`FULL_TAIL_RENDER_CHARS` (200k chars — covers chapters) and a bounded
`UPCOMING_PREVIEW_CHARS` preview above that (covers books without building a
multi-megabyte DOM).

Keep the chunk blocks' `content-visibility: auto` — a book accumulates thousands
of blocks and offscreen layout is what makes them expensive.

`ReaderChunkBlock` is **memoized**, because playback re-renders the reader ~20x/s
while at most a couple of blocks change state per tick. This only works while its
props stay stable: `onRegisterChunkRef` and `onJump` must be `useCallback`s in
`ReaderPage`. `ReaderText.test.tsx` pins the DOM-node-identity contract, and
`ReaderPage.test.tsx` pins it end to end during playback.

Each block exposes `data-chunk-block={index}` and
`data-chunk-state="active|played|idle"`, which tests and e2e use instead of
matching Tailwind class strings.

## How the system works

High-level pipeline:

1. User creates a job from pasted text or `.txt` upload.
2. `JobManager` stores the source text and job state in memory.
3. `ChunkPlanner` lazily emits startup/safety/steady-state chunks.
4. `SchedulerService` ranks renderable chunks across all jobs.
5. `SynthesisWorker` requests a batch for one model/language/voice/length bucket.
6. `QwenProvider` loads the model if needed and performs batched synthesis.
7. `MediaStore` packages WAV output into fragmented MP4 AAC segments via `ffmpeg`.
8. Backend serves a manifest plus init/media segment URLs.
9. Frontend appends segments with `MediaSource`.
10. WebSocket events keep the jobs page, reader, and admin views live.

## Job, scheduler, and playback policy

Important behavior:

- jobs are containers; chunk tasks are what actually get scheduled
- paused jobs are excluded from future scheduling
- active listening jobs are prioritized above inactive queued jobs
- scheduling is buffer-aware
- per-job prebuffer is capped
- batch size is dynamic
- VRAM soft limit influences batch downshifting
- on OOM, worker records telemetry and retries with a smaller batch once

Current batch grouping dimensions:

- `model_id`
- `language`
- `voice_id`
- rough chunk length bucket

That `voice_id` grouping is deliberate. It was added to keep the real Qwen provider aligned with the user's proven benchmark pattern: one voice-clone prompt shape repeated across a batch.

## Long documents and canonical text

This app is expected to swallow whole chapters and whole books, so the text
pipeline has two invariants that must not be broken casually.

### 1. `Job.source_text` is canonical and normalized exactly once

`app/chunking/normalize.py::normalize_source_text` runs **once**, in
`JobManager.create_job`. It collapses `\r\n`, space/tab runs and 3+ newlines, and
strips the ends. Everything downstream assumes that:

- `ChunkPlanner` reads `job.source_text` as-is and never normalizes
- `ChunkRecord.char_start` / `char_end` are plain indices into that string
- the frontend slices it directly (no `normalizeText` in the client)

Normalizing per chunk (or per render) makes long documents quadratic: a 3 MiB
book re-filtered the whole text on every `plan_next` (~500 s of pure regex work)
and on every reader render. Do not add a second normalization call site.
`server/tests/unit/test_normalize.py`, the planner coverage test, and
`web/src/features/reader/versioning.test.ts` pin this split.

### 2. Size limits live in one setting

`READFLOW_MAX_SOURCE_BYTES` (default 64 MiB) bounds one job's source text and is
also used as the multipart part limit. `POST /api/jobs` parses its own form
(`read_job_form`) instead of using FastAPI `Form(...)`/`File(...)` parameters,
because those always parse with Starlette's 1 MiB `max_part_size` — that default
made a long *paste* fail (`400 Part exceeded maximum size of 1024KB.`) while the
identical `.txt` upload succeeded. Starlette rewrites its own part-size breach
into a 400 before the route sees it, so `read_job_form` translates that specific
message into a 413 that names the configured limit.

## Exact Qwen Integration Contract

This is one of the most important parts of the repo.

The current implementation in `server/app/synthesis/provider.py` is intentionally shaped around the user's working scripts.

### Model loading

Current real load path:

- model id: `Qwen/Qwen3-TTS-12Hz-0.6B-Base`
- `device_map="cuda:0"`
- `dtype=torch.bfloat16`
- `attn_implementation`: resolved at load time - `flash_attention_2` when `flash_attn` is installed,
  otherwise `sdpa` (SDPA fallback for development / non-CUDA machines)

The `attn_implementation` is resolved once via `_resolve_attn_implementation()` which attempts
an import of `flash_attn`. This makes the provider work without flash-attn on dev machines while
still using the fastest path in production containers.

### Voice prompt creation

Current prompt build path:

- `model.create_voice_clone_prompt(ref_audio=..., ref_text=..., x_vector_only_mode=False)`

Voice prompts are cached by `voice_id`.

### Batch generation

Current batch generation path:

- `model.generate_voice_clone(text=text_batch, language=language, voice_clone_prompt=prompt_batch)`

The provider intentionally requires:

- all chunks in a batch share one language
- all chunks in a batch share one voice
- prompt list shape follows the validated benchmark usage

If you change this behavior, do it only with clear justification and updated tests.

### Fake provider

The fake provider exists for fast deterministic tests and CI.

Do not remove it unless the user asks. It is a major part of the development/testing story.

## Voice System

Voice discovery is strict and folder-driven.

Voice folders must exist under:

- `server/voices/suzy`
- `server/voices/howard`

Each voice must contain:

- `ref.wav`
- `ref.txt`
- `meta.json`

The registry fails fast if:

- the voice directory is missing
- a required file is missing
- `ref.txt` is empty
- no voices are found

Important historical note:

- legacy `male_default` references were intentionally removed
- current built-in voices are `suzy` and `howard`

Do not reintroduce `male_default` into the public contract.

## Model Lifecycle Rules

Implemented via `ModelManager`.

States:

- `unloaded`
- `loading`
- `warm_idle`
- `busy`
- `evicting`

Important behavior:

- model loads lazily
- model can be manually warmed
- model can be manually evicted
- idle unload timeout defaults to 300 seconds
- unload clears live model refs and prompt cache, then runs GC and CUDA cache cleanup

This is important because reclaiming VRAM requires dropping live references, not just emptying cache.

## Media Delivery

Implemented via `MediaStore`.

Current media format:

- fragmented MP4
- AAC audio
- init segment plus `.m4s` media segments

Packaging path:

1. provider returns WAV bytes
2. temp WAV is written
3. `ffmpeg` converts WAV to fragmented MP4
4. MP4 is split into init/media segments
5. temp WAV/MP4 intermediates are deleted

Temp storage is under:

- `/tmp/<temp_dir_name>/jobs/<job-id>/chunks/`

There is no retention cleanup daemon yet.

## Frontend Behavior and Current Caveat

Frontend uses relative API URLs:

- `/api/...` (HTTP)
- `/api/ws` (WebSocket)

Transport layer: `web/src/lib/transport.ts` (HTTP client), `web/src/lib/live-client.ts` (WebSocket).

Dev-server behavior (this is the setup `scripts/dev.sh` relies on):

- `web/vite.config.ts` defines an HTTP proxy for `/api`
- `web/vite.config.ts` defines a WebSocket proxy for `/api/ws`
- both proxy to `http://127.0.0.1:8000`, so the ports are effectively fixed
- local dev is a same-origin frontend talking to the backend through Vite

Important caveat:

- if proxy behavior changes, remember that HTTP and WS proxying are both required
- do not "fix" WS problems by hardcoding backend URLs into the frontend runtime unless the user explicitly wants that
- the preferred architecture is relative frontend paths with proxy/reverse-proxy ownership of upstream routing

## Local dev entry point: `scripts/dev.sh`

The user asked for one command that runs the app locally during development, so this script —
not `uvicorn` by hand, not `bun run dev` — is the canonical local run path. Keep it that way
in docs and in any new tooling.

Shape: `start` (default) · `restart` · `stop` · `status` · `logs` · `test` · `test-e2e` ·
`lint` · `typecheck` · `help`, plus `--fake`/`--real`, `--no-server`, `--no-web`,
`--no-follow`, `--access-log`.

Design rules that are deliberate and easy to break:

- **Provider defaults to `qwen` (real).** `--fake` (or `DEV_PROVIDER=fake`) is the opt-in for
  fast, GPU-free runs; the env var is exported to the child process explicitly, so an
  inherited value cannot leak the other way.
- **Ports are hardcoded 8000/5173** and are *not* configurable on purpose: Vite's proxy
  target is compiled against 8000, so an `--api-port` flag would silently desynchronize the
  two halves. A busy port is reported (with `ss`-derived owner pid) and left alone.
- **Never kill by pattern.** Only pids this script recorded are signalled, and each child is
  started with `setsid` so `kill -TERM -<pid>` reaches `uv run` *and* the `uvicorn --reload`
  child. Process groups are why `stop` cannot take out an unrelated dev server.
- **`uv run` is used without `--no-sync` only when the venv has no flash-attn.** A sync prunes
  undeclared packages; if the user has a locally built `flash-attn` (≈1h rebuild) the script
  switches to `uv run --no-sync`. It also never syncs an existing `server/.venv` — only a
  missing one, with `--extra dev --extra utils`.
- **Signal handling is split.** `startup_signal` (installed before the first child) stops
  everything if the user interrupts during startup; `cleanup` (installed before `follow`)
  also removes the state file. `follow` backgrounds `tail -F` and `wait`s on it, because a
  foreground pipeline defers the trap until tail exits on its own — which never happens.
  An earlier version used a bare `wait` in cleanup, which hung forever once `tail` outlived
  the script's own signal.
- **Port probing uses `ss -ltnH "sport = :PORT"`,** not bash `/dev/tcp`: `/dev/tcp/::1/...`
  is not parseable and Vite happily binds IPv6-only (`[::1]`), which made a real listener look
  like a free port.
- Status output distinguishes "ours" (recorded pid) from "up but not started here" — the
  latter must never be presented as managed by the script.
- Logs live in `.dev-logs/` (gitignored) and are tailed with coloured `[api]`/`[web]`
  prefixes; `NO_COLOR=1` and non-TTY runs get plain output.

## Testing Strategy and Expectations

This repo was built with testing as a first-class requirement.

## Root commands

Use these first:

```bash
make test
make lint
make typecheck
make test-real-model
```

What they mean:

- `make test`: web tests + mocked server tests
- `make lint`: ESLint + Ruff lint + Ruff format check
- `make typecheck`: TypeScript + Pyright
- `make test-real-model`: opt-in real Qwen tests

## Server tests

Important files:

- `server/tests/conftest.py`
- `server/tests/integration/test_api.py`
- `server/tests/integration/test_real_model.py`
- `server/tests/unit/test_provider.py`
- `server/tests/unit/test_scheduler.py`
- `server/tests/unit/test_config.py`
- `server/tests/unit/test_voices.py`
- `server/tests/unit/test_jobs.py`
- `server/tests/unit/test_planner.py`

Note: `server/app/jobs/test_manager.py` and `server/app/jobs/test_models.py` are in-app test
modules (not in the pytest directory) — they test versioning and reprocessing logic.

Important testing decisions:

- normal tests force `READFLOW_TTS_PROVIDER=fake`
- normal tests force `READFLOW_SCHEDULER_AUTOSTART=false`
- real-model tests are gated behind `READFLOW_ENABLE_REAL_MODEL_TESTS=1`

### Important historical lesson: do not reintroduce `TestClient`

During this conversation, backend tests initially hung due to a bad interaction between the current stack and `FastAPI TestClient` / sync dependency execution / lifespan behavior under Python 3.13.

The fix was:

- build services inside the app lifespan
- make the router dependency `async def services()`
- use `httpx.AsyncClient` with `ASGITransport`
- use `app.router.lifespan_context(app)` directly in tests

This was not theoretical. It was found by reproducing hangs and tracing live stacks.

Future agents should preserve this test harness unless there is a very good reason to change it.

## Real-model tests

The real-model suite is intentionally small and gated.

It currently validates:

- real provider startup
- real prompt creation
- real batched synthesis
- app-level manifest and segment serving through the real provider path

Important operational note:

- the real-model suite will fail immediately if `torch.cuda.is_available()` is false in the launching shell
- that failure is expected and correct
- do not "fix" that by weakening validation unless the user explicitly asks

## CI

GitHub Actions currently runs:

- `web-ci`
- `server-ci`
- `e2e`

It does **not** run real GPU-backed model tests.

That is intentional.

## Commands Agents Should Commonly Use

### Install

```bash
make install        # bun install (web) + uv sync --extra dev --extra utils (server)
```

or per half:

```bash
cd web
bun install

cd server
uv sync --extra dev --extra utils
```

### Run the whole app (the normal path)

```bash
scripts/dev.sh              # api + web, real Qwen3-TTS provider
scripts/dev.sh --fake       # api + web, no model load, no GPU
scripts/dev.sh status|logs|restart|stop
```

### Run backend alone

```bash
cd server
uv run uvicorn main:app --reload --port 8000
```

### Run backend in fake mode

```bash
cd server
READFLOW_TTS_PROVIDER=fake uv run uvicorn main:app --reload --port 8000
```

### Run frontend alone

```bash
cd web
bun run dev
```

## Important Environment Variables

Current useful env vars:

- `READFLOW_TTS_PROVIDER=qwen|fake`
- `READFLOW_SCHEDULER_AUTOSTART=true|false`
- `READFLOW_TEMP_DIR_NAME=<name>`
- `READFLOW_VOICES_DIR=<relative path>`
- `READFLOW_MAX_SOURCE_BYTES=<bytes>` (default 64 MiB per job)

Runtime defaults live in:

- `server/app/core/config.py`

## Known Pitfalls

These are the main things future agents should know before making changes.

### 1. `flash-attn` rebuild cost is huge

This was explicitly called out by the user.

Do not casually perturb:

- Python version assumptions
- `flash-attn` pin
- build dependency configuration
- Qwen runtime dependency graph

**`flash-attn` is now an optional dependency (`[project.optional-dependencies] cuda`)**.
Normal `uv sync` does not pull it. The QwenProvider falls back to SDPA when it is absent.
This means daily development, testing, and CI do not trigger a flash-attn compile.

Production / GPU installs use either:
- `uv sync --extra cuda` on a compatible machine (GCC ≤ 14)
- `docker build -f server/Dockerfile` which compiles flash-attn inside a CUDA 12.8 + Ubuntu 24.04 container with GCC 13

The Docker build targets SM 86 (RTX 30xx) via `FLASH_ATTN_CUDA_ARCHS=86` to minimize compile time.
It only recompiles flash-attn when `pyproject.toml`, `uv.lock`, or the CUDA base image changes.

Fedora 44 ships GCC 15+, which CUDA 12.8 does not support — use the Docker build, not a native install.

Do not remove or significantly change `server/Dockerfile` without understanding:
- the builder stage uses `nvidia/cuda:12.8.1-devel-ubuntu24.04`
- `FLASH_ATTN_CUDA_ARCHS=86` pins compilation to Ampere
- The layer cache strategy means pyproject.toml/uv.lock changes are the only thing that triggers flash-attn rebuild

### 2. CUDA visibility can differ by shell/session

At one point in this conversation:

- mocked test/lint/typecheck all passed
- gated real-model tests failed
- the reason was simply `torch.cuda.is_available()` being `False` in that execution environment

Do not immediately assume the provider code is broken if real-model tests fail. Check CUDA visibility first.

### 3. WebSocket and transport ownership matter

The frontend transport layer went through several iterations.

Important lessons:

- keep frontend API and WS URLs relative (`/api/...`, `/api/ws`)
- let Vite or the eventual reverse proxy own upstream routing
- avoid hardcoded backend-origin fallbacks in frontend runtime code
- keep WebSocket connection ownership centralized rather than scattering socket lifecycles across components

If debugging WS issues, inspect:

- `web/vite.config.ts`
- `web/src/hooks/useAppBootstrap.ts`
- `web/src/lib/live-client.ts`

### 4. Runtime state is ephemeral

Jobs, telemetry, and runtime admin changes are in memory only.

Do not assume restart persistence.

### 5. Voice switching semantics are versioned and one-way

Voice changes affect future not-yet-started chunks only.

The implemented behavior is:

- bump `plan_version`
- mark queued/planned future chunks stale
- leave already written chunks alone

Do not mutate completed audio retroactively unless the user explicitly wants a new model.

### 6. Stream events carry summaries, not the document

`job_created` and per-chunk events (`chunk_ready`, `job_completed`) send
`JobSummaryResponse` only, and chunk events add a single `chunk` delta.
`activate`/`pause`/`resume` also return a summary. Full detail (with
`source_text` and the chunk list) comes from `GET /api/jobs/{job_id}` and from
`job_updated` events.

The frontend treats every streamed/returned job payload as a patch and merges it
over the detail it loaded over HTTP (`mergeJobPatch` / `buildManifestFromPatch`
in `ReaderPage.tsx`, `applyJobPatch` used by both the WS effect and the mutation
handlers). This exists because the previous shape re-sent the entire source text
and every chunk record on each event: streaming a book was O(chunks × book size)
of WebSocket traffic (~0.45 MiB per event measured on a 300 KB job; now ~1 KiB).
Do not put `source_text` or the full chunk list back into per-chunk events.

### 7. e2e fixtures must include `Chunk.version`

`ReaderPage` only renders chunks whose `version` matches the active version, and
`deriveActiveVersions` yields `undefined` for a chunk without one. Fixtures in
`web/e2e/smoke.spec.ts` that omit `version` therefore render an empty timeline
(that is what the "reader updates live" and gap-slot tests did before
`buildChunk` was introduced). Use the `buildChunk` helper when adding fixtures.

### 8. MSE/player bugs are often state-model bugs, not codec bugs

Recent playback bugs were often caused by stale or mismatched state, not by the media container itself.

Examples:

- waiting/loading UI not appearing because the hook only trusted browser media events
- completed-job seek/play button drift because local playback restarted without re-arming `playIntent`
- waiting state staying visible after completion because terminal transition cleanup was incomplete

Before assuming ffmpeg/MSE packaging is broken, inspect the interaction between:

- `playerState`
- `playIntent`
- `isWaitingForData`
- `isActuallyPlaying`
- `currentTimeSeconds`
- terminal/completed-job transitions

### 9. Reader settings persist, so tests must reset them

`reader-settings.ts` keeps a module-level cache and writes to `localStorage`. A
test that flips a toggle therefore leaks that layout into every later test in the
same file. `ReaderPage.test.tsx` calls `resetReaderSettings()` +
`invalidateReaderSettingsCache()` in `beforeEach` for exactly this reason. Add the
same reset to any new suite that mounts `ReaderPage`.

### 10. Playwright's `name` matching is substring-based

`getByRole("button", { name: "Play" })` also matches "Jump **play**back to chunk
3". Use `{ name: "Play", exact: true }` whenever a substring could collide — the
phone-dock test asserts a button count and would otherwise see six Play buttons.

### 11. Sibling stacking contexts hide the settings popover

The playbar's top row and metadata row are siblings. With both at `z-10` the
metadata row (later in the DOM) painted over the anchored settings popover, and
the Download button intercepted clicks on it. The top row is `z-20` for this
reason; a Playwright test caught it.

### 12. Test files are not typechecked by default

`web/package.json`'s `typecheck` runs `tsconfig.build.json`, which **excludes**
`src/**/*.test.ts(x)`. Nothing else typechecked them either, so a stale type
import (e.g. `TimelineSlotData` from a module that had stopped re-exporting it)
compiled fine and only failed at runtime — and a type-only import does not even
fail then, esbuild just strips it.

`bun run typecheck:tests` (`tsconfig.app.json`, which includes `src` and
`setupTests.ts`) closes the gap, but it currently reports **~97 pre-existing
errors** across 10 test files, so it is deliberately not wired into
`typecheck`/CI yet. The backlog is overwhelmingly two mechanical causes:

- `Cannot find name 'global'` (~38): the app tsconfig lists
  `types: ["vitest/globals"]`, so Node's globals are not in scope. Either add
  `"node"` to that list or switch the tests to `globalThis`.
- unsafe `as typeof fetch` casts on partial fetch mocks (~25): these need
  `as unknown as typeof fetch`.

The rest is fixture drift — stale `AdminConfig`/`ReaderSettings`/`AdminMemoryStats`
literals missing fields the types require. Fixing all of it is a worthwhile,
self-contained change: do it, wire `typecheck:tests` into `make typecheck` and CI,
and delete this note.

### 13. Do not nest ARIA sliders

The main timeline exposes each chunk as `role="slider"`. The conveyor handles
gestures at strip level and passes `interactive={false}` to `WaveformSlot`, which
drops the role, tab stop and pointer handlers. A second interactive slider list
inside the strip would be invalid ARIA and duplicate announcements.

## Current User-Facing Pages

Jobs page:

- create jobs from text or `.txt`
- view job list
- see status and chunk counts
- open reader view

Reader page:

- view source text
- play/pause, with −10s / +10s skip either side
- jump playback to any chunk straight from its block in the text
- a chunk conveyor (sub playbar) for thumb-sized scrubbing, draggable and flickable
- monitor buffer progress
- switch future voice
- inspect chunk statuses
- use a custom segmented timeline (the whole-document overview)
- support gap-aware playback and manual jump-to-later-ready chunks
- keyboard control anywhere on the page (see the shortcuts guide in reader settings)
- reader settings (motion, conveyor, jump buttons, window size) persisted per device
- a phone bottom dock with the transport and conveyor in the thumb zone
- allow download of rendered contiguous audio

Admin page:

- two tabs: **Overview** (config knobs, model warm/evict, telemetry, memory) and
  **Queue** (the live synthesis queue inspector)
- change runtime knobs
- warm model
- evict model
- inspect queue depth and model state
- view recent batch telemetry
- view model lifecycle state

### Admin Queue tab (`web/src/features/admin/QueueInspector.tsx`)

A read-only-plus-actions inspector over the scheduler's work queue, built to make
scheduler behavior debuggable, not just pretty.

- `GET /api/admin/queue` (`SchedulerService.queue_snapshot()`) returns one
  `QueueJobGroup` per job with that job's **full chunk lifecycle** — written,
  rendering, planned, failed, stale — plus `written_chunks`/`pending_chunks`/
  `failed_chunks`, `unplanned_chars` (source text the planner has not reached),
  and `chunks_truncated`. Pending chunks carry the scheduler's own
  `priority_band/label/reason` and `rank`; `is_pending` tells the UI which rows
  the scheduler can still act on. Never re-derive priority in the frontend.
- Important: for an **inactive** (not-playing) job the planner keeps only
  `inactive_job_ahead_chunks` chunks ready (default 1), so its queue is tiny by
  design and batches are single-chunk. Multi-chunk batches come from actively
  listening jobs (5 ahead) or several queued jobs. `inactive_job_ahead_chunks`
  is exposed in Admin → Overview so this can be tuned live.
- Rows are bounded server-side by `QUEUE_SNAPSHOT_CHUNK_LIMIT` (200/job); every
  pending chunk is always kept and the rest of the budget goes to the most
  recent history, with `chunks_truncated` set when history was dropped.
- The top of the tab also carries `active_batch` (currently `RENDERING` chunks,
  grouped by `(model_id, language, voice_id)`, `started_at = min(updated_at)`)
  and `next_batch` (the real next dispatch, from the shared
  `_select_next_batch` helper). The UI shows a "Rendering now" strip with
  elapsed time and an "Up next" strip, and marks rows with a "Next" tag.
- Selecting a chunk opens a detail panel with its text, priority reason (for
  pending chunks) or rendered duration (for written chunks), metadata, version
  switcher, pause/resume, and chunk reprocess (edit text + voice). All actions
  reuse existing endpoints. The panel is a fixed-width (400px) sticky aside that
  only renders while a chunk is selected and has a close (×) button that clears
  the selection. The outer grid uses `minmax(0,1fr) 400px` (and `min-w-0` on
  both columns) so the table flexes to full width when the panel is closed — do
  not go back to unconstrained `fr` columns, which let the wide table squeeze
  the panel.
- Live refresh is **push-driven, not polled**: the scheduler broadcasts a
  lightweight `scheduler_state` tick that includes `active_batch`, and the tab
  refetches the full queue only when that signature (`queue_depth` + active
  batch identity) changes. Full chunk text is never sent over the WebSocket.
  The scheduler emits one `scheduler_state` at batch start (in
  `_render_next_batch`) in addition to the end-of-tick one, so "rendering now"
  is observable while the batch is in flight.
- **`queue_snapshot()` must stay synchronous and provider-free.** It used to
  `await ModelManager.memory_stats()`, which on the real provider runs on the
  synthesis worker thread and therefore queued *behind the in-flight batch*: the
  endpoint took as long as the whole synthesis (the tab looked empty/stuck), and
  the `await` yielded the event loop mid-snapshot so chunks mutated between
  collection and serialization (`queue_depth: 0` next to a `written` chunk). It
  now builds the whole response in one event-loop turn and sizes the predicted
  `next_batch` without live VRAM figures (the real dispatch still applies the
  VRAM downshift in `_render_next_batch`). `test_queue_snapshot_never_calls_provider_memory_stats`
  and `test_admin_queue_does_not_depend_on_provider_memory_stats` pin this.

### Scheduler: partial batches are requeued (do not regress)

The worker retries an OOM with a smaller batch and returns fewer results than
the scheduler dispatched. `_render_next_batch` therefore zips
`batch`/`results` with `strict=False` and calls
`JobManager.mark_chunk_planned` on the leftovers. Previously a `strict=True`
zip raised inside `run_once` and could kill the scheduler loop, leaving the
dropped chunks stuck in `RENDERING`. The queue inspector surfaces this state, so
keep the requeue behavior intact.

## What Was Added During This Conversation

Future agents should know that the following were created or materially changed in this conversation:

- real Qwen provider implementation
- strict voice registry
- default real-provider runtime config
- exact Qwen model id and language defaults
- `howard` replacing old `male_default` contract
- server-side real-model test suite
- async `httpx`/ASGI server test harness
- root `README.md`
- current `Makefile` testing workflow
- Vite HTTP/WS proxy for same-origin local dev
- custom streaming reader/player with gap-aware playback
- static backend-computed waveform playbar (replaces the live Web Audio analyser)
- admin **Queue tab**: `GET /api/admin/queue` + `SchedulerService.queue_snapshot()`,
  per-job full chunk-lifecycle inspector (written/rendering/planned/failed +
  unplanned remainder) with active/next batch, priority reasons, version
  switching, and pause/resume/reprocess actions
- `inactive_job_ahead_chunks` exposed as a live Admin → Overview knob (default
  1); the queue inspector's "only one chunk" case is the intended lazy-planning
  behavior for non-playing jobs, not a bug
- scheduler partial-batch requeue fix (`mark_chunk_planned`, `zip(strict=False)`)
  so OOM-retry leftovers are retried instead of stuck in `RENDERING`
- server-side `.m4a` export for contiguous rendered audio
- completed-job local-only playback behavior
- long-document support: `READFLOW_MAX_SOURCE_BYTES` (64 MiB default) replaces
  Starlette's 1 MiB pasted-field limit, the source text is normalized once at
  job creation (`app/chunking/normalize.py`), planning no longer re-normalizes
  per chunk, the reader renders the unplanned tail as dimmed "Upcoming text",
  and per-chunk WebSocket events became summary + single-chunk deltas
- e2e smoke suite repaired (stale selectors and version-less chunk fixtures that
  had left 3 of 4 tests failing on `main`)
- bun-native toolchain (replacing npm repo-wide): `web/bun.lock` replaced
  `package-lock.json`, the root `package.json` lost its `concurrently`/`wait-on`
  dependencies (and the workspace), `web/package.json`'s `build` no longer shells out to
  `npm`, Makefile/CI/README/AGENTS all speak `bun`, and CI uses `oven-sh/setup-bun`
- `scripts/dev.sh`: one-command local stack (api + web, boxed status dashboard, coloured
  log prefixes, `--fake` toggle, `status`/`logs`/`restart`/`stop`, and wrapper commands for
  `make test|test-e2e|lint|typecheck`)
- `web/vite.config.ts` lost its redundant `test:` block, making `web/vitest.config.ts` the
  single source of truth for test config (this was a latent `npm`-only typecheck pass)
- `@vitest/coverage-v8` added as a devDependency — `vitest run --coverage` (and therefore
  CI's coverage step) previously failed with `Cannot find dependency '@vitest/coverage-v8'`

Newest round — reader navigation (four commits):

1. **Behavior-preserving refactor.** `ReaderPage.tsx` (1204 lines) split into
   `reader-model.ts` / `reader-text.ts` / `ReaderText.tsx` / `chunk-utils.ts`;
   `WaveformTimeline` split so the waveform look, the timeline geometry and the
   element-width measurement are reusable (`WaveformSlot.tsx`,
   `lib/waveform-timeline.ts`, `types/timeline.ts`, `hooks/useElementWidth.ts`).
   Test-integrity fixes: `versioning.test.ts` re-implemented ReaderPage's helpers
   in the test file and asserted three functions that existed nowhere in `src`;
   it was replaced with tests against the real modules. `timeline.ts` (dead since
   the timeline stopped seeking per chunk) was deleted. Two real bugs fixed: the
   version fallback picked the *first* chunk seen for an index instead of the
   highest, and the hook's media listeners never attached because `<audio>` was
   mounted only after the loading early-returns and got remounted.
2. **Chunk jump buttons, ±10s skip, page-wide shortcuts, reader settings.**
   Includes the settings store/popover, the shortcuts guide, and the shared
   `TransportControls`/`PlaybackButtons`.
3. **The chunk conveyor** — fixed-centre playhead strip with drag/tap/flick
   physics, commit-on-rest only, reduced-motion snapping.
4. **Phone bottom dock** plus the `useMediaQuery` hook, `transport.ts` state
   helpers and this documentation pass.

Test count over that round: 122 → 347 web unit/component tests, 4 → 8 Playwright
tests.

## Agent Workflow Checklist

When making changes, use this checklist.

### If you change backend business logic

- run targeted server tests first
- then run `make test`
- then `make lint`
- then `make typecheck`

### If you change frontend logic

- run targeted web tests first
- then run `make test`
- then `make lint`
- then `make typecheck`
- if playback/media behavior changed, also run `bun run test:e2e` in `web/`

### If you change Qwen/provider/model/runtime logic

- rerun provider and scheduler tests immediately
- rerun mocked server suite
- if CUDA is available in the current environment, rerun `make test-real-model`
- be explicit in your summary about whether real-model verification was actually executed

### If you touch dependency/runtime setup

- be extremely careful with `flash-attn`
- explain any change that could force a rebuild
- do not surprise the user with a long compile unless it is necessary
- keep the ownership split: bun for JS/TS (`web/bun.lock`), uv for Python (`server/uv.lock`)
- never add an implicit `uv sync`/`uv run` that prunes an existing venv — `scripts/dev.sh`
  already guards this, and `make install` is the explicit sync path

## Roadmap Direction

Likely next steps, unless the user changes direction:

1. persist jobs and chunk metadata
2. add temp media cleanup/retention
3. improve admin telemetry depth
4. continue hardening reader/player edge cases (the conveyor and phone dock are
   the newest surfaces; gesture feel and small-screen layouts are the likeliest
   places for the next bug)
5. expand deployment story for a single-host install (Docker is now in place)
6. add a better documented GPU validation workflow

## Bottom Line for Future Agents

If you only remember a few things, remember these:

- preserve the boring, centralized architecture
- keep backend scheduling/chunking logic on the server
- keep the frontend thin
- keep the official Qwen integration aligned with the user's validated scripts
- `flash-attn` is optional — provider falls back to SDPA when absent
- bun is the package manager for all JS/TS, uv for all Python; do not reintroduce npm
- `scripts/dev.sh` is the canonical way to run the app locally
- the Docker build (`server/Dockerfile`) is the canonical production path
- keep tests green and run them often
- do not undo the async server test harness without very good reason
