import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useShallow } from "zustand/shallow";

import { api } from "../../lib/api";
import { useAppBootstrap } from "../../hooks/useAppBootstrap";
import { useAppStore } from "../../state/store";
import type { JobSummary } from "../../types/api";
import { JobCreateForm } from "./JobCreateForm";

function StatusBadge({ status }: { status: JobSummary["status"] }) {
  const colors: Record<JobSummary["status"], string> = {
    queued: "bg-white/5 text-[var(--ink-secondary)] border border-[var(--line)]",
    rendering: "bg-amber-950/30 text-amber-400 border border-amber-900/30",
    paused: "bg-white/5 text-[var(--ink-secondary)] border border-[var(--line)]",
    playing: "bg-emerald-950/30 text-emerald-400 border border-emerald-900/30",
    completed: "bg-emerald-950/30 text-emerald-400 border border-emerald-900/30",
    failed: "bg-rose-950/30 text-rose-400 border border-rose-900/30",
  };

  return (
    <span className={`rounded-md px-2.5 py-1 text-xs font-medium uppercase tracking-wider ${colors[status]}`}>
      {status}
    </span>
  );
}

export function JobsPage() {
  const jobs = useAppStore(
    useShallow((state) => Object.values(state.jobs)),
  );
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
          const jobsMap: Record<string, JobSummary> = {};
          for (const job of nextJobs) {
            jobsMap[job.id] = job;
          }
          setJobs(jobsMap);
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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- setJobs is a stable Zustand selector
  }, []);

  const handleCreateJob = async (formData: FormData) => {
    setError(null);
    try {
      const response = await api.createJob(formData);
      hasLocalMutationRef.current = true;
      const currentJobs = useAppStore.getState().jobs;
      setJobs({ ...currentJobs, [response.job.id]: response.job });
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : "Unable to create job");
    }
  };

  return (
    <div className="grid gap-6 lg:grid-cols-[1.2fr_1fr]">
      <div className="space-y-4">
        {/* Page heading */}
        <div>
          <p className="text-xs uppercase tracking-[0.2em] text-[var(--ink-secondary)]">
            Queue
          </p>
          <h1 className="mt-1 text-3xl font-bold text-[var(--ink-primary)]">
            ReadFlow jobs
          </h1>
          <p className="mt-2 max-w-2xl text-sm leading-relaxed text-[var(--ink-secondary)]">
            Build a queue, let the scheduler keep buffers healthy, and jump into any
            reader when you are ready to listen.
          </p>
        </div>

        {/* Error banner */}
        {error ? (
          <div className="rounded-lg border border-rose-900/30 bg-rose-950/30 px-4 py-3 text-sm text-rose-400">
            {error}
          </div>
        ) : null}

        {/* Job queue */}
        <div className="rounded-xl border border-[var(--line)] bg-[var(--surface)] p-5">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-base font-semibold text-[var(--ink-primary)]">
              Live jobs
            </h2>
            <span className="text-xs text-[var(--ink-secondary)]">
              WebSocket: {hasLiveJobs ? websocketStatus : "idle"}
            </span>
          </div>

          <div className="space-y-2">
            {jobs.length === 0 ? (
              <div className="rounded-lg border border-dashed border-[var(--line)] px-4 py-10 text-center text-sm text-[var(--ink-secondary)]">
                No jobs yet. Create one to get started.
              </div>
            ) : (
              jobs.map((job) => (
                <Link
                  className="block rounded-lg border border-[var(--line)] bg-[var(--surface)] px-4 py-3 transition hover:bg-[var(--surface-raised)] hover:border-white/10"
                  key={job.id}
                  to={`/jobs/${job.id}`}
                >
                  <div className="flex items-center justify-between gap-4">
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium text-[var(--ink-primary)]">
                        {job.title ?? "Untitled job"}
                      </div>
                      <div className="mt-0.5 text-xs text-[var(--ink-secondary)]">
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

      {/* Create form */}
      <JobCreateForm onSubmit={handleCreateJob} />
    </div>
  );
}
