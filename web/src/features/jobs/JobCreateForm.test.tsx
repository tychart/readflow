import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { JobCreateForm } from "./JobCreateForm";

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

