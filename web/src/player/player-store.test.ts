import { afterEach, describe, expect, it } from "vitest";

import { resetPlayerStore, usePlayerStore } from "./player-store";

const job = (id: string, title = id) => ({
  id,
  title,
  isTerminal: false,
  audioEpoch: 0,
  folderId: null,
  nextJobId: null,
  previousJobId: null,
});

afterEach(() => resetPlayerStore());

describe("player store", () => {
  it("keeps the stream and playhead when the same job is reopened", () => {
    const store = usePlayerStore.getState();
    store.openJob(job("a"));
    store.setSource({
      manifest: null,
      anchorIndex: 3,
      anchorOffsetSeconds: 12,
      durationSeconds: 40,
    });
    store.setPlayIntent(true);

    store.openJob({ ...job("a"), title: "Renamed", isTerminal: true });

    const next = usePlayerStore.getState();
    expect(next.job?.title).toBe("Renamed");
    expect(next.job?.isTerminal).toBe(true);
    expect(next.anchorIndex).toBe(3);
    expect(next.anchorOffsetSeconds).toBe(12);
    expect(next.durationSeconds).toBe(40);
    expect(next.playIntent).toBe(true);
  });

  it("switching jobs starts paused with a fresh stream", () => {
    const store = usePlayerStore.getState();
    store.openJob(job("a"));
    store.setSource({
      manifest: null,
      anchorIndex: 3,
      anchorOffsetSeconds: 12,
      durationSeconds: 40,
    });
    store.setPlayIntent(true);

    store.openJob(job("b"));

    const next = usePlayerStore.getState();
    expect(next.job?.id).toBe("b");
    expect(next.anchorIndex).toBe(0);
    expect(next.anchorOffsetSeconds).toBe(0);
    expect(next.durationSeconds).toBe(0);
    expect(next.playIntent).toBe(false);
    expect(next.currentTimeSeconds).toBe(0);
  });

  it("keeps intent expressed before the first job finishes loading", () => {
    usePlayerStore.getState().setPlayIntent(true);
    usePlayerStore.getState().openJob(job("a"));
    expect(usePlayerStore.getState().playIntent).toBe(true);
  });

  it("does not notify when the source is unchanged", () => {
    const store = usePlayerStore.getState();
    store.openJob(job("a"));
    const source = {
      manifest: null,
      anchorIndex: 0,
      anchorOffsetSeconds: 0,
      durationSeconds: 10,
    };
    store.setSource(source);
    const before = usePlayerStore.getState();
    store.setSource({ ...source });
    expect(usePlayerStore.getState()).toBe(before);
  });

  it("clears a pending seek exactly once", () => {
    const store = usePlayerStore.getState();
    store.requestSeek(42);
    expect(usePlayerStore.getState().pendingSeekJobSeconds).toBe(42);
    store.seekApplied();
    expect(usePlayerStore.getState().pendingSeekJobSeconds).toBeNull();
    const after = usePlayerStore.getState();
    store.seekApplied();
    expect(usePlayerStore.getState()).toBe(after);
  });

  it("mirrors player outputs without dropping unrelated ones", () => {
    const store = usePlayerStore.getState();
    store.syncOutputs({ currentTimeSeconds: 12, isActuallyPlaying: true });
    store.syncOutputs({ isWaitingForData: true });
    const state = usePlayerStore.getState();
    expect(state.currentTimeSeconds).toBe(12);
    expect(state.isActuallyPlaying).toBe(true);
    expect(state.isWaitingForData).toBe(true);
  });

  it("resets to idle", () => {
    const store = usePlayerStore.getState();
    store.openJob(job("a"));
    store.setPlayIntent(true);
    store.syncOutputs({ currentTimeSeconds: 9 });

    resetPlayerStore();

    const state = usePlayerStore.getState();
    expect(state.job).toBeNull();
    expect(state.playIntent).toBe(false);
    expect(state.currentTimeSeconds).toBe(0);
  });
});
