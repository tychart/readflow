import { FormEvent, useCallback, useEffect, useRef, useState } from "react";

import { api } from "../../lib/api";
import type { Voice } from "../../types/api";

interface JobCreateFormProps {
  onSubmit: (formData: FormData) => Promise<void>;
}

const MODEL_OPTIONS: { value: string; label: string }[] = [
  { value: "Qwen/Qwen3-TTS-12Hz-0.6B-Base", label: "Small (0.6B)" },
  { value: "Qwen/Qwen3-TTS-12Hz-1.7B-Base", label: "Large (1.7B)" },
];

/* ── Reusable input style ─────────────────────────────────── */

function inputBase() {
  return [
    "w-full rounded-lg border border-[var(--line)] bg-[var(--surface)] px-3.5 py-2.5",
    "text-sm text-[var(--ink-primary)] placeholder:text-[var(--ink-secondary)]/50",
    "transition focus:outline-none focus:border-[var(--amber)] focus:ring-1 focus:ring-[var(--amber)]",
  ].join(" ");
}

function labelClass() {
  return "block text-xs font-medium uppercase tracking-wider text-[var(--ink-secondary)] mb-1.5";
}

/* ── Component ────────────────────────────────────────────── */

export function JobCreateForm({ onSubmit }: JobCreateFormProps) {
  const [text, setText] = useState("");
  const [title, setTitle] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [voiceId, setVoiceId] = useState("");
  const [modelId, setModelId] = useState(MODEL_OPTIONS[0].value);
  const [voices, setVoices] = useState<Voice[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const voiceIdRef = useRef(voiceId);
  voiceIdRef.current = voiceId;

  useEffect(() => {
    let isCancelled = false;
    void api
      .listVoices()
      .then((nextVoices) => {
        if (isCancelled) return;
        setVoices(nextVoices);
        if (nextVoices.length > 0 && !voiceIdRef.current) {
          setVoiceId(nextVoices[0].id);
        }
      });
    return () => {
      isCancelled = true;
    };
  }, []);

  const handleSubmit = useCallback(
    async (event: FormEvent) => {
      event.preventDefault();
      const formData = new FormData();
      if (title) {
        formData.append("title", title);
      }
      if (text.trim()) {
        formData.append("text", text.trim());
      }
      if (file) {
        formData.append("file", file);
      }
      formData.append("voice_id", voiceId);
      formData.append("model_id", modelId);
      setSubmitting(true);
      try {
        await onSubmit(formData);
        setText("");
        setTitle("");
        setFile(null);
      } finally {
        setSubmitting(false);
      }
    },
    [title, text, file, voiceId, modelId, onSubmit],
  );

  const canSubmit = (text.trim() || file) && !submitting;

  return (
    <form
      className="rounded-xl border border-[var(--line)] bg-[var(--surface)] p-5"
      onSubmit={handleSubmit}
    >
      <div className="flex flex-col gap-4">
        {/* Title */}
        <div>
          <label className={labelClass()} htmlFor="job-title">
            Job title
          </label>
          <input
            className={inputBase()}
            id="job-title"
            type="text"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="Optional title"
          />
        </div>

        {/* Voice + Model row */}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className={labelClass()} htmlFor="voice-select">
              Voice
            </label>
            <select
              className={inputBase()}
              id="voice-select"
              value={voiceId}
              onChange={(event) => setVoiceId(event.target.value)}
            >
              {voices.map((voice) => (
                <option key={voice.id} value={voice.id}>
                  {voice.display_name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className={labelClass()} htmlFor="model-select">
              Model
            </label>
            <select
              className={inputBase()}
              id="model-select"
              value={modelId}
              onChange={(event) => setModelId(event.target.value)}
            >
              {MODEL_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
        </div>

        {/* Text source */}
        <div>
          <label className={labelClass()} htmlFor="job-text">
            Text source
          </label>
          <textarea
            className={`${inputBase()} min-h-44 resize-y`}
            id="job-text"
            rows={8}
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder="Paste long-form text here…"
          />
        </div>

        {/* File upload */}
        <div className="rounded-lg border border-dashed border-[var(--line)] bg-[var(--canvas)]/50 p-4 transition hover:border-white/20">
          <span className="mb-2 block text-xs font-medium text-[var(--ink-secondary)]">
            Upload .txt instead
          </span>
          <input
            aria-label="Upload text file"
            className="block w-full text-xs text-[var(--ink-secondary)] file:mr-3 file:rounded-md file:border-0 file:bg-[var(--surface-raised)] file:px-3 file:py-1.5 file:text-xs file:font-medium file:text-[var(--ink-primary)] hover:file:brightness-110"
            type="file"
            accept=".txt"
            onChange={(event) => setFile(event.target.files?.[0] ?? null)}
          />
          {file ? (
            <p className="mt-1.5 text-xs text-[var(--ink-secondary)]">
              {file.name} ({(file.size / 1024).toFixed(1)} KB)
            </p>
          ) : null}
        </div>

        {/* Submit */}
        <button
          className={`rounded-lg px-5 py-2.5 text-sm font-semibold transition ${
            canSubmit
              ? "bg-[var(--amber)] text-[var(--canvas)] hover:brightness-110"
              : "cursor-not-allowed bg-[var(--surface-raised)] text-[var(--ink-secondary)]/50"
          }`}
          disabled={!canSubmit}
          type="submit"
        >
          {submitting ? "Creating…" : "Create job"}
        </button>
      </div>
    </form>
  );
}
