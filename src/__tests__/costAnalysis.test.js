import { describe, expect, it } from "vitest";
import { buildCostAnalysis, formatTokens } from "../lib/costAnalysis.js";

function event(index, usage, model, contextTotal, tools) {
  return {
    t: index,
    agent: "assistant",
    track: "output",
    text: "Call " + (index + 1),
    duration: 1,
    intensity: 0.5,
    isError: false,
    model: model || "gpt-4.1",
    tokenUsage: usage,
    raw: {
      costPrompt: {
        toolNames: tools || ["read_file"],
        contextBreakdown: {
          system: 100,
          tools: 200,
          history: Math.max(contextTotal - 350, 0),
          toolResults: 25,
          user: 25,
          total: contextTotal,
        },
      },
    },
  };
}

describe("buildCostAnalysis", function () {
  it("builds cumulative costs and token totals", function () {
    var analysis = buildCostAnalysis([
      event(0, { inputTokens: 1000, outputTokens: 100, cacheRead: 200, cacheWrite: 50 }, "gpt-4.1", 1000),
      event(1, { inputTokens: 1500, outputTokens: 120, cacheRead: 600, cacheWrite: 0 }, "gpt-4.1", 1300),
    ], { primaryModel: "gpt-4.1" });

    expect(analysis.hasCostData).toBe(true);
    expect(analysis.calls).toHaveLength(2);
    expect(analysis.totals.inputTokens).toBe(2500);
    expect(analysis.totals.cacheRead).toBe(800);
    expect(analysis.totals.freshInputTokens).toBe(1700);
    expect(analysis.calls[1].cumulativeCost).toBeGreaterThan(analysis.calls[0].cost);
    expect(analysis.totals.peakContext).toBe(1300);
  });

  it("flags same-model cache misses with tool diffs", function () {
    var analysis = buildCostAnalysis([
      event(0, { inputTokens: 4000, outputTokens: 100, cacheRead: 3000, cacheWrite: 0 }, "gpt-4.1", 4000, ["read_file"]),
      event(1, { inputTokens: 9000, outputTokens: 120, cacheRead: 200, cacheWrite: 0 }, "gpt-4.1", 9000, ["read_file", "grep"]),
    ], {});

    expect(analysis.cacheMisses).toHaveLength(1);
    expect(analysis.cacheMisses[0].callIndex).toBe(1);
    expect(analysis.cacheMisses[0].toolDiff.added).toEqual(["grep"]);
  });

  it("ignores events without token usage", function () {
    var analysis = buildCostAnalysis([{ text: "no usage" }], {});
    expect(analysis.hasCostData).toBe(false);
    expect(analysis.calls).toHaveLength(0);
  });
});

describe("formatTokens", function () {
  it("formats compact token counts", function () {
    expect(formatTokens(412000)).toBe("412k");
    expect(formatTokens(1250)).toBe("1.3k");
    expect(formatTokens(12)).toBe("12");
  });
});
