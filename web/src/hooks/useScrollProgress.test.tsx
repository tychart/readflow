import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { scrollProgressFor, useScrollProgressVar } from "./useScrollProgress";

afterEach(() => {
  cleanup();
  setScrollY(0);
});

function setScrollY(value: number) {
  Object.defineProperty(window, "scrollY", { configurable: true, value, writable: true });
}

/** Mounts a div that attaches the hook's callback ref to itself. */
function Probe({
  variable,
  forced,
}: {
  variable: string;
  forced?: number;
}) {
  const attachRef = useScrollProgressVar<HTMLDivElement>({ variable, forced });
  return <div data-testid="probe" ref={attachRef} />;
}

describe("scrollProgressFor", () => {
  it("maps the shrink range linearly onto 0..1", () => {
    expect(scrollProgressFor(0, 220)).toBe(0);
    expect(scrollProgressFor(110, 220)).toBe(0.5);
    expect(scrollProgressFor(220, 220)).toBe(1);
  });

  it("clamps overscroll and negative offsets", () => {
    expect(scrollProgressFor(-40, 220)).toBe(0);
    expect(scrollProgressFor(900, 220)).toBe(1);
  });

  it("treats a non-finite offset as the top of the page", () => {
    expect(scrollProgressFor(Number.NaN, 220)).toBe(0);
    expect(scrollProgressFor(0, 0)).toBe(0);
  });
});

describe("useScrollProgressVar", () => {
  it("writes the current progress as soon as the element attaches", () => {
    setScrollY(55);
    const { getByTestId } = render(<Probe variable="--probe-progress" />);

    expect(getByTestId("probe").style.getPropertyValue("--probe-progress")).toBe("0.250");
  });

  it("updates the variable on scroll without re-rendering the owner", async () => {
    const renders = vi.fn();
    function CountingProbe() {
      renders();
      return <Probe variable="--probe-progress" />;
    }
    const { getByTestId } = render(<CountingProbe />);
    const rendersAfterMount = renders.mock.calls.length;

    setScrollY(220);
    window.dispatchEvent(new Event("scroll"));

    await waitFor(() =>
      expect(getByTestId("probe").style.getPropertyValue("--probe-progress")).toBe("1.000"),
    );
    expect(renders.mock.calls.length).toBe(rendersAfterMount);
  });

  it("pins a forced value and ignores scroll", async () => {
    setScrollY(180);
    const { getByTestId } = render(<Probe forced={1} variable="--probe-progress" />);

    expect(getByTestId("probe").style.getPropertyValue("--probe-progress")).toBe("1.000");

    setScrollY(0);
    window.dispatchEvent(new Event("scroll"));
    // No listener is attached for a pinned value, so nothing can move it.
    await Promise.resolve();
    expect(getByTestId("probe").style.getPropertyValue("--probe-progress")).toBe("1.000");
  });
});
