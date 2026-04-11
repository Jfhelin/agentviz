import { describe, expect, it } from "vitest";
import {
  computeCacheHitRate,
  computeCacheHitRateDenomTokens,
  computeEffectiveInputTokens,
} from "../lib/cacheMetrics";

describe("cacheMetrics", function () {
  it("returns undefined when all token buckets are zero", function () {
    expect(computeEffectiveInputTokens(0, 0)).toBe(0);
    expect(computeCacheHitRateDenomTokens(0, 0, 0)).toBe(0);
    expect(computeCacheHitRate(0, 0, 0)).toBeUndefined();
  });

  it("clamps negative cache write tokens out of the denominator", function () {
    expect(computeEffectiveInputTokens(100, 20)).toBe(80);
    expect(computeCacheHitRateDenomTokens(100, -50, 20)).toBe(100);
    expect(computeCacheHitRate(100, -50, 20)).toBeCloseTo(0.2, 6);
  });

  it("handles large token counts with the shared cache hit rate formula", function () {
    expect(computeEffectiveInputTokens(9000000, 4000000)).toBe(5000000);
    expect(computeCacheHitRateDenomTokens(9000000, 1000000, 4000000)).toBe(10000000);
    expect(computeCacheHitRate(9000000, 1000000, 4000000)).toBeCloseTo(0.4, 6);
  });
});
