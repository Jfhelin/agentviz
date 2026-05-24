import { describe, it, expect } from "vitest";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { parseSession, detectFormat } from "../lib/parseSession";

// Minimal in-tree fixture (committed). Always available.
const minimalPath = resolve(
  __dirname,
  "fixtures/copilot-chat-export-minimal.json",
);

// Optional larger real-world fixture (gitignored, local only). Tests that
// reference this skip when missing.
const realFixturePath = resolve(
  __dirname,
  "../../test/fixtures/copilot-chat-export/sample.json",
);

describe("copilot chat export parser (minimal fixture)", () => {
  const text = readFileSync(minimalPath, "utf8");

  it("detects the export format", () => {
    expect(detectFormat(text)).toBe("copilot-chat-export");
  });

  it("parses prompts, calls, and cost analysis", () => {
    const parsed = parseSession(text);
    expect(parsed).not.toBeNull();
    const ca = (parsed as any).metadata.costAnalysis;
    expect(ca).toBeDefined();
    expect(ca.prompts.length).toBe(2);
    expect(ca.totals.llmCalls).toBe(2);
  });

  it("flags a tool-defs change as an unexpected cache miss", () => {
    const parsed = parseSession(text);
    const ca = (parsed as any).metadata.costAnalysis;
    // Second call has the same model and a non-trivial prior cache, but
    // tool_search's cache_control marker was dropped — should flag a miss.
    const p2 = ca.prompts[1];
    const llm2 = p2.events.find((e: any) => e.kind === "llm");
    expect(llm2.unexpectedMiss).toBe(true);
    expect(llm2.cacheMissDiag).toBeTruthy();
    expect(llm2.cacheMissDiag.toolDefsChanged).toBeGreaterThanOrEqual(1);
  });
});

describe("copilot chat export parser (real-world fixture)", () => {
  if (!existsSync(realFixturePath)) {
    it.skip("real-world fixture not present (gitignored)", () => {});
    return;
  }

  const text = readFileSync(realFixturePath, "utf8");

  it("detects the export format", () => {
    expect(detectFormat(text)).toBe("copilot-chat-export");
  });

  it("flags model switches and unexpected cache misses", () => {
    const parsed = parseSession(text);
    const ca = (parsed as any).metadata.costAnalysis;
    const anyModelSwitch = ca.prompts.some(
      (p: any) => p.prompt.modelSwitchedIn,
    );
    const anyMiss = ca.prompts.some(
      (p: any) => p.prompt.unexpectedMissCount > 0,
    );
    expect(anyModelSwitch).toBe(true);
    expect(anyMiss).toBe(true);
  });

  it("writes a parsed summary for inspection", () => {
    const parsed = parseSession(text);
    const ca = (parsed as any).metadata.costAnalysis;
    const out = {
      totals: ca.totals,
      prompts: ca.prompts.map((p: any) => ({
        index: p.index,
        label: (p.label || "").slice(0, 80),
        promptTokens: p.promptTokens,
        cost: +p.cost.toFixed(4),
        contextInitial: p.prompt.contextInitial,
        contextFinal: p.prompt.contextFinal,
        cacheRecommit: p.prompt.cacheRecommit,
        unexpectedMissCount: p.prompt.unexpectedMissCount,
        modelSwitchedIn: p.prompt.modelSwitchedIn,
        llmCalls: p.events
          .filter((e: any) => e.kind === "llm")
          .map((e: any) => ({
            model: e.model,
            pt: e.promptTokens,
            cached: e.cached,
            cw: e.cacheWrite,
            newTotal: e.newTotal,
            delta: e.deltaVsPrev,
            miss: e.unexpectedMiss,
            diag: e.cacheMissDiag
              ? {
                  changed: e.cacheMissDiag.toolDefsChanged,
                  sample: e.cacheMissDiag.changedSample,
                }
              : null,
          })),
      })),
    };
    const dest =
      "/Users/jfhelin/.copilot/workspaces/e1763fd6-eca9-4dfc-8579-0618e1239142/artifacts/parsed-summary.json";
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, JSON.stringify(out, null, 2));
    expect(existsSync(dest)).toBe(true);
  });
});

describe("overhead call categorization", () => {
  function buildExport(): string {
    const baseUsage = {
      prompt_tokens: 100,
      completion_tokens: 5,
      cache_creation_input_tokens: 0,
      prompt_tokens_details: { cached_tokens: 0 },
    };
    return JSON.stringify({
      exportedAt: "2026-04-29T14:41:16Z",
      totalPrompts: 1,
      totalLogEntries: 3,
      prompts: [
        {
          prompt: "Hello",
          promptId: "prompt-0",
          logCount: 3,
          logs: [
            {
              id: "req-main",
              kind: "request",
              name: "panel/editAgent",
              metadata: { model: "claude-sonnet-4.6", duration: 1000, usage: baseUsage, tools: [] },
              requestMessages: { messages: [{ role: 1, content: "Hello" }] },
              response: { type: "success", message: ["Hi there"] },
            },
            {
              id: "req-title",
              kind: "request",
              name: "title",
              metadata: { model: "gpt-4o-mini", duration: 200, usage: baseUsage, tools: [] },
              requestMessages: { messages: [{ role: 1, content: "Hello" }] },
              response: { type: "success", message: ["General greeting"] },
            },
            {
              id: "req-cat",
              kind: "request",
              name: "promptCategorization",
              metadata: { model: "gpt-4o-mini", duration: 150, usage: baseUsage, tools: [] },
              requestMessages: { messages: [{ role: 1, content: "Hello" }] },
              response: { type: "success", message: [""] },
            },
          ],
        },
      ],
    });
  }

  it("tags title and promptCategorization as overhead, panel/editAgent as primary", () => {
    const parsed = parseSession(buildExport());
    expect(parsed).not.toBeNull();
    const events = (parsed as any).metadata.costAnalysis.prompts[0].events;
    const llm = events.filter((e: any) => e.kind === "llm");
    expect(llm).toHaveLength(3);
    expect(llm[0].name).toBe("panel/editAgent");
    expect(llm[0].category).toBe("primary");
    expect(llm[1].name).toBe("title");
    expect(llm[1].category).toBe("overhead");
    expect(llm[2].name).toBe("promptCategorization");
    expect(llm[2].category).toBe("overhead");
  });

  it("captures a response preview from the standard message[] shape", () => {
    const parsed = parseSession(buildExport());
    const events = (parsed as any).metadata.costAnalysis.prompts[0].events;
    const llm = events.filter((e: any) => e.kind === "llm");
    expect(llm[0].responsePreview).toBe("Hi there");
    expect(llm[1].responsePreview).toBe("General greeting");
    // empty-message responses produce a JSON fallback rather than empty string,
    // so the inspector still has something to render.
    expect(llm[2].responsePreview.length).toBeGreaterThan(0);
  });

  it("counts all overhead calls in totals (filtering is purely a UI concern)", () => {
    const parsed = parseSession(buildExport());
    const totals = (parsed as any).metadata.costAnalysis.totals;
    expect(totals.llmCalls).toBe(3);
  });
});
