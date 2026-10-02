import { expect, test } from "@playwright/test";

/** A written chunk as the API returns it. `version` matters: the reader only
 *  renders the active version of a chunk, so fixtures without it are dropped. */
function buildChunk(
  index: number,
  status: "written" | "queued" | "rendering" = "written",
  overrides: Record<string, unknown> = {},
) {
  return {
    index,
    status,
    duration_seconds: status === "written" ? 4 : 0,
    start_seconds: index * 4,
    plan_version: 1,
    version: 0,
    voice_id: "suzy",
    segment_url: status === "written" ? `/api/jobs/job-1/chunks/${index}` : null,
    peaks_url: null,
    deprecated: false,
    reprocessing: false,
    char_start: index * 21,
    char_end: index * 21 + 20,
    ...overrides,
  };
}

function buildJob(chunkCount: number, status: "queued" | "rendering" | "playing" = "queued") {
  return {
    id: "job-1",
    title: "Playwright job",
    status,
    voice_id: "suzy",
    model_id: "Qwen/Qwen3-TTS-12Hz-0.6B-Base",
    is_active_listening: status === "playing",
    total_chunks_emitted: chunkCount,
    total_chunks_completed: chunkCount,
    buffered_seconds: chunkCount * 4,
    completed_seconds: 0,
    source_kind: "text",
    source_text: "Playwright text",
    plan_version: 1,
    chunks: Array.from({ length: chunkCount }, (_, index) => buildChunk(index)),
    failed_reason: null,
  };
}

function buildManifest(chunkCount: number) {
  return {
    mime_type: 'audio/mp4; codecs="mp4a.40.2"',
    init_segment_url: "/api/jobs/job-1/chunks/init",
    chunks: Array.from({ length: chunkCount }, (_, index) => buildChunk(index)),
  };
}

function buildGapJob(status: "queued" | "rendering" | "playing" = "queued") {
  return {
    ...buildJob(0, status),
    status,
    is_active_listening: status === "playing",
    total_chunks_emitted: 6,
    total_chunks_completed: 4,
    buffered_seconds: 16,
    chunks: [
      buildChunk(0),
      buildChunk(1),
      buildChunk(2),
      buildChunk(3, "queued"),
      buildChunk(4, "rendering"),
      buildChunk(5, "written", { start_seconds: 20 }),
    ],
  };
}

function buildGapManifest() {
  return {
    mime_type: 'audio/mp4; codecs="mp4a.40.2"',
    init_segment_url: "/api/jobs/job-1/chunks/init",
    chunks: buildGapJob().chunks,
  };
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript({
    content: `
      class FakeSourceBuffer extends EventTarget {
        updating = false;

        appendBuffer() {
          this.updating = true;
          queueMicrotask(() => {
            this.updating = false;
            this.dispatchEvent(new Event("updateend"));
          });
        }
      }

      class FakeMediaSource extends EventTarget {
        readyState = "closed";

        constructor() {
          super();
          queueMicrotask(() => {
            this.readyState = "open";
            this.dispatchEvent(new Event("sourceopen"));
          });
        }

        addSourceBuffer() {
          return new FakeSourceBuffer();
        }
      }

      class FakeWebSocket extends EventTarget {
        static CONNECTING = 0;
        static OPEN = 1;
        static CLOSING = 2;
        static CLOSED = 3;

        readyState = FakeWebSocket.CONNECTING;

        constructor() {
          super();
          window.__mockSockets.push(this);
          queueMicrotask(() => {
            if (window.__mockSocketMode === "offline") {
              this.readyState = FakeWebSocket.CLOSED;
              this.dispatchEvent(new Event("close"));
              return;
            }
            this.readyState = FakeWebSocket.OPEN;
            this.dispatchEvent(new Event("open"));
          });
        }

        send(payload) {
          if (window.__mockSocketMode === "offline") {
            return;
          }
          if (payload === "ping") {
            queueMicrotask(() => {
              this.dispatchEvent(
                new MessageEvent("message", {
                  data: JSON.stringify({ type: "pong", payload: {} }),
                }),
              );
            });
          }
        }

        emit(payload) {
          this.dispatchEvent(
            new MessageEvent("message", {
              data: JSON.stringify(payload),
            }),
          );
        }

        close() {
          this.readyState = FakeWebSocket.CLOSED;
          this.dispatchEvent(new Event("close"));
        }

        closeFromServer() {
          this.close();
        }
      }

      window.__mockSockets = [];
      window.__mockSocketMode = "normal";
      URL.createObjectURL = () => "blob:playwright-media-source";
      URL.revokeObjectURL = () => {};
      Object.defineProperty(window, "MediaSource", {
        writable: true,
        value: FakeMediaSource,
      });
      Object.defineProperty(window, "WebSocket", {
        writable: true,
        value: FakeWebSocket,
      });
    `,
  });

  await page.route("**/api/jobs", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({ json: [] });
      return;
    }
    await route.fulfill({
      json: {
        job: {
          id: "job-1",
          title: "Playwright job",
          status: "queued",
          voice_id: "suzy",
          model_id: "Qwen/Qwen3-TTS-12Hz-0.6B-Base",
          is_active_listening: false,
          total_chunks_emitted: 1,
          total_chunks_completed: 0,
          buffered_seconds: 0,
          completed_seconds: 0,
          source_kind: "text",
          source_text: "Playwright text",
          plan_version: 1,
          chunks: [],
          failed_reason: null,
        },
      },
    });
  });

  await page.route("**/api/voices", async (route) => {
    await route.fulfill({
      json: [
        { id: "suzy", display_name: "Suzy", description: null },
        { id: "howard", display_name: "Howard", description: null },
      ],
    });
  });

  await page.route("**/api/admin/state", async (route) => {
    await route.fulfill({
      json: {
        config: {
          idle_unload_seconds: 300,
          max_prebuffer_seconds: 300,
          target_buffer_seconds: 45,
          batch_candidates_small_model: [8, 7, 6, 5],
          batch_candidates_large_model: [6, 5, 4, 3],
          vram_soft_limit_mb: 9000,
          vram_hard_limit_mb: 11000,
        },
        scheduler: {
          queue_depth: 0,
          batch_candidates: [8, 7, 6, 5],
        },
        telemetry: {
          queue_depth: 0,
          model_state: "warm_idle",
          idle_deadline: null,
          oom_count: 0,
          recent_batches: [],
          recent_events: [],
        },
      },
    });
  });
});

test("jobs page creates a job", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Text source").fill("Playwright text");
  await page.getByRole("button", { name: "Create job" }).click();
  await expect(page.getByText("Playwright job")).toBeVisible();
});

test("reader updates live when a new chunk arrives without a reload", async ({ page }) => {
  let chunkCount = 1;

  await page.route("**/api/jobs/job-1", async (route) => {
    await route.fulfill({ json: buildJob(chunkCount, "rendering") });
  });
  await page.route("**/api/jobs/job-1/manifest", async (route) => {
    await route.fulfill({ json: buildManifest(chunkCount) });
  });
  await page.route("**/api/jobs/job-1/activate", async (route) => {
    await route.fulfill({ json: buildJob(chunkCount, "playing") });
  });
  await page.route("**/api/jobs/job-1/pause", async (route) => {
    await route.fulfill({ json: buildJob(chunkCount, "queued") });
  });
  await page.route("**/api/jobs/job-1/playback", async (route) => {
    await route.fulfill({ json: buildJob(chunkCount, "playing") });
  });
  await page.route("**/api/jobs/job-1/voice", async (route) => {
    await route.fulfill({
      json: {
        ...buildJob(chunkCount, "rendering"),
        voice_id: "howard",
        plan_version: 2,
      },
    });
  });
  await page.route("**/api/jobs/job-1/chunks/**", async (route) => {
    await route.fulfill({ body: "abc" });
  });

  await page.goto("/jobs/job-1");
  await expect(page.getByRole("heading", { name: "Playwright job" })).toBeVisible();
  await expect(page.getByText(/1\/1 chunks/i)).toBeVisible();

  chunkCount = 2;
  await page.evaluate(() => {
    const mockWindow = globalThis as typeof globalThis & {
      __mockSockets: Array<{
        emit: (payload: object) => void;
      }>;
    };
    const payload = {
      type: "chunk_ready",
      payload: {
        // Per-chunk events carry the job summary plus the single chunk that
        // changed; the client merges them into the detail it fetched over HTTP.
        job: {
          id: "job-1",
          title: "Playwright job",
          status: "rendering",
          voice_id: "suzy",
          model_id: "Qwen/Qwen3-TTS-12Hz-0.6B-Base",
          is_active_listening: false,
          total_chunks_emitted: 2,
          total_chunks_completed: 2,
          buffered_seconds: 8,
          completed_seconds: 0,
        },
        chunk: {
          index: 1,
          status: "written",
          duration_seconds: 4,
          start_seconds: 4,
          plan_version: 1,
          version: 0,
          voice_id: "suzy",
          segment_url: "/api/jobs/job-1/chunks/1",
          peaks_url: null,
          deprecated: false,
          reprocessing: false,
          char_start: 0,
          char_end: 0,
        },
        chunk_index: 1,
        mime_type: 'audio/mp4; codecs="mp4a.40.2"',
        init_segment_url: "/api/jobs/job-1/chunks/init",
      },
    };
    for (const socket of mockWindow.__mockSockets) {
      socket.emit(payload);
    }
  });

  await expect(page.getByText(/2\/2 chunks/i)).toBeVisible();
  await expect(page.getByText(/Chunk 2/).first()).toBeVisible();
});

test("reader shows a visible fallback warning when the socket disconnects", async ({ page }) => {
  await page.route("**/api/jobs/job-1", async (route) => {
    await route.fulfill({ json: buildJob(1, "rendering") });
  });
  await page.route("**/api/jobs/job-1/manifest", async (route) => {
    await route.fulfill({ json: buildManifest(1) });
  });
  await page.route("**/api/jobs/job-1/chunks/**", async (route) => {
    await route.fulfill({ body: "abc" });
  });
  await page.route("**/api/jobs/job-1/playback", async (route) => {
    await route.fulfill({ json: buildJob(1, "rendering") });
  });

  await page.goto("/jobs/job-1");
  await expect(page.getByRole("heading", { name: "Playwright job" })).toBeVisible();

  await page.evaluate(() => {
    const mockWindow = globalThis as typeof globalThis & {
      __mockSocketMode: "normal" | "offline";
      __mockSockets: Array<{
        closeFromServer: () => void;
      }>;
    };
    mockWindow.__mockSocketMode = "offline";
    for (const socket of mockWindow.__mockSockets) {
      socket.closeFromServer();
    }
  });

  await expect(page.getByText(/Live updates degraded, using fallback sync/i)).toBeVisible();
  await expect(page.getByLabel(/Connection: reconnecting/)).toBeVisible();
});

test("reader renders missing gap slots and allows a manual jump to a later ready chunk", async ({
  page,
}) => {
  await page.route("**/api/jobs/job-1", async (route) => {
    await route.fulfill({ json: buildGapJob("queued") });
  });
  await page.route("**/api/jobs/job-1/manifest", async (route) => {
    await route.fulfill({ json: buildGapManifest() });
  });
  await page.route("**/api/jobs/job-1/activate", async (route) => {
    await route.fulfill({ json: buildGapJob("playing") });
  });
  await page.route("**/api/jobs/job-1/playback", async (route) => {
    await route.fulfill({ json: buildGapJob("playing") });
  });
  await page.route("**/api/jobs/job-1/chunks/**", async (route) => {
    await route.fulfill({ body: "abc" });
  });

  await page.goto("/jobs/job-1");
  await expect(page.getByText(/4\/6 chunks/i)).toBeVisible();
  await expect(page.getByRole("slider", { name: "Chunk 4: missing_expected" })).toHaveAttribute(
    "data-slot-state",
    "missing_expected",
  );
  await expect(page.getByRole("slider", { name: "Chunk 5: missing_expected" })).toHaveAttribute(
    "data-slot-state",
    "missing_expected",
  );
  await expect(page.getByRole("slider", { name: "Chunk 6: ready_after_gap" })).toHaveAttribute(
    "data-slot-state",
    "ready_after_gap",
  );

  await page.getByRole("slider", { name: "Chunk 6: ready_after_gap" }).click();

  // Seeking to the later ready chunk anchors playback on it.
  await expect(page.getByRole("slider", { name: "Chunk 6: playing" })).toBeVisible();
});

test("reader jumps playback to a chunk from the text", async ({ page }) => {
  await page.route("**/api/jobs/job-1", async (route) => {
    await route.fulfill({ json: buildJob(4, "queued") });
  });
  await page.route("**/api/jobs/job-1/manifest", async (route) => {
    await route.fulfill({ json: buildManifest(4) });
  });
  await page.route("**/api/jobs/job-1/activate", async (route) => {
    await route.fulfill({ json: buildJob(4, "playing") });
  });
  await page.route("**/api/jobs/job-1/playback", async (route) => {
    await route.fulfill({ json: buildJob(4, "playing") });
  });
  await page.route("**/api/jobs/job-1/chunks/**", async (route) => {
    await route.fulfill({ body: "abc" });
  });

  await page.goto("/jobs/job-1");
  await expect(page.getByText(/4\/4 chunks/i)).toBeVisible();

  // Chunk 3 starts 8s into the document, so the jump control must move the
  // playhead there without the user touching the (small) top playbar.
  await page.getByTestId("chunk-2-jump").click();

  // Both the playbar clock and the conveyor follow the jump.
  await expect(page.getByTestId("conveyor-readout")).toHaveText("0:08");
  // The anchored chunk becomes the one playback is sitting on.
  await expect(page.getByRole("slider", { name: "Chunk 3: playing" })).toBeVisible();
});

test("the chunk conveyor seeks when dragged and keeps the strip under the playhead", async ({
  page,
}) => {
  await page.route("**/api/jobs/job-1", async (route) => {
    await route.fulfill({ json: buildJob(6, "queued") });
  });
  await page.route("**/api/jobs/job-1/manifest", async (route) => {
    await route.fulfill({ json: buildManifest(6) });
  });
  await page.route("**/api/jobs/job-1/chunks/**", async (route) => {
    await route.fulfill({ body: "abc" });
  });

  await page.goto("/jobs/job-1");
  await expect(page.getByTestId("chunk-conveyor")).toBeVisible();
  await expect(page.getByTestId("conveyor-readout")).toHaveText("0:00");

  // A slow, deliberate drag right reveals earlier audio — and the strip must
  // not have moved on its own before the release commits the seek.
  const strip = page.getByTestId("chunk-conveyor");
  const box = await strip.boundingBox();
  expect(box).not.toBeNull();
  const centreY = (box?.y ?? 0) + (box?.height ?? 0) / 2;

  await page.mouse.move((box?.x ?? 0) + (box?.width ?? 0) / 2, centreY);
  await page.mouse.down();
  await page.mouse.move((box?.x ?? 0) + (box?.width ?? 0) / 2 + 40, centreY, { steps: 12 });
  await page.mouse.up();

  // The drag starts at the live position, so dragging forward from 0 clamps to
  // the start; the readout stays on a valid, playable position.
  await expect(page.getByTestId("conveyor-readout")).toHaveText(/0:0\d/);

  // Dragging left moves forward in time and commits a seek on release.
  await page.mouse.move((box?.x ?? 0) + (box?.width ?? 0) / 2, centreY);
  await page.mouse.down();
  await page.mouse.move((box?.x ?? 0) + (box?.width ?? 0) / 2 - 120, centreY, { steps: 12 });
  await page.mouse.up();

  await expect(page.getByTestId("conveyor-readout")).not.toHaveText("0:00");
});

test("reader settings hide the per-chunk jump controls", async ({ page }) => {
  await page.route("**/api/jobs/job-1", async (route) => {
    await route.fulfill({ json: buildJob(2, "queued") });
  });
  await page.route("**/api/jobs/job-1/manifest", async (route) => {
    await route.fulfill({ json: buildManifest(2) });
  });
  await page.route("**/api/jobs/job-1/chunks/**", async (route) => {
    await route.fulfill({ body: "abc" });
  });

  await page.goto("/jobs/job-1");
  await expect(page.getByTestId("chunk-1-jump")).toBeVisible();

  await page.getByRole("button", { name: "Reader settings" }).click();
  await expect(page.getByRole("dialog", { name: "Reader settings" })).toBeVisible();
  await page.getByLabel("Show chunk jump buttons").uncheck();

  await expect(page.getByTestId("chunk-1-jump")).toBeHidden();

  // The shortcut guide lives in the same panel.
  await expect(page.getByTestId("shortcut-guide")).toBeVisible();
});

test("phone widths get a bottom dock and keep the top bar as an overview", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });

  await page.route("**/api/jobs/job-1", async (route) => {
    await route.fulfill({ json: buildJob(6, "queued") });
  });
  await page.route("**/api/jobs/job-1/manifest", async (route) => {
    await route.fulfill({ json: buildManifest(6) });
  });
  await page.route("**/api/jobs/job-1/chunks/**", async (route) => {
    await route.fulfill({ body: "abc" });
  });

  await page.goto("/jobs/job-1");

  const dock = page.getByTestId("reader-dock");
  await expect(dock).toBeVisible();
  await expect(dock.getByTestId("chunk-conveyor")).toBeVisible();

  // Transport lives in the dock and nowhere else — the top bar is the overview.
  // `exact` matters: Playwright's accessible-name match is substring based, and
  // "Jump playback to chunk N" would otherwise count as a Play button.
  await expect(page.getByRole("button", { name: "Play", exact: true })).toHaveCount(1);
  await expect(dock.getByRole("button", { name: "Play", exact: true })).toBeVisible();
  // Secondary metadata is dropped on phone widths.
  await expect(page.getByText(/6\/6 chunks/i)).toBeHidden();

  // The floating sidebar toggle must not sit under the dock.
  const dockBox = await dock.boundingBox();
  const toggle = page.getByRole("button", { name: "Open sidebar" });
  await expect(toggle).toBeVisible();
  const toggleBox = await toggle.boundingBox();
  expect(dockBox).not.toBeNull();
  expect(toggleBox).not.toBeNull();
  expect((toggleBox?.y ?? 0) + (toggleBox?.height ?? 0)).toBeLessThanOrEqual(dockBox?.y ?? 0);

  // The dock controls stay reachable and still seek.
  await dock.getByRole("button", { name: "Forward 10 seconds" }).click();
  await expect(dock.getByTestId("conveyor-readout")).toBeVisible();
});
