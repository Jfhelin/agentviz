import { describe, expect, it } from "vitest";
import {
  formatCacheUsageSummary,
  computeCacheHitRate,
  computeEffectiveInputTokens,
  summarizeTokenUsage,
} from "../lib/cacheMetrics";

describe("cacheMetrics", function () {
  it("returns undefined when all token buckets are zero", function () {
    expect(computeEffectiveInputTokens(0, 0)).toBe(0);
    expect(computeCacheHitRate(0, 0, 0)).toBeUndefined();
  });

  it("clamps negative cache write tokens out of the cache hit rate formula", function () {
    expect(computeEffectiveInputTokens(100, 20)).toBe(80);
    expect(computeCacheHitRate(100, -50, 20)).toBeCloseTo(0.2, 6);
  });

  it("treats cache writes as a separate non-fresh input bucket", function () {
    expect(computeEffectiveInputTokens(2100, 600, 300)).toBe(1200);
    expect(computeCacheHitRate(2100, 300, 600)).toBeCloseTo(600 / (1200 + 300 + 600), 6);
  });

  it("summarizes token usage with a shared aggregate helper", function () {
    expect(summarizeTokenUsage([
      { inputTokens: 600, outputTokens: 100, cacheRead: 300, cacheWrite: 0 },
      null,
      { inputTokens: 500, outputTokens: 50, cacheRead: 200, cacheWrite: 100 },
    ])).toEqual({
      inputTokens: 1100,
      outputTokens: 150,
      cacheRead: 500,
      cacheWrite: 100,
      cacheHitRate: 500 / ((1100 - 500 - 100) + 100 + 500),
    });
  });

  it("formats cache summaries without a zero cache write segment", function () {
    var usage = { inputTokens: 1000, outputTokens: 150, cacheRead: 800, cacheWrite: 0 };
    expect(formatCacheUsageSummary(usage, { variant: "compact" })).toBe("800 cache read / 80.0% hit");
    expect(formatCacheUsageSummary(usage, { variant: "verbose" })).toBe("800 cache read / cache hit rate 80.0%");
  });

  it("handles large token counts with the shared cache hit rate formula", function () {
    expect(computeEffectiveInputTokens(9000000, 4000000)).toBe(5000000);
    expect(computeCacheHitRate(9000000, 1000000, 4000000)).toBeCloseTo(4000000 / (4000000 + 1000000 + 4000000), 6);
  });
});
