import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
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
          model_id: "qwen3-tts-0.6b",
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
        { id: "male_default", display_name: "Milo", description: null },
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

