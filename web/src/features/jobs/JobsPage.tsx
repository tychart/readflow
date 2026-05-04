import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";

import { api } from "../../lib/api";
import { useAppBootstrap } from "../../hooks/useAppBootstrap";
import { useAppStore } from "../../state/store";
import type { JobSummary } from "../../types/api";
import { JobCreateForm } from "./JobCreateForm";

function StatusBadge({ status }: { status: JobSummary["status"] }) {
  const colors: Record<JobSummary["status"], string> = {
    queued: "bg-stone-200 text-stone-700",
    rendering: "bg-amber-200 text-amber-800",
    paused: "bg-slate-200 text-slate-700",
    playing: "bg-emerald-200 text-emerald-800",
    completed: "bg-teal-200 text-teal-800",
    failed: "bg-rose-200 text-rose-800",
  };

  return <span className={`rounded-full px-3 py-1 text-xs font-semibold ${colors[status]}`}>{status}</span>;
}

export function JobsPage() {
  const jobs = useAppStore((state) => state.jobs);
  const setJobs = useAppStore((state) => state.setJobs);
  const websocketStatus = useAppStore((state) => state.websocketStatus);
  const [error, setError] = useState<string | null>(null);
  const hasLocalMutationRef = useRef(false);
  const hasLiveJobs = useMemo(
    () => jobs.some((job) => job.status !== "completed" && job.status !== "failed"),
    [jobs],
  );

  useAppBootstrap(hasLiveJobs);

  useEffect(() => {
    let cancelled = false;
    void api
      .listJobs()
      .then((nextJobs) => {
        if (!cancelled && !hasLocalMutationRef.current) {
          setJobs(nextJobs);
        }
      })
      .catch((loadError) => {
        if (!cancelled) {
          setError(loadError instanceof Error ? loadError.message : "Unable to load jobs");
        }
      });

    return () => {
      cancelled = true;
    };
  }, [setJobs]);

  const handleCreateJob = async (formData: FormData) => {
    setError(null);
    try {
      const response = await api.createJob(formData);
      hasLocalMutationRef.current = true;
      const currentJobs = useAppStore.getState().jobs;
      setJobs([response.job, ...currentJobs.filter((job) => job.id !== response.job.id)]);
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : "Unable to create job");
    }
  };

  return (
    <div className="grid gap-6 lg:grid-cols-[1.2fr_1fr]">
      <div className="space-y-4">
        <div>
          <p className="text-sm uppercase tracking-[0.3em] text-stone-600">Queue</p>
          <h1 className="display-font text-5xl">ReadFlow jobs</h1>
          <p className="mt-2 max-w-2xl text-stone-700">
            Build a queue, let the scheduler keep buffers healthy, and jump into any reader when you
            are ready to listen.
          </p>
        </div>
        {error ? <div className="rounded-2xl bg-rose-100 px-4 py-3 text-rose-800">{error}</div> : null}
        <div className="panel rounded-[2rem] p-6">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-xl font-semibold">Live jobs</h2>
            <span className="text-sm text-stone-600">
              WebSocket: {hasLiveJobs ? websocketStatus : "idle"}
            </span>
          </div>
          <div className="space-y-3">
            {jobs.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-stone-300 px-4 py-8 text-center text-stone-600">
                No jobs yet.
              </div>
            ) : (
              jobs.map((job) => (
                <Link
                  className="block rounded-3xl border border-stone-200 bg-white/70 px-5 py-4 transition hover:-translate-y-0.5"
                  key={job.id}
                  to={`/jobs/${job.id}`}
                >
                  <div className="flex items-center justify-between gap-4">
                    <div>
                      <div className="font-semibold">{job.title ?? "Untitled job"}</div>
                      <div className="text-sm text-stone-600">
                        {job.total_chunks_completed}/{job.total_chunks_emitted} chunks ready
                      </div>
                    </div>
                    <StatusBadge status={job.status} />
                  </div>
                </Link>
              ))
            )}
          </div>
        </div>
      </div>
      <JobCreateForm onSubmit={handleCreateJob} />
    </div>
  );
}
