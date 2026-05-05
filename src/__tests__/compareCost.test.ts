import { describe, it, expect } from "vitest";
import * as fs from "fs";
import { compareRunsCost } from "../lib/compareCost";
import { parseCopilotChatExport } from "../lib/copilotChatExportParser";

// These fixtures live outside the repo (user attachments). The test is
// SKIPPED when they aren't available, so CI on a fresh checkout still passes.
const FIXTURES = {
  caveman: "/Users/jfhelin/.copilot/workspaces/e41f93cd-465a-4313-8701-888682ca72ec/attachments/9be5e028-3b03-41ae-915f-41b83e05bf53-copilot_all_prompts_caveman.json",
  polite:  "/Users/jfhelin/.copilot/workspaces/e41f93cd-465a-4313-8701-888682ca72ec/attachments/729bad37-c16c-4dc1-8231-f47f96d310af-copilot_all_prompts_polite.json",
};

const haveFixtures = Object.values(FIXTURES).every(p => {
  try { fs.accessSync(p); return true; } catch { return false; }
});

describe("compareRunsCost (synthetic minimal)", () => {
  it("returns null when either side is missing", () => {
    expect(compareRunsCost(null as any, null as any)).toBe(null);
    expect(compareRunsCost({ prompts: [], totals: {} as any }, null as any)).toBe(null);
  });

  it("handles empty cost analyses", () => {
    const empty = { prompts: [], totals: {} as any };
    const r = compareRunsCost(empty, empty);
    expect(r).not.toBeNull();
    expect(r!.a.totalCost).toBe(0);
    expect(r!.b.totalCost).toBe(0);
    expect(r!.kpis.length).toBeGreaterThan(0);
  });

  it("declares answer equivalence on byte-equal final responses", () => {
    const mk = (resp: string) => ({
      prompts: [{
        index: 0, cost: 0.01, output: 5, cached: 0, fresh: 100, cacheWrite: 0,
        promptTokens: 100, llmCount: 1,
        events: [{
          name: "x", model: "m", cost: 0.01, output: 5, cached: 0, fresh: 100, cacheWrite: 0,
          promptTokens: 100, components: { system: 100 }, responsePreview: resp,
        }],
      }],
      totals: { promptTokens: 100, output: 5, cached: 0, fresh: 100, cacheWrite: 0, cost: 0.01, llmCalls: 1, toolCalls: 0, cacheHitRate: 0 },
    });
    const r1 = compareRunsCost(mk("Paris."), mk("Paris."));
    expect(r1!.answersEquivalent).toBe(true);
    const r2 = compareRunsCost(mk("Paris."), mk("Lyon."));
    expect(r2!.answersEquivalent).toBe(false);
    const r3 = compareRunsCost(mk("  paris.  "), mk("Paris."));
    expect(r3!.answersEquivalent).toBe(true); // normalized
  });

  it("classifies near-identical totals as 'noise' verdict", () => {
    const mk = (cost: number) => ({
      prompts: [{
        index: 0, cost, output: 5, cached: 0, fresh: 100, cacheWrite: 0,
        promptTokens: 100, llmCount: 1,
        events: [{
          name: "x", model: "m", cost, output: 5, cached: 0, fresh: 100, cacheWrite: 0,
          promptTokens: 100, components: { system: 100 }, responsePreview: "Paris.",
        }],
      }],
      totals: { promptTokens: 100, output: 5, cached: 0, fresh: 100, cacheWrite: 0, cost, llmCalls: 1, toolCalls: 0, cacheHitRate: 0 },
    });
    const r = compareRunsCost(mk(0.0410), mk(0.0411));
    expect(r!.verdict.kind).toBe("noise");
  });

  it("filters overhead prompts and exposes per-turn user prompts", () => {
    // Two prompts: one overhead-only (e.g. 'title' / 'promptCategorization')
    // and one real user-facing turn. compareRunsCost should expose only the
    // real turn in userPrompts, and the convenience userPromptText/finalAnswer
    // should reflect the real turn's last LLM call.
    const mk = (label: string) => ({
      prompts: [
        {
          index: 0, label: "title", cost: 0.001, output: 2, cached: 0, fresh: 50,
          cacheWrite: 0, promptTokens: 50, llmCount: 1,
          events: [{
            kind: "llm", category: "overhead", name: "title", model: "m",
            cost: 0.001, output: 2, cached: 0, fresh: 50, cacheWrite: 0,
            promptTokens: 50, components: { system: 50 },
            responsePreview: "Generated title text",
          }],
        },
        {
          index: 1, label, cost: 0.04, output: 5, cached: 0, fresh: 200,
          cacheWrite: 0, promptTokens: 200, llmCount: 1,
          events: [{
            kind: "llm", category: "primary", name: "panel/editAgent", model: "m",
            cost: 0.04, output: 5, cached: 0, fresh: 200, cacheWrite: 0,
            promptTokens: 200, components: { system: 200 },
            responsePreview: "Paris.",
          }],
        },
      ],
      totals: { promptTokens: 250, output: 7, cached: 0, fresh: 250, cacheWrite: 0, cost: 0.041, llmCalls: 2, toolCalls: 0, cacheHitRate: 0 },
    });
    const r = compareRunsCost(mk("Capitol France?"), mk("Capitol France?"))!;
    // Only the user-facing prompt is exposed; the "title" overhead is filtered.
    expect(r.userPromptsA).toEqual([{ label: "Capitol France?", finalAnswer: "Paris." }]);
    expect(r.userTextA).toBe("Capitol France?");
    expect(r.finalAnswerA).toBe("Paris.");
  });
});

const describeReal = haveFixtures ? describe : describe.skip;
describeReal("compareRunsCost (real fixtures: caveman vs polite)", () => {
  it("produces the expected verdict and headline numbers", () => {
    const a = parseCopilotChatExport(fs.readFileSync(FIXTURES.caveman, "utf8"));
    const b = parseCopilotChatExport(fs.readFileSync(FIXTURES.polite, "utf8"));
    const ca = (a as any).metadata.costAnalysis;
    const cb = (b as any).metadata.costAnalysis;
    const r = compareRunsCost(ca, cb)!;

    expect(r.a.totalCost).toBeCloseTo(0.04095, 4);
    expect(r.b.totalCost).toBeCloseTo(0.04102, 4);
    expect(r.a.llmCallCount).toBe(3);
    expect(r.b.llmCallCount).toBe(3);
    expect(r.sameShape).toBe(true);
    expect(r.answersEquivalent).toBe(true);
    expect(r.finalAnswerA).toBe("Paris.");
    expect(r.finalAnswerB).toBe("Paris.");
    // Bug fix: userPromptText should now be populated from prompt.label
    // (previously it searched for a non-existent "User message:\n" marker
    // and was always empty).
    expect(r.userTextA).toBe("Capitol France?");
    expect(r.userTextB.toLowerCase()).toContain("capit");
    expect(r.userPromptsA.length).toBe(1);
    expect(r.userPromptsB.length).toBe(1);
    expect(r.userPromptsA[0].label).toBe("Capitol France?");
    expect(r.userPromptsA[0].finalAnswer).toBe("Paris.");
    expect(r.verdict.kind).toBe("noise");
    // Fixed share should be very high (>80%) for these tiny questions
    expect(r.a.fixedShare).toBeGreaterThan(0.80);
    expect(r.b.fixedShare).toBeGreaterThan(0.80);
    // We expect at least the noise + tool_defs recommendations to fire
    const recIds = r.recommendations.map(x => x.id);
    expect(recIds).toContain("noise_dominated_by_overhead");
    expect(recIds).toContain("attack_tool_defs");
  });
});
