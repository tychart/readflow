import { describe, expect, it } from "vitest";

import { maxPool } from "../lib/waveform";

describe("maxPool", () => {
  it("max-pools down to fewer bars, keeping loud transients", () => {
    const out = maxPool(new Float32Array([0.1, 0.5, 0.2, 0.8]), 2);
    expect(out[0]).toBeCloseTo(0.5, 5);
    expect(out[1]).toBeCloseTo(0.8, 5);
  });

  it("handles target larger than source (bars repeat source values)", () => {
    const out = maxPool(new Float32Array([0.4, 0.9]), 4);
    expect(out.length).toBe(4);
    expect(out[0]).toBeCloseTo(0.4, 5);
    expect(out[1]).toBeCloseTo(0.4, 5);
    expect(out[2]).toBeCloseTo(0.9, 5);
    expect(out[3]).toBeCloseTo(0.9, 5);
  });

  it("returns empty for empty source", () => {
    expect(maxPool(new Float32Array(0), 4).length).toBe(4);
  });

  it("returns empty for non-positive target", () => {
    expect(maxPool(new Float32Array([0.5]), 0).length).toBe(0);
  });
});
