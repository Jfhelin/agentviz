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

import { buildComparisonLlmPrompt } from "../lib/exportComparison";

describe("buildComparisonLlmPrompt", () => {
  it("wraps comparison markdown with analyst instructions and run names", () => {
    const cmp = compareRunsCost(mkRun({}), mkRun({}))!;
    const out = buildComparisonLlmPrompt(cmp, { nameA: "baseline", nameB: "experiment" });
    expect(out).toContain("Cost Compare analysis prompt");
    expect(out).toContain("Runs under comparison");
    expect(out).toContain("What changed");
    expect(out).toContain("Cost outcome");
    expect(out).toContain("Warnings and caveats");
    expect(out).toContain("What to validate next");
    expect(out).toContain("Comparison facts (source of truth)");
    expect(out).toContain("baseline");
    expect(out).toContain("experiment");
  });

  it("includes an explicit technique-under-test block when provided", () => {
    const cmp = compareRunsCost(mkRun({}), mkRun({}))!;
    const out = buildComparisonLlmPrompt(cmp, {
      nameA: "a", nameB: "b",
      techniqueUnderTest: "B disables tool definitions",
    });
    expect(out).toContain("Technique under test (provided)");
    expect(out).toContain("B disables tool definitions");
  });

  it("infers a shared scenario and variant axis from structured file names", () => {
    const cmp = compareRunsCost(mkRun({}), mkRun({}))!;
    const out = buildComparisonLlmPrompt(cmp, {
      nameA: "munich3-baseline",
      nameB: "munich3-no-tool-defs",
    });
    expect(out).toContain("Technique under test (inferred from file names)");
    // Shared scenario surfaced.
    expect(out).toContain("shared scenario: munich3");
    // Variant axis surfaced on both sides.
    expect(out).toContain("A=baseline");
    expect(out).toContain("B=no-tool-defs");
  });

  it("infers a hypothesis from fully different names when no shared scenario exists", () => {
    const cmp = compareRunsCost(mkRun({}), mkRun({}))!;
    const out = buildComparisonLlmPrompt(cmp, {
      nameA: "caveman",
      nameB: "polite",
    });
    expect(out).toContain("Technique under test (inferred from file names)");
    expect(out).toContain("A=caveman vs B=polite");
  });

  it("falls back to a no-signal message when names look like raw timestamps", () => {
    const cmp = compareRunsCost(mkRun({}), mkRun({}))!;
    const out = buildComparisonLlmPrompt(cmp, {
      nameA: "copilot_all_prompts_2026-04-29T14-41-16.json",
      nameB: "copilot_all_prompts_2026-04-30T09-22-04.json",
    });
    expect(out).toContain("Technique under test");
    expect(out).toContain("do not encode an obvious experiment hypothesis");
  });

  it("instructs the analyst to use run labels instead of generic A/B", () => {
    const cmp = compareRunsCost(mkRun({}), mkRun({}))!;
    const out = buildComparisonLlmPrompt(cmp, {
      nameA: "baseline",
      nameB: "experiment",
    });
    expect(out).toContain("instead of generic");
    // Quoted example uses the real names, not "A spent fewer than B".
    expect(out).toContain("baseline spent fewer tokens on tool definitions than experiment");
  });
});
