import { afterEach, describe, expect, it, vi } from "vitest";

import { formatAgeSeconds, formatAgeSince, formatDateTime } from "./time";

/**
 * The server sends every instant as ISO-8601 **with** `Z`. These tests pin the
 * two halves of the contract that jsdom can verify: the instant is rendered in
 * the viewer's own zone (not UTC by accident), and a zone-less string is
 * rejected instead of being silently read as local time.
 */
const INSTANT = "2025-11-15T18:04:11Z";

/** Run `fn` with the process timezone forced; `vi` restores it afterwards. */
function withTimeZone<T>(zone: string, fn: () => T): T {
  vi.stubEnv("TZ", zone);
  return fn();
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("formatDateTime", () => {
  it("renders the same instant differently in two zones", () => {
    const utc = withTimeZone("UTC", () => formatDateTime(INSTANT));
    const newYork = withTimeZone("America/New_York", () =>
      formatDateTime(INSTANT),
    );

    expect(utc).toContain("6:04");
    expect(newYork).toContain("1:04");
    expect(utc).not.toBe(newYork);
  });

  it("fails loudly on a zone-less string instead of guessing", () => {
    expect(() => formatDateTime("2025-11-15T18:04:11")).toThrow(/timezone/i);
  });

  it("fails loudly on an unparseable value", () => {
    expect(() => formatDateTime("not-a-dateZ")).toThrow(/invalid/i);
  });
});

describe("formatAgeSeconds", () => {
  it("formats seconds, minutes, hours and days", () => {
    expect(formatAgeSeconds(3)).toBe("3s ago");
    expect(formatAgeSeconds(90)).toBe("1m ago");
    expect(formatAgeSeconds(3 * 3600)).toBe("3h ago");
    expect(formatAgeSeconds(3 * 24 * 3600)).toBe("3d ago");
  });

  it("never renders a negative age", () => {
    expect(formatAgeSeconds(-30)).toBe("0s ago");
  });
});

describe("formatAgeSince", () => {
  it("computes the age from an ISO instant", () => {
    const now = Date.parse(INSTANT) + 90_000;
    expect(formatAgeSince(INSTANT, now)).toBe("1m ago");
  });

  it("rejects a zone-less instant", () => {
    expect(() => formatAgeSince("2025-11-15T18:04:11", 0)).toThrow(/timezone/i);
  });
});
