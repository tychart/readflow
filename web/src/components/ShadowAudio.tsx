import { useLayoutEffect, useRef, type RefObject } from "react";

export interface ShadowAudioProps {
  audioRef: RefObject<HTMLAudioElement | null>;
}

/**
 * Hosts the player's `<audio>` element inside a shadow root.
 *
 * This exists because page-wide media-speed extensions break the reader's own
 * speed control. "Video Speed Controller" with *Audio* enabled (and its
 * "Force last saved speed" option on) finds media elements with
 * `document.querySelectorAll("video,audio")`, attaches a controller, and then
 * re-forces its own rate on **every** `ratechange` event — including the one our
 * `playbackRate` write produces. The result is indistinguishable from a browser
 * bug: the slider and the badge move, but the element snaps back to the
 * extension's rate, so the audio and the clock never speed up.
 *
 * DOM queries and `MutationObserver` do not cross shadow boundaries, so an
 * element hosted here is simply not discoverable by that class of extension,
 * while remaining a normal media element for this app. That is preferable to
 * fighting the extension: re-asserting our rate makes `ratechange` fire again,
 * and the extension's handler runs in the capture phase (it can, and does, stop
 * propagation), so a fight is both unwinnable and a busy loop.
 *
 * The element is created imperatively rather than portalled: this is a layout
 * effect, so `audioRef.current` is populated *before* the player hook's effects
 * run in the same commit (they need the element to attach media listeners and
 * open the MediaSource). A portal would only exist after a second render.
 *
 * Note for future agents: `document.querySelector("audio")` no longer finds the
 * reader's element — tests reach it through the host's `shadowRoot` (see
 * `readerAudio` in `ReaderPage.test.tsx`).
 */
export function ShadowAudio({ audioRef }: ShadowAudioProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) {
      return;
    }

    const root = host.shadowRoot ?? host.attachShadow({ mode: "open" });
    const audio = document.createElement("audio");
    audio.setAttribute("aria-hidden", "true");
    root.append(audio);
    audioRef.current = audio;

    return () => {
      if (audioRef.current === audio) {
        audioRef.current = null;
      }
      audio.pause();
      audio.removeAttribute("src");
      audio.remove();
    };
  }, [audioRef]);

  // `display: none` is safe for an element with no controls: media playback and
  // engine events are independent of rendering (the previous light-DOM element
  // was hidden the same way).
  return (
    <div ref={hostRef} aria-hidden="true" className="hidden" data-testid="reader-audio-host" />
  );
}
