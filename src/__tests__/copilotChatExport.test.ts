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
