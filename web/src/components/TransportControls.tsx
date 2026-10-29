import { SKIP_STEP_SECONDS } from "../hooks/usePlaybackShortcuts";
import { PlayButton, SkipButton } from "./PlaybackButtons";

export interface TransportControlsProps {
  /** Accessible name for the play/pause button ("Play" / "Pause" / "Resume"). */
  playLabel: string;
  showSpinner: boolean;
  showPauseIcon: boolean;
  /**
   * Button/icon sizes and gap as CSS lengths. The playbar passes `calc()` values
   * so they shrink continuously with scroll; the phone dock passes fixed px.
   */
  playButtonSize: string;
  playIconSize: string;
  skipButtonSize: string;
  skipIconSize: string;
  gap: string;
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
  playButtonSize,
  playIconSize,
  skipButtonSize,
  skipIconSize,
  gap,
  onPlay,
  onPause,
  onSkip,
}: TransportControlsProps) {
  return (
    <div className="flex shrink-0 items-center" style={{ gap }}>
      <SkipButton
        direction="back"
        iconSize={skipIconSize}
        onClick={() => onSkip(-SKIP_STEP_SECONDS)}
        seconds={SKIP_STEP_SECONDS}
        shortcut="←"
        size={skipButtonSize}
      />
      <PlayButton
        iconSize={playIconSize}
        label={playLabel}
        onClick={showPauseIcon ? onPause : onPlay}
        showPauseIcon={showPauseIcon}
        showSpinner={showSpinner}
        size={playButtonSize}
        title={`${playLabel} (Space or K)`}
      />
      <SkipButton
        direction="forward"
        iconSize={skipIconSize}
        onClick={() => onSkip(SKIP_STEP_SECONDS)}
        seconds={SKIP_STEP_SECONDS}
        shortcut="→"
        size={skipButtonSize}
      />
    </div>
  );
}
