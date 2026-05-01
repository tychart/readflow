import { MemoryRouter, Route, Routes } from "react-router-dom";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { ReaderPage } from "./ReaderPage";
import { useAppStore } from "../../state/store";

test("loads a job and sends play plus voice actions", async () => {
  const user = userEvent.setup();
  useAppStore.setState({
    jobs: [],
    voices: [
      { id: "suzy", display_name: "Suzy", description: null },
      { id: "male_default", display_name: "Milo", description: null },
    ],
    adminState: null,
    websocketStatus: "open",
    lastEvent: null,
  });

  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/api/jobs/job-1")) {
      return {
        ok: true,
        json: async () => ({
          id: "job-1",
          title: "Reader job",
          status: "queued",
          voice_id: "suzy",
          model_id: "qwen3-tts-0.6b",
          is_active_listening: false,
          total_chunks_emitted: 1,
          total_chunks_completed: 1,
          buffered_seconds: 4,
          completed_seconds: 0,
          source_kind: "text",
          source_text: "A reader page test.",
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
          ],
          failed_reason: null,
        }),
      };
    }
    if (url.endsWith("/api/jobs/job-1/manifest")) {
      return {
        ok: true,
        json: async () => ({
          mime_type: 'audio/mp4; codecs="mp4a.40.2"',
          init_segment_url: "/api/jobs/job-1/chunks/init",
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
          ],
        }),
      };
    }
    if (url.endsWith("/activate") || url.endsWith("/pause") || url.endsWith("/playback")) {
      return {
        ok: true,
        json: async () => ({
          id: "job-1",
          title: "Reader job",
          status: init?.body ? "playing" : "queued",
          voice_id: "suzy",
          model_id: "qwen3-tts-0.6b",
          is_active_listening: true,
          total_chunks_emitted: 1,
          total_chunks_completed: 1,
          buffered_seconds: 4,
          completed_seconds: 0,
          source_kind: "text",
          source_text: "A reader page test.",
          plan_version: 1,
          chunks: [],
          failed_reason: null,
        }),
      };
    }
    if (url.endsWith("/voice")) {
      return {
        ok: true,
        json: async () => ({
          id: "job-1",
          title: "Reader job",
          status: "queued",
          voice_id: "male_default",
          model_id: "qwen3-tts-0.6b",
          is_active_listening: false,
          total_chunks_emitted: 1,
          total_chunks_completed: 1,
          buffered_seconds: 4,
          completed_seconds: 0,
          source_kind: "text",
          source_text: "A reader page test.",
          plan_version: 2,
          chunks: [],
          failed_reason: null,
        }),
      };
    }
    return { ok: true, arrayBuffer: async () => new ArrayBuffer(8) };
  });
  global.fetch = fetchMock as typeof fetch;
  HTMLMediaElement.prototype.play = vi.fn().mockResolvedValue(undefined);
  HTMLMediaElement.prototype.pause = vi.fn();

  render(
    <MemoryRouter initialEntries={["/jobs/job-1"]}>
      <Routes>
        <Route element={<ReaderPage />} path="/jobs/:jobId" />
      </Routes>
    </MemoryRouter>,
  );

  await waitFor(() => expect(screen.getByText("Reader job")).toBeInTheDocument());
  await user.click(screen.getByRole("button", { name: /play/i }));
  await user.selectOptions(screen.getByRole("combobox"), "male_default");

  expect(fetchMock).toHaveBeenCalledWith("/api/jobs/job-1/activate", expect.any(Object));
  expect(fetchMock).toHaveBeenCalledWith("/api/jobs/job-1/voice", expect.any(Object));
});

