import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { JobCreateForm } from "./JobCreateForm";
import { useAppStore } from "../../state/store";
import type { RuntimeStatus } from "../../types/api";

const SMALL = "Qwen/Qwen3-TTS-12Hz-0.6B-Base";
const LARGE = "Qwen/Qwen3-TTS-12Hz-1.7B-Base";

const VOICES = [
  { id: "suzy", display_name: "Suzy", description: null },
  { id: "howard", display_name: "Howard", description: null },
];

function status(overrides: Partial<RuntimeStatus> = {}): RuntimeStatus {
  return {
    resident_model_id: SMALL,
    resident_voice_id: "suzy",
    model_residency_batches: 10,
    voice_residency_batches: 3,
    ...overrides,
  };
}

function mockApi(statusBody: RuntimeStatus | null) {
  global.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/api/voices")) {
      return { ok: true, json: async () => VOICES };
    }
    if (url.endsWith("/api/status")) {
      return { ok: true, json: async () => statusBody };
    }
    return { ok: true, json: async () => null };
  }) as typeof fetch;
}

beforeEach(() => {
  localStorage.clear();
  useAppStore.setState({ runtimeStatus: null });
  mockApi(null);
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
  await user.selectOptions(screen.getByLabelText(/model/i), LARGE);
  await user.click(screen.getByRole("button", { name: /create job/i }));

  expect(onSubmit).toHaveBeenCalledTimes(1);
  const formData = onSubmit.mock.calls[0][0] as FormData;
  expect(formData.get("voice_id")).toBe("suzy");
  expect(formData.get("model_id")).toBe(LARGE);
});

test("shows model and voice dropdowns", async () => {
  render(<JobCreateForm onSubmit={vi.fn()} />);

  await screen.findByLabelText(/model/i);
  await screen.findByLabelText(/voice/i);
});

test("defaults to the model and voice currently in GPU memory", async () => {
  mockApi(status({ resident_model_id: LARGE, resident_voice_id: "howard" }));

  render(<JobCreateForm onSubmit={vi.fn()} />);

  await waitFor(() =>
    expect((screen.getByLabelText(/model/i) as HTMLSelectElement).value).toBe(LARGE),
  );
  await waitFor(() =>
    expect((screen.getByLabelText(/voice/i) as HTMLSelectElement).value).toBe("howard"),
  );
});

test("warns and confirms before scheduling a different model", async () => {
  const user = userEvent.setup();
  const onSubmit = vi.fn().mockResolvedValue(undefined);
  mockApi(status());

  render(<JobCreateForm onSubmit={onSubmit} />);
  await waitFor(() =>
    expect((screen.getByLabelText(/model/i) as HTMLSelectElement).value).toBe(SMALL),
  );

  await user.type(screen.getByLabelText(/text source/i), "Long-form content");
  await user.selectOptions(screen.getByLabelText(/model/i), LARGE);

  expect(screen.getByTestId("residency-notice")).toHaveTextContent(
    /waits until that model rotates/i,
  );

  await user.click(screen.getByRole("button", { name: /create job/i }));

  // The confirmation blocks the submit until accepted.
  expect(onSubmit).not.toHaveBeenCalled();
  expect(screen.getByRole("dialog")).toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: /schedule anyway/i }));
  expect(onSubmit).toHaveBeenCalledTimes(1);
});

test("going back from the model confirmation cancels the submit", async () => {
  const user = userEvent.setup();
  const onSubmit = vi.fn().mockResolvedValue(undefined);
  mockApi(status());

  render(<JobCreateForm onSubmit={onSubmit} />);
  await waitFor(() =>
    expect((screen.getByLabelText(/model/i) as HTMLSelectElement).value).toBe(SMALL),
  );

  await user.type(screen.getByLabelText(/text source/i), "Long-form content");
  await user.selectOptions(screen.getByLabelText(/model/i), LARGE);
  await user.click(screen.getByRole("button", { name: /create job/i }));

  await user.click(screen.getByRole("button", { name: /go back/i }));

  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(onSubmit).not.toHaveBeenCalled();
});

test("a voice-only change only shows the mild note", async () => {
  const user = userEvent.setup();
  const onSubmit = vi.fn().mockResolvedValue(undefined);
  mockApi(status());

  render(<JobCreateForm onSubmit={onSubmit} />);
  await waitFor(() =>
    expect((screen.getByLabelText(/voice/i) as HTMLSelectElement).value).toBe("suzy"),
  );

  await user.type(screen.getByLabelText(/text source/i), "Long-form content");
  await user.selectOptions(screen.getByLabelText(/voice/i), "howard");

  expect(screen.getByTestId("residency-notice")).toHaveTextContent(/different voice/i);
  await user.click(screen.getByRole("button", { name: /create job/i }));

  // No model reload, so no confirmation dialog.
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(onSubmit).toHaveBeenCalledTimes(1);
});

test("'don't warn again' skips later model confirmations", async () => {
  const user = userEvent.setup();
  const onSubmit = vi.fn().mockResolvedValue(undefined);
  mockApi(status());

  render(<JobCreateForm onSubmit={onSubmit} />);
  await waitFor(() =>
    expect((screen.getByLabelText(/model/i) as HTMLSelectElement).value).toBe(SMALL),
  );

  await user.type(screen.getByLabelText(/text source/i), "First");
  await user.selectOptions(screen.getByLabelText(/model/i), LARGE);
  await user.click(screen.getByRole("button", { name: /create job/i }));
  await user.click(screen.getByLabelText(/don't warn me/i));
  await user.click(screen.getByRole("button", { name: /schedule anyway/i }));
  expect(onSubmit).toHaveBeenCalledTimes(1);

  await user.type(screen.getByLabelText(/text source/i), "Second");
  await user.click(screen.getByRole("button", { name: /create job/i }));

  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(onSubmit).toHaveBeenCalledTimes(2);
});
