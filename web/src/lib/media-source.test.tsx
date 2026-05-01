import { render, waitFor } from "@testing-library/react";

import { useMediaSourcePlayer } from "./media-source";

test("appends init and written chunk segments", async () => {
  const buffers = [new ArrayBuffer(8), new ArrayBuffer(12)];
  global.fetch = vi
    .fn()
    .mockResolvedValueOnce({ ok: true, arrayBuffer: async () => buffers[0] })
    .mockResolvedValueOnce({ ok: true, arrayBuffer: async () => buffers[1] }) as typeof fetch;

  const manifest = {
    mime_type: 'audio/mp4; codecs="mp4a.40.2"',
    init_segment_url: "/api/jobs/one/chunks/init",
    chunks: [
      {
        index: 0,
        status: "written" as const,
        duration_seconds: 2,
        start_seconds: 0,
        plan_version: 1,
        voice_id: "suzy",
        segment_url: "/api/jobs/one/chunks/0",
      },
    ],
  };

  function Harness() {
    const { audioRef, isReady } = useMediaSourcePlayer(manifest);
    return (
      <div data-ready={isReady ? "yes" : "no"}>
        <audio ref={audioRef} />
      </div>
    );
  }

  const { container } = render(<Harness />);

  await waitFor(() => expect(container.firstChild).toHaveAttribute("data-ready", "yes"));
  await waitFor(() => expect(global.fetch).toHaveBeenCalledTimes(2));
});
