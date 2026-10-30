import { resolvePlayButtonLabel, resolveShowSpinner } from "../features/reader/transport";
import type { ConveyorWindowSize } from "../state/reader-settings";
import type { TimelineSlotData } from "../types/timeline";
import { ChunkConveyor } from "./ChunkConveyor";
import { TransportControls } from "./TransportControls";

export interface ReaderDockProps {
  slots: TimelineSlotData[];
  waveforms: Map<number, Float32Array>;
  playheadSeconds: number;
  maxSeekSeconds: number;
  motion: "animated" | "reduced";
  windowSizeSetting: ConveyorWindowSize;
  /** Playback rate, so the conveyor slides at the same speed as the audio. */
  playbackRate: number;
  isAutoplayBlocked: boolean;
  /** The client is still fetching/priming the requested audio. */
  isLoadingAudio: boolean;
  isPlaying: boolean;
  isWaitingForData: boolean;
  playIntent: boolean;
  onPlay: () => void;
  onPause: () => void;
  onSkip: (deltaSeconds: number) => void;
  onSeek: (chunkIndex: number, seconds: number) => void;
}

/**
 * Phone bottom dock: transport plus the chunk conveyor.
 *
 * On a portrait phone the sticky top playbar is out of thumb reach, and its
 * whole-document waveform has no resolution to seek with. Both jobs move here,
 * and the top bar keeps the overview, the clock and the settings gear.
 *
 * `paddingBottom` honours `env(safe-area-inset-bottom)` so the controls clear
 * the home indicator on iOS.
 */
export function ReaderDock({
  slots,
  waveforms,
  playheadSeconds,
  maxSeekSeconds,
  motion,
  windowSizeSetting,
  playbackRate,
  isAutoplayBlocked,
  isLoadingAudio,
  isPlaying,
  isWaitingForData,
  playIntent,
  onPlay,
  onPause,
  onSkip,
  onSeek,
}: ReaderDockProps) {
  return (
    <div
      className="fixed inset-x-0 bottom-0 z-40 border-t border-[var(--line)] bg-[var(--surface)] px-3 pt-2"
      data-testid="reader-dock"
      style={{
        boxShadow: "0 -4px 16px rgba(0,0,0,0.35)",
        paddingBottom: "max(8px, env(safe-area-inset-bottom))",
      }}
    >
      <div className="mx-auto flex w-full max-w-2xl flex-col gap-2">
        <div className="flex justify-center">
          <TransportControls
            gap="12px"
            onPause={onPause}
            onPlay={onPlay}
            onSkip={onSkip}
            playButtonSize="52px"
            playIconSize="18px"
            playLabel={resolvePlayButtonLabel({ isAutoplayBlocked, playIntent })}
            showPauseIcon={isPlaying || playIntent}
            showSpinner={resolveShowSpinner({
              isAutoplayBlocked,
              isLoadingAudio,
              isPlaying,
              isWaitingForData,
              playIntent,
            })}
            skipButtonSize="40px"
            skipIconSize="16px"
          />
        </div>
        <ChunkConveyor
          isPlaying={isPlaying}
          maxSeekSeconds={maxSeekSeconds}
          motion={motion}
          onSeek={onSeek}
          playbackRate={playbackRate}
          playheadSeconds={playheadSeconds}
          slots={slots}
          stripHeightPx={56}
          waveforms={waveforms}
          windowSizeSetting={windowSizeSetting}
        />
      </div>
    </div>
  );
}
