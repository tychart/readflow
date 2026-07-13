import { type MutableRefObject, useRef } from "react";

/**
 * Props forwarded to the native `<audio>` element, excluding `ref`.
 */
type AudioProps = Omit<React.AudioHTMLAttributes<HTMLAudioElement>, "ref">;

interface SpeedSyncedAudioProps extends AudioProps {
  /** The playback speed to enforce on the audio element. */
  playbackRate: number;
  /** Ref object that the hook uses to access the `<audio>` element. */
  audioRef: MutableRefObject<HTMLAudioElement | null>;
}

/**
 * Thin wrapper around `<audio>` that uses an inline callback ref to keep
 * `playbackRate` and `defaultPlaybackRate` applied on every React commit.
 *
 * An inline callback ref is invoked by React on every render:
 *   - unmount path:  ref(null)
 *   - mount  path:  ref(element)
 *
 * This guarantees the audio element always has the correct speed applied,
 * even if the element is recreated or the browser resets the property.
 */
export function SpeedSyncedAudio({
  playbackRate,
  audioRef,
  ...rest
}: SpeedSyncedAudioProps) {
  const desiredRateRef = useRef(playbackRate);
  desiredRateRef.current = playbackRate;

  return (
    <audio
      {...rest}
      ref={(el) => {
        // eslint-disable-next-line no-console
        console.log("[ReadFlow] SpeedSyncedAudio ref callback", { hasEl: !!el, rate: desiredRateRef.current });
        audioRef.current = el;
        if (el) {
          el.playbackRate = desiredRateRef.current;
          el.defaultPlaybackRate = desiredRateRef.current;
          // eslint-disable-next-line no-console
          console.log("[ReadFlow] SpeedSyncedAudio ref set", { actualRate: el.playbackRate });
        }
      }}
    />
  );
}
