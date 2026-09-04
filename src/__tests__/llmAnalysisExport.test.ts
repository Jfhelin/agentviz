import { describe, expect, it } from "vitest";
import {
  buildSessionAnalysisFacts,
  formatSessionForLlmAnalysis,
} from "../lib/llmAnalysisExport";

const attribution = {
  visible: 6,
  reasoning: 2,
  toolArguments: 1,
  unattributed: 1,
  reasoningSource: "reported",
};

const analysis: any = {
  totals: {
    promptTokens: 100,
    output: 10,
    cached: 40,
    cacheWrite: 0,
    fresh: 60,
    cost: 0.01,
    llmCalls: 1,
    toolCalls: 0,
    cacheHitRate: 0.4,
    outputAttribution: attribution,
    primaryLlmCalls: 1,
    overheadLlmCalls: 0,
    unexpectedMissCount: 0,
    unexpectedMissCost: 0,
  },
  threads: [{
    id: "main",
    label: "Main",
    kind: "main",
    measuredLlmCalls: 1,
    measuredToolCalls: 0,
    measuredCost: 0.01,
    measuredPromptTokens: 100,
    measuredOutputTokens: 10,
  }],
  prompts: [{
    index: 0,
    promptId: "p1",
    name: "panel/editAgent",
    label: "hello",
    userMessage: "hello",
    llmCount: 1,
    toolCount: 0,
    promptTokens: 100,
    output: 10,
    cost: 0.01,
    events: [{
      kind: "llm",
      id: "c1",
      name: "panel/editAgent",
      category: "primary",
      model: "claude-sonnet-4.5",
      duration: 10,
      promptTokens: 100,
      cached: 40,
      cacheWrite: 0,
      fresh: 60,
      output: 10,
      outputAttribution: attribution,
      cost: 0.01,
      components: { system: 60, tool_defs: 20, history: 0, tool_results: 0, current: 20 },
      deltaVsPrev: 100,
      unexpectedMiss: false,
      cacheMissDiag: null,
      responseText: "Done",
      reasoningBlocks: [{ tool: "read", text: "Inspect first" }],
      producedToolCalls: [{ name: "read", argsSummary: "a.ts", rawArgs: "{\"path\":\"a.ts\"}" }],
      systemChars: 60,
      systemHash: "abc",
      systemBlocks: [],
    }],
  }],
};

describe("formatSessionForLlmAnalysis", () => {
  it("emits measured totals, attribution, threads, and methodology", () => {
    const markdown = formatSessionForLlmAnalysis(analysis, { sessionName: "test-run" });
    expect(markdown).toContain("# AGENTVIZ session analysis package");
    expect(markdown).toContain('"sessionName": "test-run"');
    expect(markdown).toContain('"unattributed": 1');
    expect(markdown).toContain("Measured request usage only");
    expect(markdown).toContain("subagent estimates");
  });

  it("preserves the exact measured output total", () => {
    const facts = buildSessionAnalysisFacts(analysis);
    const parts = facts.totals.outputAttribution;
    expect(parts.visible + parts.reasoning + parts.toolArguments + parts.unattributed)
      .toBe(facts.totals.output);
  });
});
