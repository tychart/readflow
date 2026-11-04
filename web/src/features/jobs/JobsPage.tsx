import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useShallow } from "zustand/shallow";
import { useAppBootstrap } from "../../hooks/useAppBootstrap";
import { api } from "../../lib/api";
import { useAppStore } from "../../state/store";
import type { JobSummary } from "../../types/api";
import { JobCreateForm } from "./JobCreateForm";

function StatusBadge({ status }: { status: JobSummary["status"] }) {
  const colors: Record<JobSummary["status"], string> = {
    queued:
      "bg-[var(--hover-bg)] text-[var(--ink-secondary)] border border-[var(--line)]",
    rendering:
      "bg-[var(--amber)]/10 text-[var(--amber)] border border-[var(--amber)]/20",
    paused:
      "bg-[var(--hover-bg)] text-[var(--ink-secondary)] border border-[var(--line)]",
    playing:
      "bg-[var(--emerald)]/10 text-[var(--emerald)] border border-[var(--emerald)]/20",
    completed:
      "bg-[var(--emerald)]/10 text-[var(--emerald)] border border-[var(--emerald)]/20",
    failed:
      "bg-[var(--rose)]/10 text-[var(--rose)] border border-[var(--rose)]/20",
  };

  return (
    <span
      className={`rounded-md px-2.5 py-1 text-xs font-medium uppercase tracking-wider ${colors[status]}`}
    >
      {status}
    </span>
  );
}

export function JobsPage() {
  const jobs = useAppStore(useShallow((state) => Object.values(state.jobs)));
  const setJobs = useAppStore((state) => state.setJobs);
  const websocketStatus = useAppStore((state) => state.websocketStatus);
  const [error, setError] = useState<string | null>(null);
  const hasLocalMutationRef = useRef(false);
  const hasLiveJobs = useMemo(
    () =>
      jobs.some((job) => job.status !== "completed" && job.status !== "failed"),
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
          setError(
            loadError instanceof Error
              ? loadError.message
              : "Unable to load jobs",
          );
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
      setJobs({ ...currentJobs, [response.job.id]: response.job });
    } catch (createError) {
      setError(
        createError instanceof Error
          ? createError.message
          : "Unable to create job",
      );
    }
  };

  return (
    <div className="mx-auto w-full max-w-7xl px-4 py-6 md:px-6 md:py-8">
      {/* Explicit `minmax(0, …)` tracks on purpose. An implicit column (mobile) and
          a bare `1.2fr 1fr` track both take their automatic minimum from their
          content's min-content size; a truncated (nowrap) job title has a
          min-content width of the entire string, so the track grew past the
          viewport and the page scrolled sideways. */}
      <div className="grid grid-cols-[minmax(0,1fr)] gap-6 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
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
              Build a queue, let the scheduler keep buffers healthy, and jump
              into any reader when you are ready to listen.
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
                        <div
                          className="truncate text-sm font-medium text-[var(--ink-primary)]"
                          data-testid="job-card-title"
                          title={job.title ?? undefined}
                        >
                          {job.title ?? "Untitled job"}
                        </div>
                        <div className="mt-0.5 text-xs text-[var(--ink-secondary)]">
                          {job.total_chunks_completed}/
                          {job.total_chunks_emitted} chunks ready
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
    </div>
  );
}
