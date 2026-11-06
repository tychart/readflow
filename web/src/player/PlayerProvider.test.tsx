import { cleanup, render } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, expect, it } from "vitest";

import { PlayerProvider } from "./PlayerProvider";
import { resetPlayerStore, usePlayerStore } from "./player-store";

afterEach(() => {
  cleanup();
  resetPlayerStore();
});

function OpenJob() {
  useEffect(() => {
    usePlayerStore.getState().openJob({
      id: "job-1",
      title: "A book",
      isTerminal: false,
      audioEpoch: 0,
      folderId: null,
      nextJobId: null,
      previousJobId: null,
    });
    usePlayerStore.getState().setSource({
      manifest: null,
      anchorIndex: 0,
      anchorOffsetSeconds: 0,
      durationSeconds: 60,
    });
  }, []);
  return <p>reader page</p>;
}

it("keeps the audio element and the open job across a route change", () => {
  const { container, rerender } = render(
    <PlayerProvider>
      <OpenJob />
    </PlayerProvider>,
  );

  const host = container.querySelector<HTMLElement>(
    '[data-testid="reader-audio-host"]',
  );
  const audio = host?.shadowRoot?.querySelector("audio");
  expect(audio).toBeTruthy();
  expect(usePlayerStore.getState().job?.id).toBe("job-1");

  // Simulate navigating from the reader to the library: the routed children
  // unmount, but the provider (and therefore the media element) does not.
  rerender(
    <PlayerProvider>
      <p>library page</p>
    </PlayerProvider>,
  );

  const hostAfter = container.querySelector<HTMLElement>(
    '[data-testid="reader-audio-host"]',
  );
  expect(hostAfter).toBe(host);
  expect(hostAfter?.shadowRoot?.querySelector("audio")).toBe(audio);
  expect(usePlayerStore.getState().job?.id).toBe("job-1");
  expect(usePlayerStore.getState().durationSeconds).toBe(60);
});
