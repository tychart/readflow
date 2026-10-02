import { render, screen, cleanup, act } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";

import { useElementWidth } from "./useElementWidth";

/**
 * jsdom has no ResizeObserver, and the hook's whole point is attaching to an
 * element that may not exist on the first commit — so both paths are pinned
 * here with a controllable fake.
 */
class FakeResizeObserver {
  static instances: FakeResizeObserver[] = [];

  private readonly callback: ResizeObserverCallback;
  observed: Element[] = [];

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
    FakeResizeObserver.instances.push(this);
  }

  observe(element: Element) {
    this.observed.push(element);
  }

  unobserve() {}

  disconnect() {
    this.observed = [];
  }

  emit(width: number) {
    this.callback(
      [{ contentRect: { width } } as ResizeObserverEntry],
      this as unknown as ResizeObserver,
    );
  }
}

function Probe({ mounted }: { mounted: boolean }) {
  const { attachRef, width } = useElementWidth<HTMLDivElement>();
  return (
    <div>
      {mounted ? <div data-testid="target" ref={attachRef} /> : null}
      <span data-testid="width">{String(width)}</span>
    </div>
  );
}

afterEach(() => {
  cleanup();
  FakeResizeObserver.instances = [];
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("useElementWidth", () => {
  test("starts observing an element that only mounts on a later commit", () => {
    vi.stubGlobal("ResizeObserver", FakeResizeObserver);

    const { rerender } = render(<Probe mounted={false} />);
    expect(FakeResizeObserver.instances).toHaveLength(0);
    expect(screen.getByTestId("width")).toHaveTextContent("0");

    rerender(<Probe mounted />);
    expect(FakeResizeObserver.instances).toHaveLength(1);
    expect(FakeResizeObserver.instances[0]?.observed).toHaveLength(1);

    act(() => FakeResizeObserver.instances[0]?.emit(320));
    expect(screen.getByTestId("width")).toHaveTextContent("320");
  });

  test("rounds the observed width and ignores a zero measurement", () => {
    vi.stubGlobal("ResizeObserver", FakeResizeObserver);

    render(<Probe mounted />);
    const observer = FakeResizeObserver.instances[0];
    expect(observer).toBeDefined();

    act(() => observer?.emit(319.6));
    expect(screen.getByTestId("width")).toHaveTextContent("320");

    // A zero width means "not laid out yet"; keep the last real measurement.
    act(() => observer?.emit(0));
    expect(screen.getByTestId("width")).toHaveTextContent("320");
  });

  test("disconnects when the element unmounts", () => {
    vi.stubGlobal("ResizeObserver", FakeResizeObserver);

    const { rerender } = render(<Probe mounted />);
    const observer = FakeResizeObserver.instances[0];
    expect(observer?.observed).toHaveLength(1);

    rerender(<Probe mounted={false} />);
    expect(observer?.observed).toHaveLength(0);
  });

  test("takes a single measurement when ResizeObserver is unavailable", () => {
    // Patch the prototype before render: the fallback measures from the attach
    // callback during the first commit, where the element does not exist yet.
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      width: 250.4,
    } as DOMRect);
    vi.stubGlobal("ResizeObserver", undefined);

    render(<Probe mounted />);
    expect(screen.getByTestId("width")).toHaveTextContent("250");
  });
});
