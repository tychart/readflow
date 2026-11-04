import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  getReaderTitle,
  resetReaderTitle,
  setReaderTitle,
  subscribeReaderTitle,
} from "./reader-title";

beforeEach(() => {
  resetReaderTitle();
});

describe("reader title store", () => {
  it("starts empty", () => {
    expect(getReaderTitle()).toBeNull();
  });

  it("publishes the title and only notifies on an actual change", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeReaderTitle(listener);

    setReaderTitle("Chapter 4");
    expect(getReaderTitle()).toBe("Chapter 4");
    expect(listener).toHaveBeenCalledTimes(1);

    // Re-publishing the same string must not re-render the header.
    setReaderTitle("Chapter 4");
    expect(listener).toHaveBeenCalledTimes(1);

    setReaderTitle("Chapter 5");
    expect(listener).toHaveBeenCalledTimes(2);

    unsubscribe();
    setReaderTitle(null);
    expect(listener).toHaveBeenCalledTimes(2);
    expect(getReaderTitle()).toBeNull();
  });

  it("treats a blank title as no title", () => {
    setReaderTitle("  ");
    expect(getReaderTitle()).toBeNull();
  });

  it("trims surrounding whitespace", () => {
    setReaderTitle("  Dune — Chapter 1  ");
    expect(getReaderTitle()).toBe("Dune — Chapter 1");
  });
});
