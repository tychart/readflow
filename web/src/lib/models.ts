/** TTS model choices shared by the create form, admin and reader. */
export const MODEL_OPTIONS: { value: string; label: string }[] = [
  { value: "Qwen/Qwen3-TTS-12Hz-0.6B-Base", label: "Small (0.6B)" },
  { value: "Qwen/Qwen3-TTS-12Hz-1.7B-Base", label: "Large (1.7B)" },
];

/** Human label for a model id, falling back to the raw id. */
export function modelLabel(modelId: string): string {
  return MODEL_OPTIONS.find((option) => option.value === modelId)?.label ?? modelId;
}
