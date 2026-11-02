import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ErrorBoundary } from "./ErrorBoundary";

let shouldThrow = true;

function Boom() {
  if (shouldThrow) {
    throw new Error("kaboom");
  }
  return <p>recovered</p>;
}

const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

afterAll(() => {
  consoleError.mockRestore();
});

beforeEach(() => {
  shouldThrow = true;
});

test("renders a readable fallback instead of unmounting the app", () => {
  render(
    <ErrorBoundary>
      <Boom />
    </ErrorBoundary>,
  );

  expect(
    screen.getByRole("alert", { name: /unexpected error/i }),
  ).toBeInTheDocument();
  expect(screen.getByText(/kaboom/)).toBeInTheDocument();
});

test("re-renders the children after the error is resolved and Try again is used", async () => {
  const user = userEvent.setup();
  render(
    <ErrorBoundary>
      <Boom />
    </ErrorBoundary>,
  );

  shouldThrow = false;
  await user.click(screen.getByRole("button", { name: /try again/i }));

  expect(screen.getByText("recovered")).toBeInTheDocument();
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});
