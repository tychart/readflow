import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useAppStore } from "../../state/store";
import type { RuntimeStatus, UserPreferences } from "../../types/api";
import { JobCreateForm } from "./JobCreateForm";

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

function mockApi(
  statusBody: RuntimeStatus | null,
  preferencesBody: UserPreferences | null = null,
) {
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/api/voices")) {
      return { ok: true, json: async () => VOICES };
    }
    if (url.endsWith("/api/status")) {
      return { ok: true, json: async () => statusBody };
    }
    if (url.endsWith("/api/preferences")) {
      return { ok: true, json: async () => preferencesBody };
    }
    return { ok: true, json: async (): Promise<null> => null };
  }) as unknown as typeof fetch;
}

/** The preference writes the form sent, in order. */
function preferenceWrites(): UserPreferences[] {
  const mock = globalThis.fetch as unknown as {
    mock: { calls: [RequestInfo | URL, RequestInit?][] };
  };
  return mock.mock.calls
    .filter(
      ([input, init]) =>
        String(input).endsWith("/api/preferences") && init?.method === "PUT",
    )
    .map(([, init]) => JSON.parse(String(init?.body)) as UserPreferences);
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

test("shows an error when voices fail to load", async () => {
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/api/voices")) {
      return {
        ok: false,
        status: 500,
        json: async () => ({ detail: "voices unavailable" }),
      } as unknown as Response;
    }
    return { ok: true, json: async () => null } as unknown as Response;
  }) as unknown as typeof fetch;

  render(<JobCreateForm onSubmit={vi.fn()} />);

  expect(await screen.findByRole("alert")).toHaveTextContent(
    /could not load voices/i,
  );
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
    expect((screen.getByLabelText(/model/i) as HTMLSelectElement).value).toBe(
      LARGE,
    ),
  );
  await waitFor(() =>
    expect((screen.getByLabelText(/voice/i) as HTMLSelectElement).value).toBe(
      "howard",
    ),
  );
});

test("opens on the model and voice this user picked last", async () => {
  // The remembered choice wins over the resident one: it is the user's own
  // default, and the residency notice still explains the wait.
  mockApi(status({ resident_model_id: SMALL, resident_voice_id: "suzy" }), {
    model_id: LARGE,
    voice_id: "howard",
  });

  render(<JobCreateForm onSubmit={vi.fn()} />);

  await waitFor(() =>
    expect((screen.getByLabelText(/model/i) as HTMLSelectElement).value).toBe(
      LARGE,
    ),
  );
  expect((screen.getByLabelText(/voice/i) as HTMLSelectElement).value).toBe(
    "howard",
  );
});

test("remembers a new selection for the next job", async () => {
  const user = userEvent.setup();
  mockApi(status());

  render(<JobCreateForm onSubmit={vi.fn()} />);
  await waitFor(() =>
    expect((screen.getByLabelText(/model/i) as HTMLSelectElement).value).toBe(
      SMALL,
    ),
  );

  await user.selectOptions(screen.getByLabelText(/voice/i), "howard");
  await waitFor(() => expect(preferenceWrites()).toHaveLength(1));
  expect(preferenceWrites()[0]).toEqual({
    model_id: SMALL,
    voice_id: "howard",
  });

  await user.selectOptions(screen.getByLabelText(/model/i), LARGE);
  await waitFor(() => expect(preferenceWrites()).toHaveLength(2));
  expect(preferenceWrites()[1]).toEqual({
    model_id: LARGE,
    voice_id: "howard",
  });
});

test("a failed preference write does not block creating the job", async () => {
  const user = userEvent.setup();
  const onSubmit = vi.fn().mockResolvedValue(undefined);
  globalThis.fetch = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/voices")) {
        return { ok: true, json: async () => VOICES } as unknown as Response;
      }
      if (url.endsWith("/api/preferences")) {
        return init?.method === "PUT"
          ? ({
              ok: false,
              status: 500,
              json: async () => ({}),
            } as unknown as Response)
          : ({ ok: true, json: async () => null } as unknown as Response);
      }
      return { ok: true, json: async () => null } as unknown as Response;
    },
  ) as unknown as typeof fetch;

  render(<JobCreateForm onSubmit={onSubmit} />);
  await screen.findByLabelText(/voice/i);
  await user.type(screen.getByLabelText(/text source/i), "Long-form content");
  await user.selectOptions(screen.getByLabelText(/voice/i), "howard");
  await user.click(screen.getByRole("button", { name: /create job/i }));

  await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
  const formData = onSubmit.mock.calls[0][0] as FormData;
  expect(formData.get("voice_id")).toBe("howard");
});

test("warns and confirms before scheduling a different model", async () => {
  const user = userEvent.setup();
  const onSubmit = vi.fn().mockResolvedValue(undefined);
  mockApi(status());

  render(<JobCreateForm onSubmit={onSubmit} />);
  await waitFor(() =>
    expect((screen.getByLabelText(/model/i) as HTMLSelectElement).value).toBe(
      SMALL,
    ),
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
    expect((screen.getByLabelText(/model/i) as HTMLSelectElement).value).toBe(
      SMALL,
    ),
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
    expect((screen.getByLabelText(/voice/i) as HTMLSelectElement).value).toBe(
      "suzy",
    ),
  );

  await user.type(screen.getByLabelText(/text source/i), "Long-form content");
  await user.selectOptions(screen.getByLabelText(/voice/i), "howard");

  expect(screen.getByTestId("residency-notice")).toHaveTextContent(
    /different voice/i,
  );
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
    expect((screen.getByLabelText(/model/i) as HTMLSelectElement).value).toBe(
      SMALL,
    ),
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
