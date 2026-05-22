import { describe, it, expect } from "vitest";
import { compareRunsCost } from "../lib/compareCost";
import { formatComparisonAsMarkdown } from "../lib/exportComparison";

function mkRun(opts: { extraPromptCount?: number; toolCalls?: Array<{ name: string }>; model?: string } = {}): any {
  const model = opts.model || "claude-sonnet-4.5";
  const events: any[] = [
    {
      name: "panel/editAgent", model, cost: 0.01, output: 10,
      cached: 0, fresh: 1000, cacheWrite: 0, promptTokens: 1000,
      components: { system: 500, tool_defs: 400, current: 100 },
      responsePreview: "ok response", currentText: "do the thing",
      systemPreview: "You are a helpful assistant.",
      systemChars: "You are a helpful assistant.".length,
      systemHash: "abc12345",
      category: "primary", kind: "llm",
    },
    ...(opts.toolCalls || []).map((t) => ({
      name: t.name, model: "", cost: 0, output: 0, cached: 0, fresh: 0, cacheWrite: 0,
      promptTokens: 0, rawArgs: "{}", argsSummary: t.name, kind: "tool",
    })),
  ];
  const prompts: any[] = [{
    index: 0, cost: 0.01, output: 10, cached: 0, fresh: 1000, cacheWrite: 0,
    promptTokens: 1000, llmCount: 1, label: "do the thing", events,
  }];
  for (let i = 0; i < (opts.extraPromptCount || 0); i++) {
    prompts.push({
      index: i + 1, cost: 0.005, output: 5, cached: 500, fresh: 100, cacheWrite: 0,
      promptTokens: 600, llmCount: 1, label: "follow up " + (i + 1),
      events: [{
        name: "panel/editAgent", model, cost: 0.005, output: 5,
        cached: 500, fresh: 100, cacheWrite: 0, promptTokens: 600,
        components: { system: 300, history: 200, current: 100 },
        responsePreview: "ok", currentText: "follow up " + (i + 1),
        systemPreview: "You are a helpful assistant.",
        systemChars: 28, systemHash: "abc12345",
        category: "primary", kind: "llm",
      }],
    });
  }
  return { prompts, totals: { promptTokens: 1000, output: 10, cached: 0, fresh: 1000, cacheWrite: 0, cost: 0.01, llmCalls: 1, toolCalls: 0, cacheHitRate: 0 } };
}

describe("formatComparisonAsMarkdown", () => {
  it("produces a markdown blob containing the major sections", () => {
    const cmp = compareRunsCost(mkRun({}), mkRun({ extraPromptCount: 1 }))!;
    const md = formatComparisonAsMarkdown(cmp, { nameA: "run-a", nameB: "run-b" });
    expect(md).toContain("# Cost compare summary: run-a vs run-b");
    expect(md).toContain("## Run drift");
    expect(md).toContain("## Pre- vs post-divergence cost split");
    expect(md).toContain("## Headline cost KPIs");
    expect(md).toContain("## Behavioral KPIs");
    expect(md).toContain("## Per-bucket cost delta");
    expect(md).toContain("## Final responses");
  });

  it("includes the technique label when provided", () => {
    const cmp = compareRunsCost(mkRun({}), mkRun({}))!;
    const md = formatComparisonAsMarkdown(cmp, { nameA: "a", nameB: "b", technique: "#9 Audit MCP servers" });
    expect(md).toContain("**Technique under test:** #9 Audit MCP servers");
  });

  it("omits the prefix tax projection section when delta is zero", () => {
    const cmp = compareRunsCost(mkRun({}), mkRun({}))!;
    const md = formatComparisonAsMarkdown(cmp, { nameA: "a", nameB: "b" });
    expect(md).not.toContain("Prefix tax projected");
  });

  it("includes behavioral KPI rows for tool calls and output tokens", () => {
    const cmp = compareRunsCost(
      mkRun({ toolCalls: [{ name: "read_file" }, { name: "grep" }] }),
      mkRun({ toolCalls: [{ name: "read_file" }] }),
    )!;
    const md = formatComparisonAsMarkdown(cmp, { nameA: "a", nameB: "b" });
    expect(md).toContain("Tool calls");
    expect(md).toContain("Distinct tools");
    expect(md).toContain("Total output tokens");
  });

  it("trims long final answers to a preview", () => {
    const longAnswer = "x".repeat(500);
    const runWithLong: any = mkRun({});
    runWithLong.prompts[0].events[0].responsePreview = longAnswer;
    const cmp = compareRunsCost(runWithLong, mkRun({}))!;
    const md = formatComparisonAsMarkdown(cmp, { nameA: "a", nameB: "b" });
    // Should be trimmed (200 chars + ellipsis), not the full 500.
    expect(md).toContain("…");
  });
});
