import { FormEvent, useCallback, useEffect, useState } from "react";

import { ConfirmDialog } from "../../components/ConfirmDialog";
import { useRuntimeStatus } from "../../hooks/useRuntimeStatus";
import { api } from "../../lib/api";
import { MODEL_OPTIONS, modelLabel } from "../../lib/models";
import type { Voice } from "../../types/api";

interface JobCreateFormProps {
  onSubmit: (formData: FormData) => Promise<void>;
}

/** Remembered so a user who accepted the wait once is not asked every time. */
const SKIP_MODEL_WARNING_KEY = "readflow.job-form.skip-model-warning";

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

function readSkipModelWarning(): boolean {
  try {
    return localStorage.getItem(SKIP_MODEL_WARNING_KEY) === "1";
  } catch {
    return false;
  }
}

function writeSkipModelWarning(skip: boolean) {
  try {
    localStorage.setItem(SKIP_MODEL_WARNING_KEY, skip ? "1" : "0");
  } catch {
    /* storage may be unavailable; the warning just shows again */
  }
}

/* ── Component ────────────────────────────────────────────── */

export function JobCreateForm({ onSubmit }: JobCreateFormProps) {
  const [text, setText] = useState("");
  const [title, setTitle] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [voiceId, setVoiceId] = useState("");
  const [modelId, setModelId] = useState(MODEL_OPTIONS[0].value);
  const [voices, setVoices] = useState<Voice[]>([]);
  const [voiceTouched, setVoiceTouched] = useState(false);
  const [modelTouched, setModelTouched] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [pendingFormData, setPendingFormData] = useState<FormData | null>(null);
  const [dontAskAgain, setDontAskAgain] = useState(false);
  const [skipModelWarning, setSkipModelWarning] = useState(readSkipModelWarning);

  const status = useRuntimeStatus();
  const residentModelId = status?.resident_model_id ?? null;
  const residentVoiceId = status?.resident_voice_id ?? null;
  const modelResidencyBatches = status?.model_residency_batches ?? 10;
  const voiceResidencyBatches = status?.voice_residency_batches ?? 3;
  const canSubmit = (text.trim() || file) && !submitting;

  useEffect(() => {
    let isCancelled = false;
    void api
      .listVoices()
      .then((nextVoices) => {
        if (isCancelled) return;
        setVoices(nextVoices);
      });
    return () => {
      isCancelled = true;
    };
  }, []);

  // Default to the model/voice currently in GPU memory, until the user picks.
  useEffect(() => {
    if (modelTouched || !residentModelId) return;
    if (MODEL_OPTIONS.some((option) => option.value === residentModelId)) {
      setModelId(residentModelId);
    }
  }, [residentModelId, modelTouched]);

  useEffect(() => {
    if (voiceTouched) return;
    if (residentVoiceId && voices.some((voice) => voice.id === residentVoiceId)) {
      setVoiceId(residentVoiceId);
      return;
    }
    if (!voiceId && voices.length > 0) {
      setVoiceId(voices[0].id);
    }
  }, [residentVoiceId, voices, voiceTouched, voiceId]);

  const voiceLabel = useCallback(
    (id: string | null) => voices.find((voice) => voice.id === id)?.display_name ?? id ?? "—",
    [voices],
  );

  const modelDiffers = Boolean(residentModelId && modelId !== residentModelId);
  const voiceDiffers = Boolean(
    residentModelId && !modelDiffers && residentVoiceId && voiceId !== residentVoiceId,
  );

  const buildFormData = useCallback(() => {
    const formData = new FormData();
    if (title) formData.append("title", title);
    if (text.trim()) formData.append("text", text.trim());
    if (file) formData.append("file", file);
    formData.append("voice_id", voiceId);
    formData.append("model_id", modelId);
    return formData;
  }, [title, text, file, voiceId, modelId]);

  const submit = useCallback(
    async (formData: FormData) => {
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
    [onSubmit],
  );

  const handleSubmit = useCallback(
    (event: FormEvent) => {
      event.preventDefault();
      if (!canSubmit) return;
      const formData = buildFormData();
      // A different model means a full GPU model reload, so confirm the wait.
      // A different voice is cheap and only gets the inline note.
      if (modelDiffers && !skipModelWarning) {
        setPendingFormData(formData);
        return;
      }
      void submit(formData);
    },
    [buildFormData, canSubmit, modelDiffers, skipModelWarning, submit],
  );

  const handleConfirmSubmit = useCallback(() => {
    if (dontAskAgain) {
      writeSkipModelWarning(true);
      setSkipModelWarning(true);
    }
    const formData = pendingFormData;
    setPendingFormData(null);
    setDontAskAgain(false);
    if (formData) void submit(formData);
  }, [dontAskAgain, pendingFormData, submit]);

  const handleCancelSubmit = useCallback(() => {
    setPendingFormData(null);
    setDontAskAgain(false);
  }, []);

  let residencyNotice: { tone: "warn" | "info" | "good"; text: string } | null = null;
  if (residentModelId) {
    const residentVoice = voiceLabel(residentVoiceId);
    if (modelDiffers) {
      residencyNotice = {
        tone: "warn",
        text:
          `Currently rendering ${modelLabel(residentModelId)} · ${residentVoice}. ` +
          `Your job uses ${modelLabel(modelId)}; it waits until that model rotates ` +
          `(about ${modelResidencyBatches} batches) or its queue finishes.`,
      };
    } else if (voiceDiffers) {
      residencyNotice = {
        tone: "info",
        text:
          `Different voice (${residentVoice} → ${voiceLabel(voiceId)}). ` +
          `No model reload — it starts after about ${voiceResidencyBatches} batches.`,
      };
    } else {
      residencyNotice = {
        tone: "good",
        text: `Currently rendering ${modelLabel(residentModelId)} · ${residentVoice}. Your job joins the same queue.`,
      };
    }
  }

  const noticeClass = {
    warn: "border-[var(--amber)]/30 bg-[var(--amber)]/10 text-[var(--amber)]",
    info: "border-[var(--line)] bg-[var(--surface-raised)] text-[var(--ink-secondary)]",
    good: "border-[var(--emerald)]/20 bg-[var(--emerald)]/10 text-[var(--emerald)]",
  };

  return (
    <>
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
                onChange={(event) => {
                  setVoiceTouched(true);
                  setVoiceId(event.target.value);
                }}
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
                onChange={(event) => {
                  setModelTouched(true);
                  setModelId(event.target.value);
                }}
              >
                {MODEL_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {/* Residency notice — what the GPU is doing right now */}
          {residencyNotice ? (
            <p
              className={`rounded-lg border px-3.5 py-2.5 text-xs ${noticeClass[residencyNotice.tone]}`}
              data-testid="residency-notice"
            >
              {residencyNotice.text}
            </p>
          ) : null}

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

      {pendingFormData ? (
        <ConfirmDialog
          cancelLabel="Go back"
          confirmLabel="Schedule anyway"
          description={
            <>
              <p>
                Currently rendering {modelLabel(residentModelId ?? "")} ·{" "}
                {voiceLabel(residentVoiceId)}.
              </p>
              <p className="mt-2">
                Your job uses {modelLabel(modelId)}, so it waits until the current
                model rotates (about {modelResidencyBatches} batches) or its queue
                finishes. The GPU can only hold one model at a time.
              </p>
            </>
          }
          onCancel={handleCancelSubmit}
          onConfirm={handleConfirmSubmit}
          title="Use a different model?"
        >
          <label className="mt-3 flex items-center gap-2 text-xs text-[var(--ink-secondary)]">
            <input
              checked={dontAskAgain}
              onChange={(event) => setDontAskAgain(event.target.checked)}
              type="checkbox"
            />
            Don&apos;t warn me about model changes again
          </label>
        </ConfirmDialog>
      ) : null}
    </>
  );
}
