import { describe, expect, it } from "vitest";
import { estimateCost, estimateMultiModelCost, formatCost, getModelPrice, hasModelPricing } from "../lib/pricing.js";

describe("estimateCost", function () {
  it("returns 0 for null tokenUsage", function () {
    expect(estimateCost(null, "claude-sonnet-4")).toBe(0);
  });

  it("returns 0 for unknown model", function () {
    expect(estimateCost({ inputTokens: 1000 }, "gemini-pro")).toBe(0);
  });

  it("prices cached input at the per-model cache-read ratio", function () {
    var cost = estimateCost({ inputTokens: 1000000, outputTokens: 0, cacheRead: 800000 }, "gpt-4.1");
    // Fresh: 200K * $2/M = $0.40; cached: 800K * $2/M * 25% = $0.40
    expect(cost).toBeCloseTo(0.80, 2);
  });

  it("prices Anthropic cache reads at the 10% default ratio", function () {
    var cost = estimateCost({ inputTokens: 1000000, outputTokens: 0, cacheRead: 800000 }, "claude-sonnet-4");
    // Fresh: 200K * $3/M = $0.60; cached: 800K * $3/M * 10% = $0.24
    expect(cost).toBeCloseTo(0.84, 2);
  });

  it("prices Claude Haiku 4.5 at May 2026 raw rates", function () {
    var cost = estimateCost({ inputTokens: 1000000, outputTokens: 100000 }, "claude-haiku-4.5");
    // 1M * $1.00/M + 100K * $5.00/M = $1.00 + $0.50 = $1.50
    expect(cost).toBeCloseTo(1.50, 2);
  });

  it("prices Claude Sonnet 4 correctly", function () {
    var cost = estimateCost({ inputTokens: 1000000, outputTokens: 100000 }, "claude-sonnet-4");
    // 1M * $3.00/M + 100K * $15.00/M = $3.00 + $1.50 = $4.50
    expect(cost).toBeCloseTo(4.50, 2);
  });

  it("prices Claude Opus 4.7 at May 2026 raw rates (cheaper than older Opus 4.x)", function () {
    var cost = estimateCost({ inputTokens: 1000000, outputTokens: 100000 }, "claude-opus-4.7");
    // 1M * $5.00/M + 100K * $25.00/M = $5.00 + $2.50 = $7.50
    expect(cost).toBeCloseTo(7.50, 2);
  });

  it("keeps Claude Opus 4.6 on the older Opus 4 pricing", function () {
    var cost = estimateCost({ inputTokens: 1000000, outputTokens: 100000 }, "Claude Opus 4.6");
    // 1M * $15.00/M + 100K * $75.00/M = $15.00 + $7.50 = $22.50
    expect(cost).toBeCloseTo(22.50, 2);
  });

  it("prices GPT 5.x Copilot aliases", function () {
    var cost = estimateCost({ inputTokens: 1000000, outputTokens: 100000 }, "gpt-5.4");
    // 1M * $1.25/M + 100K * $10.00/M = $1.25 + $1.00 = $2.25
    expect(cost).toBeCloseTo(2.25, 2);
  });
});

describe("estimateMultiModelCost", function () {
  it("returns 0 for null input", function () {
    expect(estimateMultiModelCost(null)).toBe(0);
  });

  it("returns 0 for empty map", function () {
    expect(estimateMultiModelCost({})).toBe(0);
  });

  it("prices each model at its own rate", function () {
    var cost = estimateMultiModelCost({
      "claude-haiku-4.5": { inputTokens: 500000, outputTokens: 50000 },
      "claude-sonnet-4":  { inputTokens: 500000, outputTokens: 50000 },
    });
    // Haiku: 500K * $1.00/M + 50K * $5.00/M = $0.50 + $0.25 = $0.75
    // Sonnet: 500K * $3.00/M + 50K * $15.00/M = $1.50 + $0.75 = $2.25
    // Total = $3.00
    expect(cost).toBeCloseTo(3.00, 2);
  });

  it("is more accurate than single-model estimate for mixed sessions", function () {
    var tokens = {
      "claude-haiku-4.5": { inputTokens: 800000, outputTokens: 5000 },
      "claude-opus-4":    { inputTokens: 200000, outputTokens: 5000 },
    };
    var multiModel = estimateMultiModelCost(tokens);
    var singleModel = estimateCost(
      { inputTokens: 1000000, outputTokens: 10000 },
      "claude-haiku-4.5"
    );
    // Multi-model should be higher because opus tokens are priced at $15/M not $1/M
    expect(multiModel).toBeGreaterThan(singleModel);
  });

  it("skips unknown models without erroring", function () {
    var cost = estimateMultiModelCost({
      "claude-sonnet-4": { inputTokens: 1000000, outputTokens: 100000 },
      "gemini-pro":      { inputTokens: 500000, outputTokens: 50000 },
    });
    // Only Sonnet is priced; Gemini contributes 0
    expect(cost).toBeCloseTo(4.50, 2);
  });
});

describe("formatCost", function () {
  it("formats zero", function () {
    expect(formatCost(0)).toBe("$0.00");
  });

  it("formats sub-penny", function () {
    expect(formatCost(0.005)).toBe("<$0.01");
  });

  it("formats sub-dollar with 3 decimals", function () {
    expect(formatCost(0.786)).toBe("$0.786");
  });

  it("formats dollar amounts with 2 decimals", function () {
    expect(formatCost(6.12)).toBe("$6.12");
  });
});

describe("hasModelPricing", function () {
  it("returns true for known Claude models", function () {
    expect(hasModelPricing("claude-sonnet-4-20250514")).toBe(true);
    expect(hasModelPricing("Claude Opus 4.6")).toBe(true);
    expect(hasModelPricing("claude-3-5-haiku-20241022")).toBe(true);
    expect(hasModelPricing("claude-opus-4")).toBe(true);
    expect(hasModelPricing("claude-opus-4.7")).toBe(true);
    expect(hasModelPricing("claude-haiku-4.5")).toBe(true);
  });

  it("returns true for unknown Claude variants (fallback pricing)", function () {
    expect(hasModelPricing("claude-next-gen-99")).toBe(true);
  });

  it("returns true for known OpenAI/Copilot models", function () {
    expect(hasModelPricing("gpt-5.5")).toBe(true);
    expect(hasModelPricing("gpt-5.4")).toBe(true);
    expect(hasModelPricing("gpt-5.3-codex")).toBe(true);
    expect(hasModelPricing("gpt-5-mini")).toBe(true);
    expect(hasModelPricing("gpt-4o")).toBe(true);
    expect(hasModelPricing("gpt-4.1")).toBe(true);
    expect(hasModelPricing("o4-mini")).toBe(true);
  });

  it("returns false for unknown non-Claude models", function () {
    expect(hasModelPricing("gemini-pro")).toBe(false);
  });

  it("returns false for null/undefined", function () {
    expect(hasModelPricing(null)).toBe(false);
    expect(hasModelPricing(undefined)).toBe(false);
  });
});

describe("getModelPrice", function () {
  it("returns the raw price row for a known model", function () {
    var row = getModelPrice("claude-opus-4.7");
    expect(row).not.toBeNull();
    expect(row.input).toBe(5.00);
    expect(row.output).toBe(25.00);
  });

  it("returns the Opus 4.7 row in preference to the generic Opus 4 row", function () {
    var row = getModelPrice("claude-opus-4.7-1m-internal");
    expect(row.input).toBe(5.00);
  });

  it("returns null for unknown non-Claude models", function () {
    expect(getModelPrice("gemini-pro")).toBeNull();
  });

  it("returns the Claude fallback row for unknown Claude variants", function () {
    var row = getModelPrice("claude-next-gen-99");
    expect(row).not.toBeNull();
    expect(row.input).toBe(3.00);
  });

  it("exposes per-model cache ratios on OpenAI rows", function () {
    var row = getModelPrice("gpt-4.1");
    expect(row.cacheReadRatio).toBe(0.25);
    expect(row.cacheWriteRatio).toBe(1.0);
  });

  it("leaves cache ratios undefined on Anthropic rows (defaults apply)", function () {
    var row = getModelPrice("claude-sonnet-4");
    expect(row.cacheReadRatio).toBeUndefined();
    expect(row.cacheWriteRatio).toBeUndefined();
  });
});
