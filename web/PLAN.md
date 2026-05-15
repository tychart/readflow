# ReadFlow Frontend — Refactoring Plan

## Context

ReadFlow is a batched long-form TTS narration app with a real-time media player using the Media Source Extensions (MSE) API. The frontend currently has three classes of problems:

1. **Structural**: Monolithic components and hooks that do too much, a store that owns business logic, and types that are unsafe at the network boundary.
2. **Architectural**: The WebSocket model (global singleton broadcast) and the store (flat array of jobs) are fundamentally incompatible with the planned per-user auth model. Jobs will become scoped to users, WebSocket connections need per-user routing, and every API call needs an auth token.
3. **Quality**: No error boundaries, fragile test isolation via prototype mutation, type assertions throughout `WsEnvelope` handling, and an absence of runtime validation at the network boundary.

This plan re-architects the frontend from the ground up so that it is **correct today** and **ready for auth tomorrow**, with testing woven into every phase so that nothing breaks.

---

## Auth Readiness — Design Decisions Made Now

### 1. Every API call will carry a token

The `api` module is the natural place to inject auth headers. We will:

- Define an `ApiClientConfig` type with an optional `getToken(): string | null` accessor.
- Make `api.ts` accept this config (injected at bootstrap, not at import time).
- When `getToken()` returns `null`, behave exactly as today. When it returns a token, attach `Authorization: Bearer <token>` to every request.

This is zero-cost when there's no auth, and adds one header when there is. **No other file needs to know about auth.**

### 2. The WebSocket connection needs to carry auth context

The current `live-client.ts` singleton connects to a global broadcast hub. With auth, the WebSocket URL will include a token and the server will route messages per-user.

We will refactor `LiveClient` into a **hook-based subscription** (`useLiveEvents`) that:
- Takes an optional `authToken: string | null` parameter.
- Passes the token in the WebSocket URL (query parameter or header).
- Manages lifecycle through React effects, not manual `retain()`/`release()`.
- Connects only when the auth state is available (or connects anonymously until auth resolves).

### 3. The store will become user-scoped

Currently `AppStore.jobs` is a flat array of all jobs. With auth, it must be scoped to the current user.

We will **normalize jobs to a `Record<string, JobSummary>`** in the store. This:
- Makes upsert O(1) instead of O(n) (fixes the current `upsertJob` filter).
- Makes it trivial to scope to a user: the auth layer will reset the jobs map on user switch.
- Allows the future addition of multiple user contexts without store duplication.

The store will also gain an `auth` slice:
```typescript
auth: {
  isAuthenticated: boolean;
  user: User | null;
  token: string | null;
  isLoading: boolean;
}
```

### 4. WebSocket envelope payloads will be typed

The server's `WsEnvelope` uses `payload: dict[str, object]`. The frontend currently mirrors this with `payload: Record<string, unknown>`, forcing runtime type assertions.

We will define a **discriminated union** on the frontend that matches the server's types exactly:

```typescript
type WsEnvelope =
  | { type: "job_created"; payload: { job: JobDetail } }
  | { type: "job_updated"; payload: { job: JobDetail } }
  | { type: "job_completed"; payload: { job: JobDetail } }
  | { type: "chunk_ready"; payload: { job: JobDetail; chunk_index: number } }
  | { type: "scheduler_state"; payload: SchedulerState }
  | { type: "model_state"; payload: { state: string } }
  | { type: "telemetry"; payload: { telemetry: TelemetrySnapshot } }
  | { type: "admin_config_updated"; payload: AdminConfig }
  | { type: "pong"; payload: null }
```

This eliminates every `as AdminState["telemetry"]` cast in `store.ts`.

### 5. Protected routes via React Router

We will add route guards:
```tsx
<ProtectedRoute requireAuth><ReaderPage /></ProtectedRoute>
<ProtectedRoute requireAdmin><AdminPage /></ProtectedRoute>
```

The guard will check `store.auth.isAuthenticated` (and `store.auth.user?.role === 'admin'` for admin routes) and redirect to login if needed.

---

## Phase 0: Foundation (Types, Validation, API Layer)

**Goal**: Fix the type system and prepare the API layer for auth injection. **Tests: all existing tests must pass after each commit.**

### Step 0.1 — Define proper `WsEnvelope` discriminated union

**File**: `src/types/events.ts` (new)

Move from `Record<string, unknown>` payloads to a discriminated union that matches the server's `WsEnvelope` model exactly.

Define the payload types inline:
```typescript
interface JobDetailPayload { job: JobDetail; }
interface ChunkReadyPayload extends JobDetailPayload { chunk_index: number; }
interface TelemetryPayload { telemetry: AdminState["telemetry"]; }
interface ModelStatePayload { state: string; }
```

**Impact**: The store's `applyEvent` will now get type narrowing for free — no more `as` casts.

**Files changed**: `src/types/events.ts` (new), `src/types/api.ts` (update WsEnvelope import)

### Step 0.2 — Add zod validation at the network boundary

**File**: `src/lib/validators.ts` (new)

Add zod schemas for `WsEnvelope` payloads. The `live-client.ts` message handler will parse JSON, then validate with zod. On validation failure, store the error and skip processing — this is safer than silently applying wrong data.

```typescript
import { z } from "zod";

const WsEnvelopeSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("job_created"), payload: z.object({ job: z.any() }) }),
  // ... other variants
  z.object({ type: z.literal("pong"), payload: z.null() }),
]);

export function parseWsMessage(raw: string): z.infer<typeof WsEnvelopeSchema> | null {
  try {
    return WsEnvelopeSchema.parse(JSON.parse(raw));
  } catch {
    return null;
  }
}
```

**Files changed**: `src/lib/validators.ts` (new), `src/lib/live-client.ts` (use validator)

### Step 0.3 — Make the API module auth-ready

**File**: `src/lib/api.ts`

Add an `ApiClientConfig` and a `setApiClientConfig()` function:

```typescript
interface ApiClientConfig {
  getToken?: () => string | null;
}

let config: ApiClientConfig = {};

export function setApiClientConfig(cfg: ApiClientConfig) {
  config = cfg;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const token = config.getToken?.();
  const headers: Record<string, string> = {
    ...(init?.body instanceof FormData ? {} : { "Content-Type": "application/json" }),
    ...init?.headers,
    ...(token ? { "Authorization": `Bearer ${token}` } : {}),
  };
  // ... rest unchanged
}
```

This is zero-cost when `config.getToken` is undefined (current behavior).

**Files changed**: `src/lib/api.ts` (modify), `src/main.tsx` (call `setApiClientConfig` at bootstrap)

### Step 0.4 — Organize types into logical files

**File**: `src/types/player.ts` (new)

Move `PlayerState`, `AudioDiagnostics`, and related types from `types/api.ts` into `types/player.ts`.

**File**: `src/types/events.ts` (new, already covered in 0.1)

**Files changed**: `src/types/api.ts` (cleaned up), `src/types/player.ts` (new), `src/types/events.ts` (new)

### Step 0.5 — Update the store to use typed envelopes

**File**: `src/state/store.ts`

With the discriminated union from 0.1, remove all `as` type assertions:
```typescript
// BEFORE
telemetry: event.payload.telemetry as AdminState["telemetry"],
scheduler: event.payload as unknown as AdminState["scheduler"],

// AFTER (type narrowing is automatic)
telemetry: event.payload.telemetry,
scheduler: event.payload.scheduler,
```

Also normalize `jobs` to `Record<string, JobSummary>`:
```typescript
// State shape change
jobs: Record<string, JobSummary>;

// Update upsertJob
function upsertJob(jobs: Record<string, JobSummary>, nextJob: JobSummary): Record<string, JobSummary> {
  return { ...jobs, [nextJob.id]: toSummary(nextJob) };
}
```

This is a breaking change for any code that iterates `state.jobs` — update all consumers.

**Files changed**: `src/state/store.ts` (major refactor), `src/state/store.test.ts` (new test file)

### Step 0.6 — Fix `useAppBootstrap` for auth readiness

**File**: `src/hooks/useAppBootstrap.ts`

Change to accept an `authToken` parameter so the WebSocket URL can include it:
```typescript
export function useAppBootstrap(enabled: boolean, authToken?: string | null) {
  useEffect(() => {
    if (!enabled) return;
    liveClient.retain(authToken);
    return () => liveClient.release();
  }, [enabled, authToken]);
}
```

**Files changed**: `src/hooks/useAppBootstrap.ts` (modify)

---

## Phase 1: Split the Monoliths (Architecture)

**Goal**: Break the three largest files into focused, testable modules.

### Step 1.1 — Split `lib/live-client.ts` into transport layer

**New directory**: `src/lib/transport/`

Create three files:

#### `src/lib/transport/websocket-connection.ts` (new)
Low-level WebSocket lifecycle: connect, heartbeat, reconnect with backoff, stale detection. Pure class, no React dependencies. Exposes events (`open`, `message`, `close`, `error`) via a simple emitter pattern or callbacks.

#### `src/lib/transport/snapshot-sync.ts` (new)
Handles the snapshot fetch on connect/reconnect. Uses `Promise.allSettled` to handle partial failures:
```typescript
async function syncSnapshot(jobs: JobSummary[], fetchJobs: () => Promise<JobSummary[]>, fetchVoices: () => Promise<Voice[]>, fetchAdmin: () => Promise<AdminState>): Promise<{ jobs: JobSummary[]; voices: Voice[]; admin: AdminState | null }> {
  const [jobsResult, voicesResult, adminResult] = await Promise.allSettled([
    fetchJobs(),
    fetchVoices(),
    fetchAdmin(),
  ]);
  // Merge partial results, log failures
}
```

#### `src/lib/transport/live-subscription.ts` (new)
The retain/release manager. Takes a `WebSocketConnection` and `SnapshotSync`. Manages the subscription lifecycle. No React dependencies.

**Files changed**: `src/lib/live-client.ts` (remove), `src/lib/transport/websocket-connection.ts` (new), `src/lib/transport/snapshot-sync.ts` (new), `src/lib/transport/live-subscription.ts` (new)

### Step 1.2 — Convert `live-client.ts` singleton to a React hook

**File**: `src/hooks/useLiveEvents.ts` (new)

Replace the `liveClient.retain()`/`release()` pattern with a hook:
```typescript
export function useLiveEvents() {
  const connection = useWebSocketConnection({ authToken });
  const subscription = useLiveSubscription(connection);
  const dispatch = useAppStore(state => state.applyEvent);
  useEffect(() => {
    subscription.onMessage((envelope) => dispatch(envelope));
  }, [subscription, dispatch]);
  // Return status for UI
  return { status: subscription.status, lastMessageAt: ... };
}
```

This is testable: in tests, provide mock `useWebSocketConnection` and `useLiveSubscription`.

**Files changed**: `src/hooks/useLiveEvents.ts` (new), `src/hooks/useAppBootstrap.ts` (simplify to use useLiveEvents), `src/app/App.tsx` (use the hook), `src/features/admin/AdminPage.tsx` (use the hook), `src/features/reader/ReaderPage.tsx` (use the hook)

### Step 1.3 — Split `lib/media-source.ts`

**New directory**: `src/lib/player/`

#### `src/lib/player/mse-engine.ts` (new)
The MSE orchestration class. Handles:
- MediaSource creation and lifecycle
- SourceBuffer setup (sequence mode)
- Init segment fetching and appending
- Media chunk queue management
- `destroy()` for cleanup

```typescript
class MseEngine {
  mediaSource: MediaSource | null
  sourceBuffer: SourceBuffer | null
  async init(mimeType: string, initUrl: string)
  async appendChunk(chunk: QueuedChunk)
  async seek(target: number): number
  destroy()
  get bufferedEnd(): number
  get isReady(): boolean
}
```

#### `src/lib/player/playback-state.ts` (new)
The player state machine. Takes engine state + audio events + config and derives `PlayerState`:
```typescript
export function usePlaybackStateMachine(
  engine: MseEngineRef,
  playIntent: boolean,
  isTerminal: boolean,
): PlayerState
```

This effect has clean dependencies (engine ref + 2 booleans) instead of the current 16-dependency effect.

#### `src/lib/player/use-media-source-player.ts` (new)
Thin orchestrator hook that wires everything together:
```typescript
export function useMediaSourcePlayer(options) {
  const engine = useMseEngine(options);
  const playerState = usePlaybackStateMachine(engine, options.playIntent, options.isTerminal);
  // orchestrate: when playIntent changes, call engine methods
  // return combined interface
}
```

**Files changed**: `src/lib/media-source.ts` (refactor into 3 files)

### Step 1.4 — Split `ReaderPage.tsx` into focused components

#### `src/features/reader/use-reader-controller.ts` (new)
Owns all business logic:
- Job/manifest state (from WebSocket events + polling)
- `playIntent` → actual play/pause orchestration
- Voice switching
- Download logic
- Playback anchor management
- Timeline slot computation (derive from chunk data)

Returns a plain data object, no JSX.

#### `src/features/reader/use-reader-data.ts` (new)
Owns data fetching:
- Initial job+manifest fetch
- Polling fallback interval
- WebSocket reconciliation refresh
- Loading/error state

Returns `{ job, manifest, loading, error, refresh }`.

#### `src/features/reader/reader-timeline.tsx` (new)
Owns timeline rendering:
- Slot button rendering with duration-proportional flex
- Pointer-based seeking
- Slot hover/detail state
- Gap-aware coloring (missing, ready_after_gap, etc.)

#### `src/features/reader/reader-controls.tsx` (new)
Owns media controls:
- Play/pause button
- Download button (with states)
- Time display (`formatClock`)
- Voice selector
- Status badge

#### `src/features/reader/reader-diagnostics.tsx` (new)
Owns the diagnostics details panel.

#### `src/features/reader/ReaderPage.tsx` (modified)
Thin composition layer:
```typescript
export function ReaderPage() {
  const data = useReaderData(jobId);
  const controller = useReaderController(data);
  const player = useMediaSourcePlayer(controller.playerOptions);
  return (
    <div>
      <ReaderHeader {...data} />
      <ReaderControls {...controller} {...player} />
      <ReaderTimeline {...controller} {...player} />
      <ReaderDiagnostics {...controller} {...player} />
    </div>
  );
}
```

**Files changed**: `src/features/reader/ReaderPage.tsx` (reduce to ~50 lines), `src/features/reader/use-reader-controller.ts` (new), `src/features/reader/use-reader-data.ts` (new), `src/features/reader/reader-timeline.tsx` (new), `src/features/reader/reader-controls.tsx` (new), `src/features/reader/reader-diagnostics.tsx` (new)

---

## Phase 2: Error Boundaries & Robustness

### Step 2.1 — Add ErrorBoundary

**File**: `src/app/ErrorBoundary.tsx` (new)

Standard error boundary with retry:
```typescript
class ErrorBoundary extends React.Component<
  { children: React.ReactNode; fallback?: React.ReactNode },
  { hasError: boolean; error: Error | null }
> {
  // ... standard boundary implementation
}
```

Wrap the app in `main.tsx`:
```typescript
<BrowserRouter>
  <ErrorBoundary>
    <Shell />
  </ErrorBoundary>
</BrowserRouter>
```

**Files changed**: `src/app/ErrorBoundary.tsx` (new), `src/main.tsx` (wrap), `src/app/App.tsx` (no change needed — Shell is inside boundary)

### Step 2.2 — Add React.memo to presentational components

Add `React.memo` to:
- `ConnectionBadge` in `App.tsx`
- `StatusBadge` in `JobsPage.tsx`
- Timeline slot buttons in `reader-timeline.tsx`

### Step 2.3 — Fix the `void` in onClick handlers

In `ReaderPage.tsx` (or `reader-controls.tsx` after split):
```typescript
// BEFORE
onClick={() => void (playIntent ? handlePause() : handlePlay())}

// AFTER — let the framework handle async
onClick={async () => {
  if (playIntent) await handlePause();
  else await handlePlay();
}}
```

---

## Phase 3: Testing Infrastructure

### Step 3.1 — Create test utilities

**Directory**: `src/test/`

#### `src/test/mocks.ts` (new)
Proper mock factories:
```typescript
export function mockFetch(routes: Record<string, ResponseFactory>): typeof fetch
export function mockWebSocket(events: WebSocketEventSequence): typeof WebSocket
export function resetMocks(): void
```

#### `src/test/factories.ts` (new)
Factory functions for test data:
```typescript
export function buildJob(overrides?: Partial<JobDetail>): JobDetail
export function buildChunk(overrides?: Partial<Chunk>): Chunk
export function buildManifest(chunkIndexes?: number[]): JobManifest
export function seedStore(overrides?: Partial<UseAppStore>): void
```

#### `src/test/setup.ts` (modify existing `setupTests.ts`)
Replace global prototype mutations with per-test isolation:
```typescript
import { afterAll, beforeAll, vi } from "vitest";

// Safe MediaSource mock that doesn't leak
beforeAll(() => {
  // ... install MediaSource mock
});

afterAll(() => {
  // ... restore everything
});
```

### Step 3.2 — Update existing tests

- **`App.test.tsx`**: Use `mockFetch` instead of `global.fetch` directly.
- **`ReaderPage.test.tsx`**: Mock the `api` module instead of raw `fetch` for better isolation.
- **`media-source.test.tsx`**: Use the new factory functions.
- **`AdminPage.test.tsx`**: Use `seedStore` from factories.

### Step 3.3 — Add new tests

- **`src/state/store.test.ts`**: Test the new normalized store, event application, and auth slice.
- **`src/lib/transport/websocket-connection.test.ts`**: Test connect/reconnect/stale logic.
- **`src/lib/player/mse-engine.test.ts`**: Test init, append, seek, destroy.
- **`src/features/reader/use-reader-controller.test.tsx`**: Test play/pause orchestration, voice switching.

---

## Phase 4: Auth Integration (Prep Only)

**Goal**: Wire up the auth infrastructure without adding actual auth logic. The code should be structured so that adding auth later is just configuration.

### Step 4.1 — Add auth store slice

**File**: `src/state/store.ts`

Add to the store:
```typescript
auth: {
  isAuthenticated: false;
  user: null;
  token: null;
  isLoading: false;
}
```

Add actions:
```typescript
setAuth: (auth: Partial<AppStore["auth"]>) => void
logout: () => void
```

### Step 4.2 — Wire auth into API client

**File**: `src/main.tsx`

```typescript
import { setApiClientConfig } from "./lib/api";

setApiClientConfig({
  getToken: () => useAppStore.getState().auth.token,
});
```

### Step 4.3 — Wire auth into WebSocket

**File**: `src/hooks/useLiveEvents.ts`

```typescript
export function useLiveEvents() {
  const token = useAppStore(state => state.auth.token);
  const connection = useWebSocketConnection({ authToken: token });
  // ...
}
```

### Step 4.4 — Add route guards

**File**: `src/app/ProtectedRoute.tsx` (new)

```typescript
export function ProtectedRoute({ children, requireAdmin = false }) {
  const { isAuthenticated, user } = useAppStore(state => state.auth);
  if (!isAuthenticated) return <Navigate to="/login" replace />;
  if (requireAdmin && user?.role !== "admin") return <Navigate to="/" replace />;
  return <>{children}</>;
}
```

**File**: `src/app/App.tsx`

```typescript
<Routes>
  <Route element={<ProtectedRoute><JobsPage /></ProtectedRoute>} path="/" />
  <Route element={<ProtectedRoute><ReaderPage /></ProtectedRoute>} path="/jobs/:jobId" />
  <Route element={<ProtectedRoute requireAdmin><AdminPage /></ProtectedRoute>} path="/admin" />
</Routes>
```

---

## Final File Structure

```
web/src/
  main.tsx                          # Bootstrap (calls setApiClientConfig)
  app/
    App.tsx                         # Router + Shell + ConnectionBadge
    App.test.tsx
    ErrorBoundary.tsx               # NEW — wrap entire app
    ProtectedRoute.tsx              # NEW — auth guard
  types/
    api.ts                          # API DTOs (cleaned up)
    events.ts                       # NEW — WsEnvelope discriminated union
    player.ts                       # NEW — PlayerState, AudioDiagnostics
  state/
    store.ts                        # — normalized, typed events, auth slice
    store.test.ts                   # NEW
  lib/
    api.ts                          # — auth-ready
    validators.ts                   # NEW — zod schemas
    transport/                      # NEW directory
      websocket-connection.ts       # — raw WS lifecycle
      snapshot-sync.ts              # — partial-failure-safe snapshot fetch
      live-subscription.ts          # — retain/release manager
    player/                         # NEW directory
      mse-engine.ts                 # — MSE lifecycle class
      playback-state.ts             # — player state machine hook
      use-media-source-player.ts    # — thin orchestrator
    timeline.ts                     # — unchanged
  hooks/
    useAppBootstrap.ts              # — simplified
    useLiveEvents.ts                # NEW — React hook wrapping transport
  test/                             # NEW directory
    mocks.ts                        # — fetch/WebSocket mocks
    factories.ts                    # — buildJob, buildChunk, etc.
    setup.ts                        # — safe prototype isolation
  features/
    jobs/
      JobsPage.tsx
      JobCreateForm.tsx
    reader/
      ReaderPage.tsx                # — ~50 lines, thin composition
      ReaderPage.test.tsx
      use-reader-controller.ts      # NEW — business logic
      use-reader-data.ts            # NEW — data fetching
      reader-timeline.tsx           # NEW — timeline UI
      reader-controls.tsx           # NEW — play/pause/download/voice
      reader-diagnostics.tsx        # NEW — diagnostics panel
    admin/
      AdminPage.tsx
  styles.css
```

---

## Testing Strategy — Sequential & Frequent

Every phase is self-contained and testable. The rule is: **each commit must have all tests passing**.

### Execution Order

1. **Phase 0 first** — Type changes are the lowest-risk foundation. After each step, run `npm run test` and `npm run typecheck`. The discriminated union alone fixes multiple bugs.

2. **Phase 1 second** — Refactor the three monoliths. Split `live-client.ts` first (easiest to test in isolation), then `media-source.ts` (has existing comprehensive tests), then `ReaderPage.tsx` (hardest, most tests). After each file split, verify tests pass.

3. **Phase 2 third** — Add error boundary and memo. Error boundary has its own test. Memo changes are trivial to verify visually and with tests.

4. **Phase 3 fourth** — Improve test infrastructure. Update existing tests to use new mocks/factories. Add new tests for the split modules.

5. **Phase 4 last** — Add auth scaffolding. The code should work identically without auth (token is `null` → no headers, anonymous WebSocket).

### Test Commands

```bash
# Quick feedback loop during development
npm run test          # vitest, watch mode
npm run typecheck     # TypeScript compilation check
npm run lint          # ESLint

# Full verification before committing
npm run build         # typecheck + Vite build
npm run test -- --run  # one-shot test run with coverage
```

### Test Coverage Expectations

| Module | Before | After Target |
|--------|--------|-------------|
| `state/store.ts` | tested via integration | Unit tests for each event handler, normalized store, auth slice |
| `lib/transport/*.ts` | not tested | Unit tests for reconnect logic, snapshot sync, subscription lifecycle |
| `lib/player/mse-engine.ts` | tested via media-source.test.tsx | Unit tests for init, append, seek, destroy |
| `lib/player/playback-state.ts` | tested via media-source.test.tsx | Unit tests for each state transition |
| `features/reader/use-reader-controller.ts` | tested via ReaderPage.test.tsx | Unit tests for play/pause orchestration, voice switching, download |
| `features/reader/reader-timeline.tsx` | tested via ReaderPage.test.tsx | Snapshot tests, click/seek interaction tests |
| `app/ErrorBoundary.tsx` | not tested | Test error capture, recovery, fallback rendering |

---

## Risk Mitigation

### Breaking changes are scoped

The only breaking change is the store's `jobs` shape (array → Record). This affects:
- `src/features/jobs/JobsPage.tsx` — iterate `Object.values(state.jobs)` instead of `state.jobs`
- `src/features/reader/ReaderPage.tsx` — same change
- `src/lib/live-client.ts` → `snapshot-sync.ts` — use `Object.values` for merge

All other changes are additive (new files). The `api.ts` interface is unchanged (same functions).

### No hacky workarounds

- No more `as` type assertions — discriminated union + zod validation replaces them.
- No more prototype mutation in tests — proper mock isolation.
- No more singleton classes with manual lifecycle — React hooks manage lifecycle through effects.
- No more 700-line components — clear separation of concerns.

### Auth is opt-in

Every auth change uses conditional logic:
- `api.ts`: `getToken()` returns `null` → no auth header (current behavior)
- `useLiveEvents`: `authToken` is `null` → connect without token (current behavior)
- `ProtectedRoute`: `isAuthenticated` is `false` → show login page (new page)

The app functions identically without auth configured.
