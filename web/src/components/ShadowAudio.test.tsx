import { render } from "@testing-library/react";
import type { RefObject } from "react";

import { ShadowAudio } from "./ShadowAudio";

function hostOf(container: HTMLElement) {
  return container.querySelector<HTMLElement>('[data-testid="reader-audio-host"]');
}

test("hosts the audio element in a shadow root that page-level queries cannot reach", () => {
  const audioRef: RefObject<HTMLAudioElement | null> = { current: null };
  const { container } = render(<ShadowAudio audioRef={audioRef} />);

  const host = hostOf(container);
  expect(host).not.toBeNull();
  expect(audioRef.current).toBeInstanceOf(HTMLAudioElement);
  expect(host!.shadowRoot?.querySelector("audio")).toBe(audioRef.current);

  // This is the whole point: media-speed extensions (e.g. Video Speed
  // Controller with audio support and "force last saved speed") discover
  // elements with `document.querySelectorAll("video,audio")` and then re-force
  // their own rate on every `ratechange`. Shadow trees are opaque to those
  // queries and to MutationObservers, so the element must stay unreachable here.
  expect(document.querySelectorAll("audio")).toHaveLength(0);
  expect(document.querySelector("audio")).toBeNull();
});

test("keeps one element identity across re-renders and clears the ref on unmount", () => {
  const audioRef: RefObject<HTMLAudioElement | null> = { current: null };
  const { container, rerender, unmount } = render(<ShadowAudio audioRef={audioRef} />);
  const first = audioRef.current;
  expect(first).toBeInstanceOf(HTMLAudioElement);

  rerender(<ShadowAudio audioRef={audioRef} />);
  expect(audioRef.current).toBe(first);
  expect(hostOf(container)!.shadowRoot?.querySelectorAll("audio")).toHaveLength(1);

  unmount();
  expect(audioRef.current).toBeNull();
});
