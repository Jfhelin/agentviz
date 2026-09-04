import { describe, expect, it } from "vitest";
import { buildAgentThreads } from "../lib/agentThreads";
import type { CostAnalysisPrompt } from "../lib/copilotChatExportParser";

function prompt(overrides: Partial<CostAnalysisPrompt>): CostAnalysisPrompt {
  return {
    index: 0,
    promptId: "p",
    name: "panel/editAgent",
    label: "",
    userMessage: "",
    events: [],
    promptTokens: 0,
    output: 0,
    cached: 0,
    cacheWrite: 0,
    fresh: 0,
    cost: 0,
    cacheHitRate: 0,
    llmCount: 0,
    toolCount: 0,
    prompt: {} as CostAnalysisPrompt["prompt"],
    ...overrides,
  };
}

describe("buildAgentThreads", () => {
  it("groups measured main-agent usage", () => {
    const result = buildAgentThreads([
      prompt({ promptId: "p1", cost: 0.1, llmCount: 2, toolCount: 3, promptTokens: 100, output: 10 }),
      prompt({ promptId: "p2", cost: 0.2, llmCount: 1, toolCount: 4, promptTokens: 200, output: 20 }),
    ]);
    expect(result.threads).toHaveLength(1);
    expect(result.threads[0]).toMatchObject({
      measuredLlmCalls: 3,
      measuredToolCalls: 7,
      measuredInputTokens: 300,
      measuredOutputTokens: 30,
    });
    expect(result.threads[0].measuredCost).toBeCloseTo(0.3);
  });

  it("links measured subagent threads to their spawning tool call", () => {
    const task = "Inspect the parser and report risks";
    const result = buildAgentThreads([
      prompt({
        promptId: "parent",
        events: [{
          kind: "tool",
          id: "spawn",
          name: "runSubagent",
          argsSummary: "",
          rawArgs: "",
          thinking: "",
          resultChars: 0,
          resultTokens: 0,
          resultPreview: "",
          cumCostAfter: 0,
          subagent: {
            description: "parser",
            argsPrompt: task,
            promptChars: task.length,
            promptTokensEst: 9,
          },
        }],
      }),
      prompt({
        promptId: "child",
        name: "tool/runSubagent",
        userMessage: task,
        cost: 0.04,
        llmCount: 2,
        promptTokens: 500,
        output: 50,
      }),
    ]);
    expect(result.threads[1]).toMatchObject({
      id: "child",
      kind: "subagent",
      label: "Subagent A",
      parentPromptId: "parent",
      measuredCost: 0.04,
      measuredLlmCalls: 2,
      measuredInputTokens: 500,
      measuredOutputTokens: 50,
    });
  });

  it("does not turn unmeasured parent estimates into a measured thread", () => {
    const result = buildAgentThreads([
      prompt({
        promptId: "parent",
        events: [{
          kind: "tool",
          id: "spawn",
          name: "runSubagent",
          argsSummary: "",
          rawArgs: "",
          thinking: "",
          resultChars: 400,
          resultTokens: 100,
          resultPreview: "",
          cumCostAfter: 0,
          subagent: {
            description: "worker",
            argsPrompt: "unexported child",
            promptChars: 1000,
            promptTokensEst: 250,
          },
        }],
      }),
    ]);
    expect(result.threads).toHaveLength(1);
    expect(result.threads[0].measuredLlmCalls).toBe(0);
  });
});
