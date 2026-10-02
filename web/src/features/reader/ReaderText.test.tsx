import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, test, vi } from "vitest";

import { buildChunk } from "../../test-utils/chunks";
import { buildReaderTextSegments } from "./reader-text";
import { ReaderChunkBlock, ReaderContent, ReaderTextBody } from "./ReaderText";

afterEach(cleanup);

/* ── Fixtures ─────────────────────────────────────────────── */

const NOOP_REF = () => {};
const NOOP_JUMP = () => {};

function bodySegments(...chunks: ReturnType<typeof buildChunk>[]) {
  return buildReaderTextSegments(chunks, "AAAA BBBB CCCC DDDD EEEE");
}

function chunkState(chunkIndex: number): string | null {
  return (
    document.querySelector<HTMLElement>(`[data-chunk-block="${chunkIndex}"]`)?.dataset.chunkState ??
    null
  );
}

interface BodyOverrides {
  activeChunkIndex?: number | null;
  playedIndexes?: Set<number>;
  showJumpButtons?: boolean;
  animateNowPlaying?: boolean;
  onJumpToChunk?: (chunkIndex: number) => void;
  onRegisterChunkRef?: (chunkIndex: number, element: HTMLDivElement | null) => void;
}

function renderBody(segments: ReturnType<typeof buildReaderTextSegments>, overrides: BodyOverrides = {}) {
  return render(
    <ReaderTextBody
      activeChunkIndex={overrides.activeChunkIndex ?? null}
      animateNowPlaying={overrides.animateNowPlaying ?? true}
      onJumpToChunk={overrides.onJumpToChunk ?? NOOP_JUMP}
      onRegisterChunkRef={overrides.onRegisterChunkRef ?? NOOP_REF}
      playedIndexes={overrides.playedIndexes ?? new Set()}
      segments={segments}
      showJumpButtons={overrides.showJumpButtons ?? false}
    />,
  );
}

/* ── ReaderTextBody ───────────────────────────────────────── */

describe("ReaderTextBody", () => {
  test("renders one block per chunk plus the dimmed upcoming tail", () => {
    renderBody(
      bodySegments(
        buildChunk(0, { char_start: 0, char_end: 4 }),
        buildChunk(1, { char_start: 4, char_end: 9 }),
      ),
    );

    expect(screen.getByText("Chunk 1")).toBeInTheDocument();
    expect(screen.getByText("Chunk 2")).toBeInTheDocument();
    expect(screen.getByText("BBBB")).toBeInTheDocument();
    expect(screen.getByText(/Upcoming text/)).toBeInTheDocument();
  });

  test("marks the active chunk, dims played chunks and leaves the rest idle", () => {
    renderBody(
      bodySegments(
        buildChunk(0, { char_start: 0, char_end: 4 }),
        buildChunk(1, { char_start: 5, char_end: 9 }),
        buildChunk(2, { char_start: 10, char_end: 14 }),
      ),
      { activeChunkIndex: 1, playedIndexes: new Set([0]) },
    );

    expect(chunkState(0)).toBe("played");
    expect(chunkState(1)).toBe("active");
    expect(chunkState(2)).toBe("idle");
  });

  test("shows the empty state before any chunk is planned", () => {
    renderBody([]);
    expect(screen.getByText(/No chunks available yet/)).toBeInTheDocument();
  });

  test("reports how many characters the bounded tail hides", () => {
    renderBody([
      { key: "upcoming", kind: "upcoming", chunkIndex: null, text: "abc", hiddenChars: 1234 },
    ]);
    expect(screen.getByText(/1,234 more characters not shown/)).toBeInTheDocument();
  });

  test("registers each chunk block element by index and clears it on unmount", () => {
    const onRegisterChunkRef = vi.fn();
    const { unmount } = renderBody(bodySegments(buildChunk(7, { char_start: 0, char_end: 4 })), {
      onRegisterChunkRef,
    });

    const block = document.querySelector<HTMLDivElement>('[data-chunk-block="7"]');
    expect(block).not.toBeNull();
    expect(onRegisterChunkRef).toHaveBeenCalledWith(7, block);

    unmount();
    expect(onRegisterChunkRef).toHaveBeenCalledWith(7, null);
  });
});

/* ── Jump controls ────────────────────────────────────────── */

describe("ReaderTextBody jump controls", () => {
  const segments = bodySegments(
    buildChunk(0, { char_start: 0, char_end: 4 }),
    buildChunk(1, { char_start: 5, char_end: 9 }),
  );

  test("offers a labelled jump button on every chunk", () => {
    renderBody(segments, { showJumpButtons: true });

    expect(screen.getByRole("button", { name: "Jump playback to chunk 1" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Jump playback to chunk 2" })).toBeInTheDocument();
  });

  test("jump reports the chunk it belongs to", async () => {
    const onJumpToChunk = vi.fn();
    renderBody(segments, { onJumpToChunk, showJumpButtons: true });

    await userEvent.click(screen.getByRole("button", { name: "Jump playback to chunk 2" }));

    expect(onJumpToChunk).toHaveBeenCalledWith(1);
  });

  test("the playing chunk shows a status marker instead of a jump button", () => {
    renderBody(segments, { activeChunkIndex: 0, showJumpButtons: true });

    expect(screen.getByTestId("chunk-0-now-playing")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Jump playback to chunk 1" })).toBeNull();
    // The other chunk keeps its control.
    expect(screen.getByRole("button", { name: "Jump playback to chunk 2" })).toBeInTheDocument();
  });

  test("uses a return arrow, not the previous download-looking glyph", () => {
    renderBody(segments, { showJumpButtons: true });

    const button = screen.getByRole("button", { name: "Jump playback to chunk 2" });
    expect(
      Array.from(button.querySelectorAll("path")).map((path) => path.getAttribute("d")),
    ).toEqual(["M9 14 4 9l5-5", "M4 9h10.5a5.5 5.5 0 0 1 0 11H11"]);
    // The old glyph was an arrow pointing down at a baseline, which read as a
    // download button. Keep the icon a single stroked arrow.
    expect(button.querySelector("line")).toBeNull();
    expect(button.querySelector("polyline")).toBeNull();
    expect(button.querySelector("rect")).toBeNull();
  });

  test("marks the playing chunk with equalizer bars", () => {
    renderBody(segments, { activeChunkIndex: 0, showJumpButtons: true });

    const marker = screen.getByTestId("chunk-0-now-playing");
    expect(marker.querySelectorAll("[data-now-playing-bar]")).toHaveLength(4);
    // The bars are uneven, so the marker reads as a live signal.
    const heights = Array.from(marker.querySelectorAll<HTMLElement>("[data-now-playing-bar]")).map(
      (bar) => bar.style.height,
    );
    expect(new Set(heights).size).toBeGreaterThan(1);
  });

  test("animates the marker only when motion allows it", () => {
    const { unmount } = renderBody(segments, {
      activeChunkIndex: 0,
      animateNowPlaying: true,
      showJumpButtons: true,
    });
    const animated = screen
      .getByTestId("chunk-0-now-playing")
      .querySelector<HTMLElement>("[data-now-playing-bar]");
    expect(animated?.style.animation).toContain("readflow-equalizer");
    unmount();

    renderBody(segments, {
      activeChunkIndex: 0,
      animateNowPlaying: false,
      showJumpButtons: true,
    });
    const still = screen
      .getByTestId("chunk-0-now-playing")
      .querySelector<HTMLElement>("[data-now-playing-bar]");
    // Reduced motion keeps the marker as a status indicator, just static.
    expect(still?.style.animation).toBe("");
    expect(still?.style.height).not.toBe("");
  });

  test("renders no jump control when the setting is off", () => {
    renderBody(segments, { showJumpButtons: false });

    expect(screen.queryByRole("button", { name: /Jump playback to chunk/ })).toBeNull();
    // The chunk number itself is not a control.
    expect(screen.getByText("Chunk 1")).toBeInTheDocument();
  });
});

/* ── ReaderChunkBlock memo contract ───────────────────────── */

describe("ReaderChunkBlock", () => {
  /**
   * The reader re-renders ~20x/s during playback with thousands of blocks on
   * screen, so a block whose props did not change must keep the exact same DOM
   * node rather than being remounted. That only holds while `onRegisterRef` and
   * `onJump` are stable, which is why this is pinned.
   */
  test("re-rendering with unchanged props preserves the DOM node", () => {
    const { rerender } = render(
      <ReaderChunkBlock
        animateNowPlaying
        chunkIndex={3}
        isActive={false}
        isPlayed={false}
        onJump={NOOP_JUMP}
        onRegisterRef={NOOP_REF}
        showJumpButton
        text="some chunk text"
      />,
    );
    const before = document.querySelector('[data-chunk-block="3"]');

    rerender(
      <ReaderChunkBlock
        animateNowPlaying
        chunkIndex={3}
        isActive={false}
        isPlayed={false}
        onJump={NOOP_JUMP}
        onRegisterRef={NOOP_REF}
        showJumpButton
        text="some chunk text"
      />,
    );

    expect(document.querySelector('[data-chunk-block="3"]')).toBe(before);
  });

  test("updates state when the chunk becomes active", () => {
    const props = {
      animateNowPlaying: true,
      chunkIndex: 1,
      isPlayed: false,
      onJump: NOOP_JUMP,
      onRegisterRef: NOOP_REF,
      showJumpButton: true,
      text: "text",
    };
    const { rerender } = render(<ReaderChunkBlock {...props} isActive={false} />);
    expect(chunkState(1)).toBe("idle");

    rerender(<ReaderChunkBlock {...props} isActive />);
    expect(chunkState(1)).toBe("active");
  });

  test("falls back to a placeholder for an empty chunk", () => {
    render(
      <ReaderChunkBlock
        animateNowPlaying={false}
        chunkIndex={0}
        isActive={false}
        isPlayed={false}
        onJump={NOOP_JUMP}
        onRegisterRef={NOOP_REF}
        showJumpButton={false}
        text="   "
      />,
    );
    expect(screen.getByText("(empty text)")).toBeInTheDocument();
  });
});

/* ── ReaderContent ────────────────────────────────────────── */

describe("ReaderContent", () => {
  test("shows the title, status and sidebar toggle on large screens", async () => {
    const onToggleSidebar = vi.fn();
    render(
      <ReaderContent
        contentRef={{ current: null }}
        isLargeScreen
        isPlaying={false}
        lines={<p>body</p>}
        onToggleSidebar={onToggleSidebar}
        sidebarOpen={false}
        status="playing"
        title="Chapter one"
      />,
    );

    expect(screen.getByText("Chapter one")).toBeInTheDocument();
    expect(screen.getByText("playing")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Open sidebar" }));
    expect(onToggleSidebar).toHaveBeenCalledTimes(1);
  });

  test("reports the live play state for the now-playing marker", () => {
    const { unmount } = render(
      <ReaderContent
        contentRef={{ current: null }}
        isLargeScreen
        isPlaying={false}
        lines={<p>body</p>}
        onToggleSidebar={vi.fn()}
        sidebarOpen
        status="paused"
        title="Chapter one"
      />,
    );
    const paused = document.querySelector("[data-now-playing]");
    expect(paused).toHaveAttribute("data-now-playing", "paused");
    unmount();

    render(
      <ReaderContent
        contentRef={{ current: null }}
        isLargeScreen
        isPlaying
        lines={<p>body</p>}
        onToggleSidebar={vi.fn()}
        sidebarOpen
        status="playing"
        title="Chapter one"
      />,
    );
    // The CSS rule pauses the equalizer whenever this attribute is "paused", so
    // the marker can never claim audio is playing while it is not.
    expect(document.querySelector("[data-now-playing]")).toHaveAttribute(
      "data-now-playing",
      "running",
    );
  });

  test("hides the sidebar toggle on small screens where the sidebar overlays", () => {
    render(
      <ReaderContent
        contentRef={{ current: null }}
        isLargeScreen={false}
        isPlaying
        lines={<p>body</p>}
        onToggleSidebar={vi.fn()}
        sidebarOpen
        status="paused"
        title="Chapter one"
      />,
    );
    expect(screen.queryByRole("button", { name: /sidebar/i })).not.toBeInTheDocument();
  });
});
