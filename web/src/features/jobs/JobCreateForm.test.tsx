import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { JobCreateForm } from "./JobCreateForm";

beforeEach(() => {
  global.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/api/voices")) {
      return {
        ok: true,
        json: async () => [
          { id: "suzy", display_name: "Suzy", description: null },
          { id: "howard", display_name: "Howard", description: null },
        ],
      };
    }
    return { ok: true, json: async () => null };
  }) as typeof fetch;
});

test("submits pasted text as form data", async () => {
  const user = userEvent.setup();
  const onSubmit = vi.fn().mockResolvedValue(undefined);

  render(<JobCreateForm onSubmit={onSubmit} />);

  await user.type(screen.getByLabelText(/job title/i), "Story");
  await user.type(screen.getByLabelText(/text source/i), "Long-form content");
  await user.click(screen.getByRole("button", { name: /create job/i }));

  expect(onSubmit).toHaveBeenCalledTimes(1);
  const formData = onSubmit.mock.calls[0][0] as FormData;
  expect(formData.get("title")).toBe("Story");
  expect(formData.get("text")).toBe("Long-form content");
});

test("includes voice_id and model_id in form data", async () => {
  const user = userEvent.setup();
  const onSubmit = vi.fn().mockResolvedValue(undefined);

  render(<JobCreateForm onSubmit={onSubmit} />);

  await user.type(screen.getByLabelText(/job title/i), "Story");
  await user.type(screen.getByLabelText(/text source/i), "Long-form content");
  await user.selectOptions(screen.getByLabelText(/voice/i), "suzy");
  await user.selectOptions(screen.getByLabelText(/model/i), "Qwen/Qwen3-TTS-12Hz-1.7B-Base");
  await user.click(screen.getByRole("button", { name: /create job/i }));

  expect(onSubmit).toHaveBeenCalledTimes(1);
  const formData = onSubmit.mock.calls[0][0] as FormData;
  expect(formData.get("voice_id")).toBe("suzy");
  expect(formData.get("model_id")).toBe("Qwen/Qwen3-TTS-12Hz-1.7B-Base");
});

test("shows model and voice dropdowns", async () => {
  render(<JobCreateForm onSubmit={vi.fn()} />);

  await screen.findByLabelText(/model/i);
  await screen.findByLabelText(/voice/i);
});
