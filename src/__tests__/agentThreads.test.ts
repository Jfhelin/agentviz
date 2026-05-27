import { describe, expect, it } from "vitest";
import { buildAgentThreads } from "../lib/agentThreads";
import type { CostAnalysisPrompt } from "../lib/copilotChatExportParser";

// Compact helper to build a prompt fixture with only the fields the
// agent-threads logic looks at. Cast through unknown to satisfy the
// full interface without exhaustively filling unused fields.
function mkPrompt(p: {
  promptId: string;
  name: string;
  userMessage?: string;
  cost?: number;
  llmCount?: number;
  toolCount?: number;
  promptTokens?: number;
  output?: number;
  events?: Array<{
    kind: "tool" | "llm";
    name?: string;
    subagent?: { argsPrompt?: string; description?: string; promptChars?: number; promptTokensEst?: number };
  }>;
}): CostAnalysisPrompt {
  return {
    index: 0,
    promptId: p.promptId,
    name: p.name,
    label: (p.userMessage || "").slice(0, 200),
    userMessage: p.userMessage || "",
    events: (p.events || []) as CostAnalysisPrompt["events"],
    promptTokens: p.promptTokens ?? 0,
    output: p.output ?? 0,
    cached: 0,
    cacheWrite: 0,
    fresh: 0,
    cost: p.cost ?? 0,
    cacheHitRate: 0,
    llmCount: p.llmCount ?? 0,
    toolCount: p.toolCount ?? 0,
    prompt: {} as CostAnalysisPrompt["prompt"],
  } as CostAnalysisPrompt;
}

describe("buildAgentThreads", () => {
  it("returns an empty result for an empty prompt list", () => {
    const r = buildAgentThreads([]);
    expect(r.threads).toEqual([]);
    expect(r.promptIdToThreadId.size).toBe(0);
  });

  it("emits a 'Main agent' thread even when no subagents are present", () => {
    const r = buildAgentThreads([
      mkPrompt({ promptId: "p1", name: "panel/editAgent", cost: 0.05, llmCount: 3, toolCount: 5 }),
      mkPrompt({ promptId: "p2", name: "panel/editAgent", cost: 0.04, llmCount: 2, toolCount: 4 }),
    ]);
    expect(r.threads).toHaveLength(1);
    expect(r.threads[0]).toMatchObject({
      id: "main",
      slot: "main",
      label: "Main agent",
      colorKey: "main",
      promptIds: ["p1", "p2"],
      totalCost: 0.09,
      llmCount: 5,
      toolCount: 9,
    });
  });

  it("creates one subagent thread per tool/runSubagent prompt with cycled colors", () => {
    const r = buildAgentThreads([
      mkPrompt({ promptId: "sa1", name: "tool/runSubagent", userMessage: "Explore the frontend...", cost: 0.014, llmCount: 6 }),
      mkPrompt({ promptId: "sa2", name: "tool/runSubagent", userMessage: "Look at the backend...", cost: 0.009, llmCount: 6 }),
      mkPrompt({ promptId: "p1", name: "panel/editAgent", userMessage: "Implement cart", cost: 0.07 }),
    ]);
    expect(r.threads).toHaveLength(3);
    expect(r.threads[0].id).toBe("main");
    expect(r.threads[1]).toMatchObject({
      id: "sa1",
      slot: "sub",
      label: "Subagent A",
      letter: "A",
      colorKey: "subA",
      totalCost: 0.014,
      taskSnippet: "Explore the frontend...",
    });
    expect(r.threads[2]).toMatchObject({
      id: "sa2",
      label: "Subagent B",
      letter: "B",
      colorKey: "subB",
    });
  });

  it("cycles the color palette after 4 subagents (subA → subD then wraps to subA)", () => {
    const prompts: CostAnalysisPrompt[] = [];
    for (let i = 0; i < 5; i++) {
      prompts.push(mkPrompt({ promptId: "sa" + i, name: "tool/runSubagent", userMessage: "task " + i }));
    }
    const r = buildAgentThreads(prompts);
    const subs = r.threads.filter((t) => t.slot === "sub");
    expect(subs.map((t) => t.colorKey)).toEqual(["subA", "subB", "subC", "subD", "subA"]);
    expect(subs.map((t) => t.letter)).toEqual(["A", "B", "C", "D", "E"]);
  });

  it("links a subagent to its parent via runSubagent.subagent.argsPrompt", () => {
    const taskA = "Explore the frontend of this React app";
    const taskB = "Look at the backend";
    const r = buildAgentThreads([
      mkPrompt({
        promptId: "parent",
        name: "panel/editAgent",
        userMessage: "Implement cart",
        events: [
          { kind: "tool", name: "runSubagent", subagent: { argsPrompt: taskA, description: "frontend" } },
          { kind: "tool", name: "runSubagent", subagent: { argsPrompt: taskB, description: "backend" } },
        ],
      }),
      mkPrompt({ promptId: "saA", name: "tool/runSubagent", userMessage: taskA }),
      mkPrompt({ promptId: "saB", name: "tool/runSubagent", userMessage: taskB }),
    ]);
    const a = r.threads.find((t) => t.id === "saA");
    const b = r.threads.find((t) => t.id === "saB");
    expect(a?.parentPromptId).toBe("parent");
    expect(b?.parentPromptId).toBe("parent");
  });

  it("leaves parentPromptId null when no matching args.prompt is found", () => {
    const r = buildAgentThreads([
      mkPrompt({ promptId: "p1", name: "panel/editAgent", userMessage: "do thing" }),
      mkPrompt({ promptId: "orphan", name: "tool/runSubagent", userMessage: "orphaned subagent" }),
    ]);
    const orphan = r.threads.find((t) => t.id === "orphan");
    expect(orphan?.parentPromptId).toBeNull();
  });

  it("sums real per-prompt cost and call counts on every thread", () => {
    const r = buildAgentThreads([
      mkPrompt({ promptId: "sa1", name: "tool/runSubagent", userMessage: "t1", cost: 0.014, llmCount: 6, toolCount: 21, promptTokens: 170906, output: 3660 }),
      mkPrompt({ promptId: "p1", name: "panel/editAgent", cost: 0.022, llmCount: 3, toolCount: 5, promptTokens: 75000, output: 1200 }),
      mkPrompt({ promptId: "p2", name: "panel/editAgent", cost: 0.018, llmCount: 4, toolCount: 6, promptTokens: 60000, output: 900 }),
    ]);
    const main = r.threads.find((t) => t.id === "main")!;
    expect(main.totalCost).toBeCloseTo(0.04, 5);
    expect(main.llmCount).toBe(7);
    expect(main.toolCount).toBe(11);
    expect(main.inputTokens).toBe(135000);
    expect(main.outputTokens).toBe(2100);
    const sa = r.threads.find((t) => t.id === "sa1")!;
    expect(sa.totalCost).toBeCloseTo(0.014, 5);
    expect(sa.inputTokens).toBe(170906);
    expect(sa.outputTokens).toBe(3660);
  });

  it("truncates long subagent task snippets to ~80 chars + ellipsis", () => {
    const long = "Look at the frontend source at /Users/jfhelin/some/very/long/path/to/the/component/and/then/some/more and tell me ALL files in src/components/ and src/context/ with a brief description of each";
    const r = buildAgentThreads([
      mkPrompt({ promptId: "sa", name: "tool/runSubagent", userMessage: long }),
    ]);
    const sa = r.threads.find((t) => t.id === "sa")!;
    expect(sa.taskSnippet.length).toBeLessThanOrEqual(81);
    expect(sa.taskSnippet.endsWith("…")).toBe(true);
  });

  it("uses the first non-empty line for the snippet when the prompt has blank lines first", () => {
    const r = buildAgentThreads([
      mkPrompt({ promptId: "sa", name: "tool/runSubagent", userMessage: "\n\n  \nActual task here\nMore detail" }),
    ]);
    expect(r.threads.find((t) => t.id === "sa")!.taskSnippet).toBe("Actual task here");
  });

  it("builds an O(1) promptId → threadId index covering every input prompt", () => {
    const r = buildAgentThreads([
      mkPrompt({ promptId: "p1", name: "panel/editAgent" }),
      mkPrompt({ promptId: "sa1", name: "tool/runSubagent", userMessage: "x" }),
      mkPrompt({ promptId: "p2", name: "panel/editAgent" }),
    ]);
    expect(r.promptIdToThreadId.get("p1")).toBe("main");
    expect(r.promptIdToThreadId.get("p2")).toBe("main");
    expect(r.promptIdToThreadId.get("sa1")).toBe("sa1");
    expect(r.promptIdToThreadId.size).toBe(3);
  });
});
