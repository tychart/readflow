import { useEffect, useMemo, useState } from "react";
import { useParams } from "react-router-dom";

import { api } from "../../lib/api";
import { useMediaSourcePlayer } from "../../lib/media-source";
import { useAppStore } from "../../state/store";
import type { JobDetail, JobManifest } from "../../types/api";

export function ReaderPage() {
  const { jobId = "" } = useParams();
  const voices = useAppStore((state) => state.voices);
  const lastEvent = useAppStore((state) => state.lastEvent);
  const [job, setJob] = useState<JobDetail | null>(null);
  const [manifest, setManifest] = useState<JobManifest | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const { audioRef, bufferedUntilSeconds, isReady } = useMediaSourcePlayer(manifest);

  const totalDuration = useMemo(
    () =>
      manifest?.chunks.reduce((sum, chunk) => Math.max(sum, chunk.start_seconds + chunk.duration_seconds), 0) ?? 0,
    [manifest],
  );
  const playedPercent = totalDuration > 0 ? ((audioRef.current?.currentTime ?? 0) / totalDuration) * 100 : 0;
  const bufferedPercent = totalDuration > 0 ? (bufferedUntilSeconds / totalDuration) * 100 : 0;

  useEffect(() => {
    const load = async () => {
      setLoading(true);
      try {
        const [nextJob, nextManifest] = await Promise.all([api.getJob(jobId), api.getManifest(jobId)]);
        setJob(nextJob);
        setManifest(nextManifest);
        setError(null);
      } catch (loadError) {
        setError(loadError instanceof Error ? loadError.message : "Unable to load job");
      } finally {
        setLoading(false);
      }
    };
    void load();
  }, [jobId]);

  useEffect(() => {
    const eventJob = lastEvent?.payload.job as JobDetail | undefined;
    if (!eventJob || eventJob.id !== jobId) {
      return;
    }
    void Promise.all([api.getJob(jobId), api.getManifest(jobId)]).then(([nextJob, nextManifest]) => {
      setJob(nextJob);
      setManifest(nextManifest);
    });
  }, [jobId, lastEvent]);

  const handlePlay = async () => {
    if (!job) {
      return;
    }
    await api.activateJob(job.id);
    await audioRef.current?.play();
    await api.updatePlayback(job.id, audioRef.current?.currentTime ?? 0, true);
  };

  const handlePause = async () => {
    if (!job) {
      return;
    }
    audioRef.current?.pause();
    await api.pauseJob(job.id);
    await api.updatePlayback(job.id, audioRef.current?.currentTime ?? 0, false);
  };

  const handleVoiceChange = async (voiceId: string) => {
    if (!job) {
      return;
    }
    const nextJob = await api.updateJobVoice(job.id, voiceId);
    setJob(nextJob);
  };

  if (loading) {
    return <div className="panel rounded-[2rem] p-8">Loading reader…</div>;
  }

  if (!job || error) {
    return <div className="panel rounded-[2rem] p-8 text-rose-700">{error ?? "Job not found"}</div>;
  }

  return (
    <div className="grid gap-6 xl:grid-cols-[1.3fr_0.9fr]">
      <div className="panel rounded-[2rem] p-8">
        <div className="mb-4 flex items-center justify-between gap-4">
          <div>
            <p className="text-sm uppercase tracking-[0.3em] text-stone-600">Reader</p>
            <h1 className="display-font text-4xl">{job.title ?? "Untitled job"}</h1>
          </div>
          <div className="rounded-full bg-white/80 px-4 py-2 text-sm text-stone-600">{job.status}</div>
        </div>
        <div className="rounded-3xl bg-white/60 p-5">
          <p className="whitespace-pre-wrap leading-8 text-stone-800">{job.source_text}</p>
        </div>
      </div>
      <div className="space-y-6">
        <div className="panel rounded-[2rem] p-6">
          <audio className="mb-4 w-full" controls ref={audioRef} />
          <div className="mb-4 h-4 overflow-hidden rounded-full bg-stone-200">
            <div className="h-full bg-stone-300" style={{ width: `${Math.min(bufferedPercent, 100)}%` }}>
              <div className="h-full bg-[var(--accent)]" style={{ width: `${Math.min(playedPercent, 100)}%` }} />
            </div>
          </div>
          <div className="mb-4 grid grid-cols-2 gap-3">
            <button
              className="rounded-full bg-[var(--accent)] px-4 py-3 font-semibold text-white"
              onClick={() => void handlePlay()}
              type="button"
            >
              Play
            </button>
            <button
              className="rounded-full border border-stone-300 bg-white/70 px-4 py-3 font-semibold"
              onClick={() => void handlePause()}
              type="button"
            >
              Pause
            </button>
          </div>
          <label className="mb-2 block text-sm font-semibold uppercase tracking-[0.2em] text-stone-600">
            Voice for future chunks
          </label>
          <select
            className="w-full rounded-2xl border border-stone-300 bg-white/70 px-4 py-3"
            onChange={(event) => void handleVoiceChange(event.target.value)}
            value={job.voice_id}
          >
            {voices.map((voice) => (
              <option key={voice.id} value={voice.id}>
                {voice.display_name}
              </option>
            ))}
          </select>
          <div className="mt-4 text-sm text-stone-600">
            Buffer ready: {bufferedUntilSeconds.toFixed(1)}s of {totalDuration.toFixed(1)}s.{" "}
            {isReady ? "MediaSource ready." : "Preparing stream…"}
          </div>
        </div>
        <div className="panel rounded-[2rem] p-6">
          <h2 className="mb-3 text-lg font-semibold">Chunk status</h2>
          <div className="space-y-2">
            {job.chunks.map((chunk) => (
              <div
                className="flex items-center justify-between rounded-2xl border border-stone-200 bg-white/60 px-4 py-3"
                key={chunk.index}
              >
                <span>Chunk {chunk.index + 1}</span>
                <span className="text-sm text-stone-600">
                  {chunk.status} {chunk.duration_seconds ? `• ${chunk.duration_seconds.toFixed(1)}s` : ""}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

