import { expect, test } from "@playwright/test";

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
    chunks: Array.from({ length: chunkCount }, (_, index) => ({
      index,
      status: "written",
      duration_seconds: 4,
      start_seconds: index * 4,
      plan_version: 1,
      voice_id: "suzy",
      segment_url: `/api/jobs/job-1/chunks/${index}`,
    })),
    failed_reason: null,
  };
}

function buildManifest(chunkCount: number) {
  return {
    mime_type: 'audio/mp4; codecs="mp4a.40.2"',
    init_segment_url: "/api/jobs/job-1/chunks/init",
    chunks: Array.from({ length: chunkCount }, (_, index) => ({
      index,
      status: "written",
      duration_seconds: 4,
      start_seconds: index * 4,
      plan_version: 1,
      voice_id: "suzy",
      segment_url: `/api/jobs/job-1/chunks/${index}`,
    })),
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
      {
        index: 0,
        status: "written",
        duration_seconds: 4,
        start_seconds: 0,
        plan_version: 1,
        voice_id: "suzy",
        segment_url: "/api/jobs/job-1/chunks/0",
      },
      {
        index: 1,
        status: "written",
        duration_seconds: 4,
        start_seconds: 4,
        plan_version: 1,
        voice_id: "suzy",
        segment_url: "/api/jobs/job-1/chunks/1",
      },
      {
        index: 2,
        status: "written",
        duration_seconds: 4,
        start_seconds: 8,
        plan_version: 1,
        voice_id: "suzy",
        segment_url: "/api/jobs/job-1/chunks/2",
      },
      {
        index: 3,
        status: "queued",
        duration_seconds: 0,
        start_seconds: 0,
        plan_version: 1,
        voice_id: "suzy",
        segment_url: null,
      },
      {
        index: 4,
        status: "rendering",
        duration_seconds: 0,
        start_seconds: 0,
        plan_version: 1,
        voice_id: "suzy",
        segment_url: null,
      },
      {
        index: 5,
        status: "written",
        duration_seconds: 4,
        start_seconds: 20,
        plan_version: 1,
        voice_id: "suzy",
        segment_url: "/api/jobs/job-1/chunks/5",
      },
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
  await expect(page.getByRole("heading", { name: "Chunk status" })).toBeVisible();
  await expect(page.getByText(/1\/1 chunks rendered/i)).toBeVisible();

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
          source_kind: "text",
          source_text: "Playwright text",
          plan_version: 1,
          chunks: [
            {
              index: 0,
              status: "written",
              duration_seconds: 4,
              start_seconds: 0,
              plan_version: 1,
              voice_id: "suzy",
              segment_url: "/api/jobs/job-1/chunks/0",
            },
            {
              index: 1,
              status: "written",
              duration_seconds: 4,
              start_seconds: 4,
              plan_version: 1,
              voice_id: "suzy",
              segment_url: "/api/jobs/job-1/chunks/1",
            },
          ],
          failed_reason: null,
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

  await expect(page.getByText(/2\/2 chunks rendered/i)).toBeVisible();
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
  await expect(page.getByRole("heading", { name: "Chunk status" })).toBeVisible();

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
  await expect(page.getByText(/Live reconnecting/i)).toBeVisible();
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
  await expect(page.getByText(/4\/6 chunks rendered/i)).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Chunk 4 expected but not received" }),
  ).toHaveAttribute("data-slot-state", "missing_expected");
  await expect(
    page.getByRole("button", { name: "Chunk 5 expected but not received" }),
  ).toHaveAttribute("data-slot-state", "missing_expected");
  await expect(page.getByRole("button", { name: "Chunk 6 ready after gap" })).toHaveAttribute(
    "data-slot-state",
    "ready_after_gap",
  );

  await page.getByRole("button", { name: "Chunk 6 ready after gap" }).click();

  await expect(page.getByText(/Playback anchor: Chunk 6/i)).toBeVisible();
});
