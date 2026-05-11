import { FormEvent, useEffect, useState } from "react";

import { api } from "../../lib/api";
import type { Voice } from "../../types/api";

interface JobCreateFormProps {
  onSubmit: (formData: FormData) => Promise<void>;
}

const MODEL_OPTIONS: { value: string; label: string }[] = [
  { value: "Qwen/Qwen3-TTS-12Hz-0.6B-Base", label: "Small (0.6B)" },
  { value: "Qwen/Qwen3-TTS-12Hz-1.7B-Base", label: "Large (1.7B)" },
];

export function JobCreateForm({ onSubmit }: JobCreateFormProps) {
  const [text, setText] = useState("");
  const [title, setTitle] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [voiceId, setVoiceId] = useState("");
  const [modelId, setModelId] = useState(MODEL_OPTIONS[0].value);
  const [voices, setVoices] = useState<Voice[]>([]);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    void api.listVoices().then((nextVoices) => {
      setVoices(nextVoices);
      if (nextVoices.length > 0 && !voiceId) {
        setVoiceId(nextVoices[0].id);
      }
    });
  }, [voiceId]);

  const handleSubmit = async (event: FormEvent) => {
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
  };

  return (
    <form className="panel rounded-[2rem] p-6" onSubmit={handleSubmit}>
      <div className="flex flex-col gap-4">
        <div>
          <label className="mb-2 block text-sm font-semibold uppercase tracking-[0.2em] text-stone-600" htmlFor="job-title">
            Job title
          </label>
          <input
            className="w-full rounded-2xl border border-stone-300 bg-white/70 px-4 py-3"
            id="job-title"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="Optional title"
          />
        </div>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="mb-2 block text-sm font-semibold uppercase tracking-[0.2em] text-stone-600" htmlFor="voice-select">
              Voice
            </label>
            <select
              className="w-full rounded-2xl border border-stone-300 bg-white/70 px-4 py-3"
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
            <label className="mb-2 block text-sm font-semibold uppercase tracking-[0.2em] text-stone-600" htmlFor="model-select">
              Model
            </label>
            <select
              className="w-full rounded-2xl border border-stone-300 bg-white/70 px-4 py-3"
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
        <div>
          <label className="mb-2 block text-sm font-semibold uppercase tracking-[0.2em] text-stone-600" htmlFor="job-text">
            Text source
          </label>
          <textarea
            className="min-h-56 w-full rounded-3xl border border-stone-300 bg-white/70 px-4 py-3"
            id="job-text"
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder="Paste long-form text here"
          />
        </div>
        <label className="rounded-2xl border border-dashed border-stone-400 bg-white/40 px-4 py-4 text-sm">
          <span className="font-semibold">Upload .txt instead</span>
          <input
            className="mt-2 block"
            type="file"
            accept=".txt"
            onChange={(event) => setFile(event.target.files?.[0] ?? null)}
          />
        </label>
        <button
          className="rounded-full bg-[var(--accent)] px-5 py-3 font-semibold text-white disabled:opacity-50"
          disabled={submitting || (!text.trim() && !file)}
          type="submit"
        >
          {submitting ? "Creating…" : "Create job"}
        </button>
      </div>
    </form>
  );
}
