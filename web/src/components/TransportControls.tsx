import { SKIP_STEP_SECONDS } from "../hooks/usePlaybackShortcuts";
import { PlayButton, SkipButton } from "./PlaybackButtons";

export interface TransportControlsProps {
  /** Accessible name for the play/pause button ("Play" / "Pause" / "Resume"). */
  playLabel: string;
  showSpinner: boolean;
  showPauseIcon: boolean;
  playButtonSizePx: number;
  playIconSizePx: number;
  skipButtonSizePx: number;
  skipIconSizePx: number;
  gapPx: number;
  onPlay: () => void;
  onPause: () => void;
  onSkip: (deltaSeconds: number) => void;
}

/**
 * −10s / play-pause / +10s.
 *
 * Shared by the top playbar and the phone bottom dock so both surfaces stay
 * pixel-identical and only need one set of shortcut wiring.
 */
export function TransportControls({
  playLabel,
  showSpinner,
  showPauseIcon,
  playButtonSizePx,
  playIconSizePx,
  skipButtonSizePx,
  skipIconSizePx,
  gapPx,
  onPlay,
  onPause,
  onSkip,
}: TransportControlsProps) {
  return (
    <div className="flex shrink-0 items-center" style={{ gap: gapPx }}>
      <SkipButton
        direction="back"
        iconSizePx={skipIconSizePx}
        onClick={() => onSkip(-SKIP_STEP_SECONDS)}
        seconds={SKIP_STEP_SECONDS}
        shortcut="←"
        sizePx={skipButtonSizePx}
      />
      <PlayButton
        iconSizePx={playIconSizePx}
        label={playLabel}
        onClick={showPauseIcon ? onPause : onPlay}
        showPauseIcon={showPauseIcon}
        showSpinner={showSpinner}
        sizePx={playButtonSizePx}
        title={`${playLabel} (Space or K)`}
      />
      <SkipButton
        direction="forward"
        iconSizePx={skipIconSizePx}
        onClick={() => onSkip(SKIP_STEP_SECONDS)}
        seconds={SKIP_STEP_SECONDS}
        shortcut="→"
        sizePx={skipButtonSizePx}
      />
    </div>
  );
}
