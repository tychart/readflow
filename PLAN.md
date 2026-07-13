# ReadFlow UI Redesign Plan

## Context

ReadFlow is a batched long-form TTS narration app. The current UI uses a warm cream palette (#F5EFE3) with serif display fonts and teal/terracotta accents — the default "warm indie" template. The redesign aims for:

- **Dark mode as default** — deep navy/midnight blue, with warm amber/gold accents like a reading lamp
- **Sleek, moody, premium** — like Spotify at night
- **Both polished and power-tool efficient** — smooth animations but dense data, keyboard-friendly
- **Light mode as secondary** — a mechanical inversion that respects the same design
- **Signature design element** — the narration chunk timeline becomes a waveform-style visual sequence

## Design System

### Color Palette (Dark Default)

| Role | Hex | Usage |
|---|---|---|
| Canvas | `#0b1120` | Page background — deep midnight blue |
| Surface | `#131b2f` | Panels, cards, elevated surfaces |
| Surface-raised | `#1b2640` | Hover states, active panels |
| Line | `rgba(255,255,255,0.06)` | Subtle borders, dividers |
| Ink-primary | `#f1f5f9` | Primary text |
| Ink-secondary | `#94a3b8` | Secondary/helper text |
| Amber | `#f59e0b` | Primary accent — active state, CTAs, play button, glow |
| Amber-soft | `rgba(245,158,11,0.15)` | Subtle amber glow on active elements |
| Emerald | `#22c55e` | Success states (completed, ready) |
| Rose | `#ef4444` | Error states, failed chunks |
| Slate | `#475569` | Muted UI elements, unplayed |

### Color Palette (Light Mode — secondary/mechanical inversion)

| Role | Hex | Notes |
|---|---|---|
| Canvas | `#f5f2ed` | Warm off-white |
| Surface | `#ffffff` | White panels with shadow |
| Ink-primary | `#1c1917` | Warm dark text |
| Amber | same `#f59e0b` | Keep accent for continuity |
| Line | `rgba(0,0,0,0.08)` | |

### Typography

System-native font stack, set via CSS custom properties so it's trivially swappable later:

```css
--font-ui: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
--font-mono: "SF Mono", "Cascadia Code", "Fira Code", monospace;
```

One unified type scale for headings, body, and UI — no separate display font. This keeps it clean, modern, and native-feeling like a premium reading/listening app.

### Layout Architecture

```
┌──────────────────────────────────────────────────────────┐
│  ▲ Persistent Playbar (always visible when active)       │
│  [▶]  [======◉=====waveform=====]  2:34 / 12:00  [⋮]   │
│  Full-width, extra granularity for seeking               │
├──────────────────────────────────────────────────────────┤
│  Header — Job title, connection badge, nav tabs          │
├───────────────────────┬──────────────────────────────────┤
│  Content area         │  Sidebar (contextual)            │
│  (scrollable)         │                                  │
│                       │                                  │
│  • Current chunk      │  • Voice selector                │
│    highlighted with   │  • Model info                    │
│    subtle amber glow  │  • Source text preview            │
│  • Previous dimmed    │  • Chunk detail                  │
│  • Upcoming normal    │                                  │
└───────────────────────┴──────────────────────────────────┘
```

### Signature Element: Waveform Timeline

Instead of the current row of colored boxes, each chunk renders as a **real audio waveform visualization**. An `AnalyserNode` is connected to the audio element (via `createMediaElementSource`). In a `requestAnimationFrame` loop, `getByteTimeDomainData()` is sampled at a configurable resolution (e.g. 128 bins per chunk). The timeline spans the full playbar width.

- **Active chunk**: Live waveform animating with the audio, glowing amber with a subtle pulsing playback indicator
- **Played chunks**: Captured waveform data rendered at reduced opacity
- **Future/ready chunks**: Subtle deterministic placeholder pattern (low-opacity bars based on chunk index hash)
- **Missing/failed chunks**: Broken waveform segments with rose tint, gaps visually apparent
- **Gaps after missing chunks**: Waveform shows the discontinuity

This approach uses real audio data, properly architected — the AnalyserNode pattern is the standard way to get browser audio visualization. The hook is ~30 lines, component is well-separated, and the architecture supports swapping in GPU-accelerated canvas rendering later if needed.

## Files to Modify

1. **`web/src/styles.css`** — Complete theme system (dark/light custom properties), remove cream palette, add Tailwind v4 dark variant, global body transitions for theme switching
2. **`web/src/app/App.tsx`** — New shell layout, theme-aware, restructured header with nav tabs (Jobs / Admin), connection badge, theme toggle
3. **`web/src/features/reader/ReaderPage.tsx`** — Integrate Playbar (with WaveformTimeline), chunk-content scroll-sync highlighting, restyled chunk detail panel
4. **`web/src/features/jobs/JobsPage.tsx`** — Restyle for dark theme, maintain queue + create form layout
5. **`web/src/features/jobs/JobCreateForm.tsx`** — Restyle form elements for dark theme
6. **`web/src/features/admin/AdminPage.tsx`** — Restyle dashboard cards, VRAM bars, model state badges for dark theme
7. **`web/src/main.tsx`** — Add theme initialization logic (read localStorage, apply class before React mount to avoid flash)

### New files to create (if needed)

- `web/src/components/Playbar.tsx` — Full-width playbar for ReaderPage (play/pause, time, waveform timeline, download)
- `web/src/components/WaveformTimeline.tsx` — The signature component. Renders per-chunk waveforms from captured/real data
- `web/src/components/ThemeToggle.tsx` — Dark/light toggle with moon/sun icon
- `web/src/hooks/useTheme.ts` — Theme state + localStorage persistence + `prefers-color-scheme` system detection
- `web/src/hooks/useWaveformAnalyser.ts` — Connects AnalyserNode to audio element, captures per-chunk time-domain data via rAF loop, exposes live + stored waveform arrays

## Reuse

- **Existing state management**: `useAppStore` (Zustand) — already has `websocketStatus`, `lastSocketMessageAt`, etc. for the connection badge. Will extend with `theme` preference.
- **Existing API calls**: `api.ts` — all REST endpoints remain unchanged.
- **Existing live client**: `live-client.ts` — WebSocket events remain unchanged.
- **Existing player**: `useMediaSourcePlayer` hook — playback logic stays, just the UI around it changes.
- **Existing timeline utilities**: `timeline.ts` with `calculateChunkSeekTargetSeconds` — seek math reused in the new timeline.

All work happens on a dedicated `redesign` branch, with frequent granular commits after each meaningful step so changes are reviewable and reversible.

## Steps

- [ ] **0. Create `redesign` branch** — `git checkout -b redesign`
- [ ] **1. Theme system** — Define dark/light CSS custom properties in `styles.css`. Use `@media (prefers-color-scheme)` + `.dark`/`.light` class on `<html>`. Create `useTheme.ts` hook with localStorage persistence, system detection, and no-flash initialization.
- [ ] **2. Theme initialization in main.tsx** — Sync localStorage → apply `html` class before React hydrates. Read preference synchronously to avoid flash.
- [ ] **3. Create ThemeToggle component** — Small accessible button (moon/sun icon) that cycles dark↔light, saves to localStorage.
- [ ] **4. Create useWaveformAnalyser hook** — Connects `AnalyserNode` via `createMediaElementSource(audioElement)`. Runs rAF loop sampling `getByteTimeDomainData()` at configurable bin count. Maintains a `Map<chunkIndex, Float32Array[]>` of captured waveform frames. Exposes: `liveWaveform`, `capturedWaveforms`, `isConnected`. Gracefully handles AnalyserNode disconnection/reconnection when source changes.
- [ ] **5. Create WaveformTimeline component** — The signature element. Renders per-chunk waveform bars from real captured data (or placeholder for future chunks). Full-width, interactive click/seek via pointer-down/move/up. States: played (dimmed stored waveform), playing (amber glow + live waveform animation), ready (subtle placeholder bars), missing (broken waveform, rose tint), failed (rose). Exposes `onSeek(index, seconds)` callback.
- [ ] **6. Create Playbar component** — Full-width bar in ReaderPage: play/pause button, WaveformTimeline, time display (current / total / played), download button, chunk counter. Orchestrates the waveform hook + timeline component. Keyboard shortcuts (space for play/pause, arrows for seek).
- [ ] **7. Restyle shell (App.tsx)** — Dark-theme header with nav tabs (Jobs / Admin), connection badge, theme toggle. Clean vertical rhythm. Remove old cream styling.
- [ ] **8. Restyle JobsPage** — Dark-theme queue cards, status badges with new color tokens, create form surface.
- [ ] **9. Restyle JobCreateForm** — Dark-theme inputs, selects, textareas, file dropzone. Amber accent for focus rings.
- [ ] **10. Restyle ReaderPage** — Connect Playbar at top. Content area with source text below — scroll-sync to highlight current chunk with subtle amber left-border glow. Restyled chunk detail panel (reprocessing, version selector, edit text).
- [ ] **11. Restyle AdminPage** — Dashboard cards, VRAM meters, model state badges, synthesis panel — all dark-theme. Amber accent for active model state.
- [ ] **12. Light mode polish** — Ensure light mode is a clean, readable inversion of the dark design. Test every page, every component.
- [ ] **13. Responsive & accessibility** — Breakpoints for tablet/mobile. Keyboard focus ring visible (amber outline). `prefers-reduced-motion` disables animations/transitions. Proper ARIA labels on playbar, timeline, theme toggle.

## Verification

1. Run `npm run dev` — app loads with dark navy default, no flash of wrong theme
2. Toggle theme — smooth transition to light mode, all pages render correctly
3. Create a job — form is readable in both modes
4. Navigate to reader — playbar is visible at top, waveform timeline renders, click/seek works
5. Scrolling content highlights current chunk section
6. Admin page — cards, bars, badges all themed correctly
7. Resize to mobile — layout stacks sensibly
8. `prefers-reduced-motion` — animations/transitions are disabled
9. `npm run typecheck` — TypeScript compiles with zero errors across the project
10. `npm run lint` — ESLint passes with no warnings or errors on changed files
11. `npm run test` — All Vitest unit and component tests pass
12. `npm run build` — Production Vite build succeeds with zero warnings

---

## Questions for User Feedback
