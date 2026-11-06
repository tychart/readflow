/**
 * App-level player state.
 *
 * The player lives above the router so listening survives navigation (browsing
 * the library should not stop a book). ReaderPage owns the *document*; this
 * store owns the media stream, playback intent and the derived player state.
 *
 * Inputs (job/stream/anchor/seek/playIntent) are written by the reader.
 * Outputs are mirrored from `useMediaSourcePlayer` by `PlayerProvider`.
 */

import { create } from "zustand";

import type { PlayerState } from "../lib/media-source";
import type { JobManifest } from "../types/api";

export interface PlayerJob {
  id: string;
  title: string | null;
  /** Terminal jobs play local audio only; no scheduler activation. */
  isTerminal: boolean;
  audioEpoch: number;
  folderId: string | null;
  nextJobId: string | null;
  previousJobId: string | null;
}

export interface AudioDiagnostics {
  paused: boolean;
  readyState: number;
  networkState: number;
  playbackRate: number;
}

export interface PlayerOutputs {
  currentTimeSeconds: number;
  renderedDurationSeconds: number;
  bufferedUntilSeconds: number;
  isActuallyPlaying: boolean;
  isWaitingForData: boolean;
  isLoadingAudio: boolean;
  isStreamPrimed: boolean;
  isReady: boolean;
  isAutoplayBlocked: boolean;
  playerState: PlayerState;
  playbackRate: number;
  lastPlayerError: string | null;
  appendedChunksCount: number;
  diagnostics: AudioDiagnostics;
}

const IDLE_DIAGNOSTICS: AudioDiagnostics = {
  paused: true,
  readyState: 0,
  networkState: 0,
  playbackRate: 1,
};

const IDLE_OUTPUTS: PlayerOutputs = {
  currentTimeSeconds: 0,
  renderedDurationSeconds: 0,
  bufferedUntilSeconds: 0,
  isActuallyPlaying: false,
  isWaitingForData: false,
  isLoadingAudio: false,
  isStreamPrimed: false,
  isReady: false,
  isAutoplayBlocked: false,
  playerState: "idle",
  playbackRate: 1,
  lastPlayerError: null,
  appendedChunksCount: 0,
  diagnostics: IDLE_DIAGNOSTICS,
};

/** Imperative player commands, registered by the provider that owns the hook. */
export interface PlayerControls {
  seekToSeconds(seconds: number): void;
  seekWithinBuffered(seconds: number): number | null;
  isSecondsLoaded(seconds: number): boolean;
  isSecondsBehindRetainedAudio(seconds: number): boolean;
  setPlaybackRate(rate: number): void;
  pausePlayback(): void;
  requestUserGesturePlay(): Promise<unknown>;
}

let controls: PlayerControls | null = null;

export function registerPlayerControls(next: PlayerControls | null): void {
  controls = next;
}

/** Test/reset hook: put the store back to its idle state. */
export function resetPlayerStore(): void {
  controls = null;
  usePlayerStore.setState({
    ...IDLE_OUTPUTS,
    job: null,
    manifest: null,
    anchorIndex: 0,
    anchorOffsetSeconds: 0,
    durationSeconds: 0,
    streamRestartKey: 0,
    pendingSeekJobSeconds: null,
    playIntent: false,
    lastSyncError: null,
  });
}

export function getPlayerControls(): PlayerControls | null {
  return controls;
}

interface PlayerStore extends PlayerOutputs {
  job: PlayerJob | null;
  manifest: JobManifest | null;
  anchorIndex: number;
  /** Job-timeline seconds at the start of the anchor chunk. */
  anchorOffsetSeconds: number;
  streamRestartKey: number;
  /** Seek target in job-timeline seconds, cleared when the player applies it. */
  pendingSeekJobSeconds: number | null;
  playIntent: boolean;
  lastSyncError: string | null;

  openJob(job: PlayerJob): void;
  /** Total known duration of the job timeline, for the mini-player's bar. */
  durationSeconds: number;
  setSource(source: {
    manifest: JobManifest | null;
    anchorIndex: number;
    anchorOffsetSeconds: number;
    durationSeconds: number;
  }): void;
  setAnchorIndex(index: number): void;
  restartStream(): void;
  requestSeek(jobSeconds: number | null): void;
  seekApplied(): void;
  setPlayIntent(intent: boolean): void;
  setPlaybackRate(rate: number): void;
  syncOutputs(outputs: Partial<PlayerOutputs>): void;
  setLastSyncError(error: string | null): void;
}

export const usePlayerStore = create<PlayerStore>((set) => ({
  ...IDLE_OUTPUTS,
  job: null,
  manifest: null,
  anchorIndex: 0,
  anchorOffsetSeconds: 0,
  durationSeconds: 0,
  streamRestartKey: 0,
  pendingSeekJobSeconds: null,
  playIntent: false,
  lastSyncError: null,

  openJob: (job) =>
    set((state) => {
      if (state.job?.id === job.id) {
        // Same job (a reader remount): keep the stream and the playhead, only
        // refresh metadata like terminal status and folder neighbours.
        return { job };
      }
      // Opening the *first* job keeps any intent the user has already
      // expressed (a click can land before the load effect flushes). Switching
      // from one job to another deliberately starts paused.
      const keepIntent = state.job === null ? state.playIntent : false;
      return {
        job,
        ...IDLE_OUTPUTS,
        manifest: null,
        anchorIndex: 0,
        anchorOffsetSeconds: 0,
        durationSeconds: 0,
        streamRestartKey: 0,
        pendingSeekJobSeconds: null,
        playIntent: keepIntent,
        lastSyncError: null,
      };
    }),

  setSource: ({
    manifest,
    anchorIndex,
    anchorOffsetSeconds,
    durationSeconds,
  }) =>
    set((state) => {
      if (
        state.manifest === manifest &&
        state.anchorIndex === anchorIndex &&
        state.anchorOffsetSeconds === anchorOffsetSeconds &&
        state.durationSeconds === durationSeconds
      ) {
        return state;
      }
      return {
        manifest,
        anchorIndex,
        anchorOffsetSeconds,
        durationSeconds,
      };
    }),

  setAnchorIndex: (anchorIndex) =>
    set((state) =>
      state.anchorIndex === anchorIndex ? state : { anchorIndex },
    ),

  restartStream: () =>
    set((state) => ({ streamRestartKey: state.streamRestartKey + 1 })),

  requestSeek: (jobSeconds) => set({ pendingSeekJobSeconds: jobSeconds }),

  seekApplied: () =>
    set((state) =>
      state.pendingSeekJobSeconds === null
        ? state
        : { pendingSeekJobSeconds: null },
    ),

  setPlayIntent: (playIntent) =>
    set((state) => (state.playIntent === playIntent ? state : { playIntent })),

  setPlaybackRate: (rate) => {
    controls?.setPlaybackRate(rate);
    set({ playbackRate: rate });
  },

  syncOutputs: (outputs) =>
    set((state) => {
      const next: Partial<PlayerOutputs> = {};
      let changed = false;
      for (const key of Object.keys(outputs) as (keyof PlayerOutputs)[]) {
        const value = outputs[key];
        if (value !== undefined && state[key] !== value) {
          (next as Record<string, unknown>)[key] = value;
          changed = true;
        }
      }
      return changed ? next : state;
    }),

  setLastSyncError: (lastSyncError) =>
    set((state) =>
      state.lastSyncError === lastSyncError ? state : { lastSyncError },
    ),
}));

/* ── Imperative helpers ────────────────────────────────────
 * Reader/mini-player event handlers call these instead of holding a reference
 * to the hook's functions. They no-op until the provider has registered its
 * controls (e.g. in a component test that mounts only a consumer).
 */

export function playerSeekToSeconds(seconds: number): void {
  getPlayerControls()?.seekToSeconds(seconds);
}

export function playerSeekWithinBuffered(seconds: number): number | null {
  return getPlayerControls()?.seekWithinBuffered(seconds) ?? null;
}

export function playerIsSecondsLoaded(seconds: number): boolean {
  return getPlayerControls()?.isSecondsLoaded(seconds) ?? false;
}

export function playerIsSecondsBehindRetainedAudio(seconds: number): boolean {
  return getPlayerControls()?.isSecondsBehindRetainedAudio(seconds) ?? false;
}

export function playerPause(): void {
  getPlayerControls()?.pausePlayback();
}

export async function playerRequestGesture(): Promise<void> {
  await getPlayerControls()?.requestUserGesturePlay();
}
