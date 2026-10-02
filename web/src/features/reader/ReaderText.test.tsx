import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, test, vi } from "vitest";

import { buildChunk } from "../../test-utils/chunks";
import { buildReaderTextSegments } from "./reader-text";
import { ReaderChunkBlock, ReaderContent, ReaderTextBody } from "./ReaderText";

afterEach(cleanup);

/* ── Fixtures ─────────────────────────────────────────────── */

const NOOP_REF = () => {};

function bodySegments(...chunks: ReturnType<typeof buildChunk>[]) {
  return buildReaderTextSegments(chunks, "AAAA BBBB CCCC DDDD EEEE");
}

function chunkState(chunkIndex: number): string | null {
  return (
    document.querySelector<HTMLElement>(`[data-chunk-block="${chunkIndex}"]`)?.dataset.chunkState ??
    null
  );
}

/* ── ReaderTextBody ───────────────────────────────────────── */

describe("ReaderTextBody", () => {
  test("renders one block per chunk plus the dimmed upcoming tail", () => {
    render(
      <ReaderTextBody
        activeChunkIndex={null}
        onRegisterChunkRef={NOOP_REF}
        playedIndexes={new Set()}
        segments={bodySegments(
          buildChunk(0, { char_start: 0, char_end: 4 }),
          buildChunk(1, { char_start: 4, char_end: 9 }),
        )}
      />,
    );

    expect(screen.getByText("Chunk 1")).toBeInTheDocument();
    expect(screen.getByText("Chunk 2")).toBeInTheDocument();
    expect(screen.getByText("BBBB")).toBeInTheDocument();
    expect(screen.getByText(/Upcoming text/)).toBeInTheDocument();
  });

  test("marks the active chunk, dims played chunks and leaves the rest idle", () => {
    render(
      <ReaderTextBody
        activeChunkIndex={1}
        onRegisterChunkRef={NOOP_REF}
        playedIndexes={new Set([0])}
        segments={bodySegments(
          buildChunk(0, { char_start: 0, char_end: 4 }),
          buildChunk(1, { char_start: 5, char_end: 9 }),
          buildChunk(2, { char_start: 10, char_end: 14 }),
        )}
      />,
    );

    expect(chunkState(0)).toBe("played");
    expect(chunkState(1)).toBe("active");
    expect(chunkState(2)).toBe("idle");
  });

  test("shows the empty state before any chunk is planned", () => {
    render(
      <ReaderTextBody
        activeChunkIndex={null}
        onRegisterChunkRef={NOOP_REF}
        playedIndexes={new Set()}
        segments={[]}
      />,
    );
    expect(screen.getByText(/No chunks available yet/)).toBeInTheDocument();
  });

  test("reports how many characters the bounded tail hides", () => {
    render(
      <ReaderTextBody
        activeChunkIndex={null}
        onRegisterChunkRef={NOOP_REF}
        playedIndexes={new Set()}
        segments={[
          { key: "upcoming", kind: "upcoming", chunkIndex: null, text: "abc", hiddenChars: 1234 },
        ]}
      />,
    );
    expect(screen.getByText(/1,234 more characters not shown/)).toBeInTheDocument();
  });

  test("registers each chunk block element by index and clears it on unmount", () => {
    const onRegisterChunkRef = vi.fn();
    const { unmount } = render(
      <ReaderTextBody
        activeChunkIndex={null}
        onRegisterChunkRef={onRegisterChunkRef}
        playedIndexes={new Set()}
        segments={bodySegments(buildChunk(7, { char_start: 0, char_end: 4 }))}
      />,
    );

    const block = document.querySelector<HTMLDivElement>('[data-chunk-block="7"]');
    expect(block).not.toBeNull();
    expect(onRegisterChunkRef).toHaveBeenCalledWith(7, block);

    unmount();
    expect(onRegisterChunkRef).toHaveBeenCalledWith(7, null);
  });
});

/* ── ReaderChunkBlock memo contract ───────────────────────── */

describe("ReaderChunkBlock", () => {
  /**
   * The reader re-renders ~20x/s during playback with thousands of blocks on
   * screen, so a block whose props did not change must keep the exact same DOM
   * node rather than being remounted. That only holds while `onRegisterRef` is
   * stable, which is why this is pinned.
   */
  test("re-rendering with unchanged props preserves the DOM node", () => {
    const onRegisterRef = vi.fn();
    const { rerender } = render(
      <ReaderChunkBlock
        chunkIndex={3}
        isActive={false}
        isPlayed={false}
        onRegisterRef={onRegisterRef}
        text="some chunk text"
      />,
    );
    const before = document.querySelector('[data-chunk-block="3"]');

    rerender(
      <ReaderChunkBlock
        chunkIndex={3}
        isActive={false}
        isPlayed={false}
        onRegisterRef={onRegisterRef}
        text="some chunk text"
      />,
    );

    expect(document.querySelector('[data-chunk-block="3"]')).toBe(before);
  });

  test("updates state when the chunk becomes active", () => {
    const onRegisterRef = vi.fn();
    const { rerender } = render(
      <ReaderChunkBlock
        chunkIndex={1}
        isActive={false}
        isPlayed={false}
        onRegisterRef={onRegisterRef}
        text="text"
      />,
    );
    expect(chunkState(1)).toBe("idle");

    rerender(
      <ReaderChunkBlock
        chunkIndex={1}
        isActive
        isPlayed={false}
        onRegisterRef={onRegisterRef}
        text="text"
      />,
    );
    expect(chunkState(1)).toBe("active");
  });

  test("falls back to a placeholder for an empty chunk", () => {
    render(
      <ReaderChunkBlock
        chunkIndex={0}
        isActive={false}
        isPlayed={false}
        onRegisterRef={NOOP_REF}
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

  test("hides the sidebar toggle on small screens where the sidebar overlays", () => {
    render(
      <ReaderContent
        contentRef={{ current: null }}
        isLargeScreen={false}
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
