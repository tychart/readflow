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

  await page.route("**/api/status", async (route) => {
    await route.fulfill({
      json: {
        resident_model_id: null,
        resident_voice_id: null,
        model_state: "unloaded",
        model_residency_batches: 10,
        voice_residency_batches: 3,
      },
    });
  });

  await page.route("**/api/admin/state", async (route) => {
    await route.fulfill({
      json: {
        config: {
          device: "auto",
          idle_unload_seconds: 300,
          max_prebuffer_seconds: 300,
          target_buffer_seconds: 60,
          plan_ahead_chunks: 16,
          batch_candidates_small_model: [8, 7, 6, 5],
          batch_candidates_large_model: [6, 5, 4, 3],
          vram_soft_limit_mb: 9000,
          vram_hard_limit_mb: 11000,
          chunk_max_attempts: 3,
          model_load_timeout_seconds: 900,
          synthesis_timeout_seconds: 300,
          model_residency_batches: 10,
          voice_residency_batches: 3,
        },
        scheduler: {
          queue_depth: 0,
          batch_candidates: [8, 7, 6, 5],
          running: true,
          last_tick_at: Date.now() / 1000,
          last_error: null,
          consecutive_errors: 0,
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

test("the conveyor draws into a fixed canvas and repaints on resize and theme changes", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("readflow-theme", "dark"));
  await page.route("**/api/jobs/job-1", route => route.fulfill({ json: buildJob(6) }));
  await page.route("**/api/jobs/job-1/manifest", route => route.fulfill({ json: buildManifest(6) }));
  await page.route("**/api/jobs/job-1/chunks/**", route => route.fulfill({ body: "abc" }));
  await page.goto("/jobs/job-1");
  const canvas = page.getByTestId("conveyor-canvas");
  await expect(canvas).toBeVisible();
  const pixels = () => canvas.evaluate((element: HTMLCanvasElement) => {
    const ctx = element.getContext("2d")!;
    const data = ctx.getImageData(0, 0, element.width, element.height).data;
    let painted = 0;
    let checksum = 0;
    for (let i = 0; i < data.length; i += 1) {
      checksum = (checksum + data[i]) >>> 0;
      if (i % 4 === 3 && data[i] > 0) painted += 1;
    }
    return {
      painted, checksum, width: element.width,
      expectedWidth: Math.round(element.clientWidth * devicePixelRatio),
      height: element.height,
      expectedHeight: Math.round(element.clientHeight * devicePixelRatio),
      transform: getComputedStyle(element).transform,
      filter: getComputedStyle(element).filter,
    };
  });
  await expect.poll(async () => (await pixels()).painted).toBeGreaterThan(500);
  const before = await pixels();
  expect(before.width).toBe(before.expectedWidth);
  expect(before.height).toBe(before.expectedHeight);
  expect(before.transform).toBe("none");
  expect(before.filter).toBe("none");
  await expect(page.getByTestId("chunk-conveyor").locator("[data-waveform-slot]")).toHaveCount(0);

  await page.getByRole("button", { name: "Switch to light mode" }).click();
  await expect.poll(async () => (await pixels()).checksum).not.toBe(before.checksum);
  await page.setViewportSize({ width: 1000, height: 800 });
  await expect.poll(async () => (await pixels()).width).not.toBe(before.width);
  const resized = await pixels();
  expect(resized.width).toBe(resized.expectedWidth);
  expect(resized.height).toBe(resized.expectedHeight);
  expect(resized.painted).toBeGreaterThan(500);
});

test("native cached contours remain rigid across fractional playback positions", async ({ page }) => {
  await page.route("**/api/jobs/job-1", route => route.fulfill({ json: buildJob(6) }));
  await page.route("**/api/jobs/job-1/manifest", route => route.fulfill({ json: buildManifest(6) }));
  await page.route("**/api/jobs/job-1/chunks/**", route => route.fulfill({ body: "abc" }));
  await page.goto("/jobs/job-1");
  const mismatches = await page.evaluate(async () => {
    // The selected look is native Canvas2D image filtering, not per-frame
    // vector rasterization or supersampling. Compare actual pixels with a
    // rigid native stamp at several phases/densities, including fractional
    // logical slot widths. This guards the user's preferred rendering path;
    // it intentionally does NOT promise constant linear-light luminance.
    const moduleUrl = "/src/lib/conveyor-canvas.ts";
    const { createConveyorScene, paintConveyor } = await import(moduleUrl);
    const scene = createConveyorScene(
      [{ chunkIndex: 0, state: "playing", durationSeconds: 1000.03 }],
      [0], new Map([[0, new Float32Array([0.2, 1, 0.3, 0.8, 0.4, 0.9])]]), 5.2,
    );
    const palette = {
      amber: "#f59e0b", active: "rgba(245,158,11,0.15)",
      bar: "rgba(255,255,255,0.18)", muted: "rgba(255,255,255,0.10)",
    };
    let differingChannels = 0;
    for (const dpr of [1, 1.5, 2]) {
      const canvas = document.createElement("canvas");
      const reference = document.createElement("canvas");
      canvas.width = reference.width = 1800 * dpr;
      canvas.height = reference.height = 64 * dpr;
      const ctx = canvas.getContext("2d")!;
      const expectedCtx = reference.getContext("2d")!;
      const image = scene.texture(0, 64, dpr, dpr, palette)!.played;
      expectedCtx.imageSmoothingEnabled = true;
      expectedCtx.imageSmoothingQuality = "high";
      for (let phase = 0; phase < 8; phase += 1) {
        const centerSeconds = 500 + phase / 8 / 5.2;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        paintConveyor(ctx, scene, {
          width: 1800, height: 64, centerSeconds,
          renderedDurationSeconds: 1000.03, palette,
        });
        expectedCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
        expectedCtx.clearRect(0, 0, 1800, 64);
        expectedCtx.drawImage(image, 900 - centerSeconds * 5.2, 0, image.width / dpr, image.height / dpr);
        // Entirely before the fixed playhead; includes varied-height contours.
        const actual = ctx.getImageData(128 * dpr, 0, 656 * dpr, 64 * dpr).data;
        const expected = expectedCtx.getImageData(128 * dpr, 0, 656 * dpr, 64 * dpr).data;
        for (let i = 0; i < actual.length; i += 1) {
          if (actual[i] !== expected[i]) differingChannels += 1;
        }
      }
    }
    return differingChannels;
  });
  expect(mismatches).toBe(0);
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

test("the now-playing marker only moves while audio is actually running", async ({ page }) => {
  await page.route("**/api/jobs/job-1", async (route) => {
    await route.fulfill({ json: buildJob(4, "queued") });
  });
  await page.route("**/api/jobs/job-1/manifest", async (route) => {
    await route.fulfill({ json: buildManifest(4) });
  });
  await page.route("**/api/jobs/job-1/chunks/**", async (route) => {
    await route.fulfill({ body: "abc" });
  });

  await page.goto("/jobs/job-1");

  // Chunk 1 sits under the playhead, so it carries the now-playing marker.
  const marker = page.getByTestId("chunk-0-now-playing");
  await expect(marker).toBeVisible();

  /** Sample the marker over time; a moving equalizer produces differing frames. */
  async function sampleFrames(): Promise<string[]> {
    const frames: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      frames.push((await marker.screenshot()).toString("base64"));
      await page.waitForTimeout(220);
    }
    return frames;
  }

  // Idle: audio is not running, so the marker must be perfectly still. This is
  // what the player pauses every time a reader opens a job without pressing play.
  const paused = await sampleFrames();
  expect(new Set(paused).size).toBe(1);

  // ...and it must actually animate once playback is reported as running, so the
  // test cannot pass by the animation never being applied at all.
  await marker.evaluate((element) => {
    element.closest("[data-now-playing]")?.setAttribute("data-now-playing", "running");
  });
  const running = await sampleFrames();
  expect(new Set(running).size).toBeGreaterThan(1);
});

test("the playbar shrinks continuously with scroll instead of flipping states", async ({
  page,
}) => {
  await page.route("**/api/jobs/job-1", async (route) => {
    await route.fulfill({ json: buildJob(40, "queued") });
  });
  await page.route("**/api/jobs/job-1/manifest", async (route) => {
    await route.fulfill({ json: buildManifest(40) });
  });
  await page.route("**/api/jobs/job-1/activate", async (route) => {
    await route.fulfill({ json: buildJob(40, "playing") });
  });
  await page.route("**/api/jobs/job-1/playback", async (route) => {
    await route.fulfill({ json: buildJob(40, "playing") });
  });
  await page.route("**/api/jobs/job-1/chunks/**", async (route) => {
    await route.fulfill({ body: "abc" });
  });

  await page.goto("/jobs/job-1");
  await expect(page.getByText(/40\/40 chunks/i)).toBeVisible();

  /**
   * Reads the compacting geometry the browser actually resolved. Scroll
   * progress is a CSS custom property, so this is also the assertion that the
   * `calc()` interpolation is wired up (jsdom cannot check it).
   */
  const measure = async () =>
    page.evaluate(() => {
      const pick = (selector: string) => {
        const element = document.querySelector(selector);
        if (!element) throw new Error(`missing ${selector}`);
        const style = getComputedStyle(element);
        return {
          height: Number.parseFloat(style.height),
          opacity: Number.parseFloat(style.opacity),
          padding: Number.parseFloat(style.paddingTop),
        };
      };
      return {
        meta: pick('[data-testid="playbar-meta"]'),
        scrollY: window.scrollY,
        timeline: pick('[aria-label="Audio waveform timeline"]'),
        topRow: pick('[data-testid="playbar-top-row"]'),
      };
    });

  const scrollTo = async (top: number) => {
    await page.evaluate((value) => window.scrollTo({ top: value, behavior: "instant" }), top);
    // The write is rAF-coalesced, so wait for the next frame.
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => resolve(0))));
  };

  await scrollTo(0);
  const expanded = await measure();
  expect(expanded.topRow.padding).toBe(20);
  expect(expanded.timeline.height).toBe(80);
  expect(expanded.meta.opacity).toBe(1);

  // Halfway through the 220px range → halfway between expanded and compact.
  // A threshold-based implementation would still be fully expanded here.
  await scrollTo(110);
  const halfway = await measure();
  // Scroll anchoring must not drag the page back up as the bar shrinks: that
  // correction is what used to oscillate the bar between expanded and compact.
  expect(halfway.scrollY).toBe(110);
  expect(halfway.topRow.padding).toBeGreaterThan(0);
  expect(halfway.topRow.padding).toBeLessThan(20);
  expect(halfway.timeline.height).toBeGreaterThan(40);
  expect(halfway.timeline.height).toBeLessThan(80);
  expect(halfway.meta.opacity).toBeGreaterThan(0);
  expect(halfway.meta.opacity).toBeLessThan(1);

  await scrollTo(220);
  const compact = await measure();
  expect(compact.scrollY).toBe(220);
  expect(compact.topRow.padding).toBe(0);
  expect(compact.timeline.height).toBe(40);
  expect(compact.meta.opacity).toBe(0);

  // Monotonic shrink: no state flips, so no value may grow again on the way down.
  expect(halfway.topRow.padding).toBeLessThan(expanded.topRow.padding);
  expect(compact.topRow.padding).toBeLessThan(halfway.topRow.padding);
  expect(halfway.timeline.height).toBeLessThan(expanded.timeline.height);
  expect(compact.timeline.height).toBeLessThan(halfway.timeline.height);
});

test("playback speed lives in the reader settings sheet and badges the playbar", async ({
  page,
}) => {
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
  await expect(page.getByText("Playwright job")).toBeVisible();

  // The playbar keeps its space: no speed control until the panel is opened.
  await expect(page.getByRole("slider", { name: /playback speed slider/i })).toHaveCount(0);
  await expect(page.getByTestId("playback-rate-indicator")).toHaveCount(0);

  await page.getByRole("button", { name: "Reader settings" }).click();
  const panel = page.getByRole("dialog", { name: "Reader settings" });
  await expect(panel).toBeVisible();

  // One tap on a preset, no dragging (the whole mobile point).
  await panel.getByRole("button", { name: "1.5×", exact: true }).click();
  await expect(panel.getByRole("textbox", { name: /playback speed value/i })).toHaveValue("1.5");

  await page.getByRole("button", { name: "Close settings" }).click();
  await expect(page.getByTestId("playback-rate-indicator")).toHaveText("1.5×");
});

test.describe("reader settings sheet gestures", () => {
  test.use({ hasTouch: true });

  /** Dispatch one real `TouchEvent` on the open settings sheet. */
  async function fireTouch(
    page: import("@playwright/test").Page,
    type: "touchstart" | "touchmove" | "touchend",
    clientY: number,
  ) {
    await page.evaluate(
      ({ type, clientY }) => {
        const panel = document.querySelector<HTMLElement>(
          '[role="dialog"][aria-label="Reader settings"]',
        );
        if (!panel) throw new Error("settings sheet is not open");
        const makeTouch = (y: number) =>
          new Touch({ identifier: 1, target: panel, clientX: 180, clientY: y });
        const active = type === "touchend" ? [] : [makeTouch(clientY)];
        panel.dispatchEvent(
          new TouchEvent(type, {
            bubbles: true,
            cancelable: true,
            changedTouches: [makeTouch(clientY)],
            targetTouches: active,
            touches: active,
          }),
        );
      },
      { type, clientY },
    );
  }

  /**
   * Swipe the sheet from `fromY` to `toY` (screen coordinates: larger Y is
   * lower). Events are spaced out so the release velocity is realistic — a
   * same-task burst would register as an infinite-speed flick.
   */
  async function swipeSheet(
    page: import("@playwright/test").Page,
    fromY: number,
    toY: number,
    { stepMs = 30, steps = 6 } = {},
  ) {
    await fireTouch(page, "touchstart", fromY);
    for (let step = 1; step <= steps; step += 1) {
      await page.waitForTimeout(stepMs);
      await fireTouch(page, "touchmove", fromY + ((toY - fromY) * step) / steps);
    }
    await fireTouch(page, "touchend", toY);
  }

  test("the sheet paints over the phone dock and reaches the bottom of the screen", async ({
    page,
  }) => {
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
    await expect(page.getByTestId("reader-dock")).toBeVisible();

    await page.getByRole("button", { name: "Reader settings" }).click();
    const sheet = page.getByRole("dialog", { name: "Reader settings" });
    await expect(sheet).toBeVisible();

    // The sheet is portalled to <body>, so it covers the dock instead of being
    // clipped behind it. Hit-testing the dock's centre is the real paint-order
    // check: before the portal, the dock's own buttons answered here.
    const dockCovered = await page.evaluate(() => {
      const dock = document.querySelector('[data-testid="reader-dock"]')?.getBoundingClientRect();
      if (!dock) throw new Error("reader dock is not rendered");
      const hit = document.elementFromPoint(dock.left + dock.width / 2, dock.top + dock.height / 2);
      return !hit?.closest('[data-testid="reader-dock"]');
    });
    expect(dockCovered).toBe(true);

    // Anchored to the viewport bottom, and the last control is reachable.
    const geometry = await sheet.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return { bottom: rect.bottom, viewportHeight: window.innerHeight };
    });
    expect(Math.abs(geometry.bottom - geometry.viewportHeight)).toBeLessThanOrEqual(2);

    await sheet.getByRole("button", { name: "Reset to defaults" }).scrollIntoViewIfNeeded();
    await expect(sheet.getByRole("button", { name: "Reset to defaults" })).toBeVisible();
  });

  test("swiping down closes the sheet without scrolling the page behind it", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });

    await page.route("**/api/jobs/job-1", async (route) => {
      await route.fulfill({ json: buildJob(20, "queued") });
    });
    await page.route("**/api/jobs/job-1/manifest", async (route) => {
      await route.fulfill({ json: buildManifest(20) });
    });
    await page.route("**/api/jobs/job-1/chunks/**", async (route) => {
      await route.fulfill({ body: "abc" });
    });

    await page.goto("/jobs/job-1");
    await expect(page.getByText("Playwright job")).toBeVisible();

    // Scroll the reader first, so "the page moved" is detectable.
    await page.evaluate(() => window.scrollTo({ top: 120, behavior: "instant" }));
    await page.waitForTimeout(120);

    await page.getByRole("button", { name: "Reader settings" }).click();
    const sheet = page.getByRole("dialog", { name: "Reader settings" });
    await expect(sheet).toBeVisible();

    // A small downward swipe: the sheet follows the finger and springs back, and
    // the reader behind it must not move at all.
    await fireTouch(page, "touchstart", 300);
    await page.waitForTimeout(30);
    await fireTouch(page, "touchmove", 324);
    expect(await sheet.evaluate((element) => (element as HTMLElement).style.transform)).toBe(
      "translateY(24px)",
    );
    await fireTouch(page, "touchend", 324);
    expect(await page.evaluate(() => window.scrollY)).toBe(120);
    await expect(sheet).toBeVisible();
    await expect(sheet).toHaveCSS("transform", "none");

    // A real swipe dismisses it without tapping the close button.
    await swipeSheet(page, 300, 520);
    await expect(sheet).toHaveCount(0);
    expect(await page.evaluate(() => window.scrollY)).toBe(120);
    // The page is unlocked again once the sheet is gone.
    expect(await page.evaluate(() => document.body.style.overflow)).toBe("");
  });
});
