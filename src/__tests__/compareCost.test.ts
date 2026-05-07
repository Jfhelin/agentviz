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

  it("computes per-bucket cost deltas summing to the total cost swing", () => {
    function mk(systemTok: number, outputTok: number, cost: number) {
      return {
        prompts: [{
          index: 0, cost, output: outputTok, cached: 0, fresh: systemTok, cacheWrite: 0,
          promptTokens: systemTok, llmCount: 1,
          events: [{
            name: "panel", model: "gpt-5", cost, output: outputTok,
            cached: 0, fresh: systemTok, cacheWrite: 0, promptTokens: systemTok,
            components: { system: systemTok }, responsePreview: "x", category: "primary" as const, kind: "llm" as const,
          }],
        }],
        totals: { promptTokens: systemTok, output: outputTok, cached: 0, fresh: systemTok, cacheWrite: 0, cost, llmCalls: 1, toolCalls: 0, cacheHitRate: 0 },
      };
    }
    // A: large system bucket. B: same shape but smaller system bucket (compressed).
    const r = compareRunsCost(mk(1000, 10, 0.0202), mk(500, 10, 0.0102))!;
    const sumDeltas = r.bucketDeltas.reduce((s, d) => s + d.delta, 0);
    expect(sumDeltas).toBeCloseTo(r.b.totalCost - r.a.totalCost, 4);
    // System bucket should be the dominant swing (sorted first).
    expect(r.bucketDeltas[0].bucket).toBe("system");
    expect(r.bucketDeltas[0].delta).toBeLessThan(0); // savings
    // shareOfSwing values sum to <= 1.0001 (floating point slack).
    const totalShare = r.bucketDeltas.reduce((s, d) => s + d.shareOfSwing, 0);
    expect(totalShare).toBeGreaterThan(0.99);
    expect(totalShare).toBeLessThan(1.01);
  });

  it("flags cache pollution when B's first primary call has high cache hit", () => {
    function mk(firstCalled: number, firstFresh: number) {
      return {
        prompts: [{
          index: 0, cost: 0.01, output: 10, cached: firstCalled, fresh: firstFresh, cacheWrite: 0,
          promptTokens: firstCalled + firstFresh, llmCount: 1,
          events: [{
            name: "panel", model: "gpt-5", cost: 0.01, output: 10,
            cached: firstCalled, fresh: firstFresh, cacheWrite: 0,
            promptTokens: firstCalled + firstFresh,
            components: { system: firstCalled + firstFresh },
            responsePreview: "x", category: "primary" as const, kind: "llm" as const,
          }],
        }],
        totals: { promptTokens: firstCalled + firstFresh, output: 10, cached: firstCalled, fresh: firstFresh, cacheWrite: 0, cost: 0.01, llmCalls: 1, toolCalls: 0, cacheHitRate: firstCalled / (firstCalled + firstFresh) },
      };
    }
    // A: cold (0% hit). B: 80% cache hit on first call -> suspect.
    const r = compareRunsCost(mk(0, 2000), mk(1600, 400))!;
    expect(r.cachePollution.suspect).toBe(true);
    expect(r.cachePollution.side).toBe("B");
    expect(r.a.firstPrimaryCallCacheHit).toBe(0);
    expect(r.b.firstPrimaryCallCacheHit).toBeCloseTo(0.8, 2);
    // Pollution recommendation should appear FIRST in the list.
    expect(r.recommendations[0].id).toBe("cache_pollution");
  });

  it("does NOT flag pollution when both first calls are cold", () => {
    function mk() {
      return {
        prompts: [{
          index: 0, cost: 0.01, output: 10, cached: 0, fresh: 2000, cacheWrite: 0,
          promptTokens: 2000, llmCount: 1,
          events: [{
            name: "panel", model: "gpt-5", cost: 0.01, output: 10,
            cached: 0, fresh: 2000, cacheWrite: 0, promptTokens: 2000,
            components: { system: 2000 }, responsePreview: "x", category: "primary" as const, kind: "llm" as const,
          }],
        }],
        totals: { promptTokens: 2000, output: 10, cached: 0, fresh: 2000, cacheWrite: 0, cost: 0.01, llmCalls: 1, toolCalls: 0, cacheHitRate: 0 },
      };
    }
    const r = compareRunsCost(mk(), mk())!;
    expect(r.cachePollution.suspect).toBe(false);
    expect(r.recommendations.find(x => x.id === "cache_pollution")).toBeUndefined();
  });

  it("does NOT flag pollution when first-call input is below the noise floor", () => {
    // 100% cache hit but only 50 tokens — too small to be conclusive.
    function mk(cached: number, fresh: number) {
      return {
        prompts: [{
          index: 0, cost: 0.01, output: 5, cached, fresh, cacheWrite: 0,
          promptTokens: cached + fresh, llmCount: 1,
          events: [{
            name: "panel", model: "gpt-5", cost: 0.01, output: 5,
            cached, fresh, cacheWrite: 0, promptTokens: cached + fresh,
            components: { system: cached + fresh }, responsePreview: "x", category: "primary" as const, kind: "llm" as const,
          }],
        }],
        totals: { promptTokens: cached + fresh, output: 5, cached, fresh, cacheWrite: 0, cost: 0.01, llmCalls: 1, toolCalls: 0, cacheHitRate: cached / (cached + fresh || 1) },
      };
    }
    const r = compareRunsCost(mk(0, 50), mk(48, 2))!;
    expect(r.cachePollution.suspect).toBe(false);
  });

  it("skips overhead calls when computing first-primary-call cache hit", () => {
    // Run B starts with an overhead call (e.g. "title") that has 100% cache.
    // The first PRIMARY call is the second event and should be the one inspected.
    const b = {
      prompts: [{
        index: 0, cost: 0.005, output: 5, cached: 200, fresh: 0, cacheWrite: 0,
        promptTokens: 200, llmCount: 1,
        events: [{
          name: "title", model: "gpt-4o-mini", cost: 0.001, output: 5,
          cached: 200, fresh: 0, cacheWrite: 0, promptTokens: 200,
          components: { system: 200 }, responsePreview: "Title",
          category: "overhead" as const, kind: "llm" as const,
        }],
      }, {
        index: 1, cost: 0.004, output: 10, cached: 0, fresh: 2000, cacheWrite: 0,
        promptTokens: 2000, llmCount: 1,
        events: [{
          name: "panel", model: "gpt-5", cost: 0.004, output: 10,
          cached: 0, fresh: 2000, cacheWrite: 0, promptTokens: 2000,
          components: { system: 2000 }, responsePreview: "Paris.",
          category: "primary" as const, kind: "llm" as const,
        }],
      }],
      totals: { promptTokens: 2200, output: 15, cached: 200, fresh: 2000, cacheWrite: 0, cost: 0.005, llmCalls: 2, toolCalls: 0, cacheHitRate: 200 / 2200 },
    };
    const a = b; // identical
    const r = compareRunsCost(a, b)!;
    // Should reflect the PRIMARY call (cache hit = 0), NOT the overhead title (cache hit = 100%).
    expect(r.b.firstPrimaryCallCacheHit).toBe(0);
    expect(r.b.firstPrimaryCallInputTokens).toBe(2000);
    expect(r.cachePollution.suspect).toBe(false);
  });

  it("includes input/output rate KPIs and computes them from bucket attribution", () => {
    const r = compareRunsCost(
      {
        prompts: [{
          index: 0, cost: 0.020, output: 100, cached: 0, fresh: 1000, cacheWrite: 0,
          promptTokens: 1000, llmCount: 1,
          events: [{
            name: "panel", model: "gpt-5", cost: 0.020, output: 100,
            cached: 0, fresh: 1000, cacheWrite: 0, promptTokens: 1000,
            // 1000 input tokens cost ~$0.010 (50% of cost), 100 output tokens cost ~$0.010 (50%).
            // -> input rate = $10/M, output rate = $100/M
            components: { system: 1000 }, responsePreview: "x", category: "primary" as const, kind: "llm" as const,
          }],
        }],
        totals: { promptTokens: 1000, output: 100, cached: 0, fresh: 1000, cacheWrite: 0, cost: 0.020, llmCalls: 1, toolCalls: 0, cacheHitRate: 0 },
      },
      {
        prompts: [{
          index: 0, cost: 0.020, output: 100, cached: 0, fresh: 1000, cacheWrite: 0,
          promptTokens: 1000, llmCount: 1,
          events: [{
            name: "panel", model: "gpt-5", cost: 0.020, output: 100,
            cached: 0, fresh: 1000, cacheWrite: 0, promptTokens: 1000,
            components: { system: 1000 }, responsePreview: "x", category: "primary" as const, kind: "llm" as const,
          }],
        }],
        totals: { promptTokens: 1000, output: 100, cached: 0, fresh: 1000, cacheWrite: 0, cost: 0.020, llmCalls: 1, toolCalls: 0, cacheHitRate: 0 },
      },
    )!;
    // Cost is split per bucket: system=1000tok, output=100tok -> total bucket sum=1100.
    // System gets 1000/1100 of cost = 0.01818, output gets 100/1100 = 0.001818.
    // input rate ≈ 0.01818 / 1000 * 1e6 ≈ $18.2/M, output rate ≈ 0.001818 / 100 * 1e6 ≈ $18.2/M.
    expect(r.a.avgInputRatePerMTok).toBeGreaterThan(0);
    expect(r.a.avgOutputRatePerMTok).toBeGreaterThan(0);
    const inRateKpi = r.kpis.find(k => k.key === "avg_in_rate");
    const outRateKpi = r.kpis.find(k => k.key === "avg_out_rate");
    expect(inRateKpi).toBeDefined();
    expect(outRateKpi).toBeDefined();
    expect(inRateKpi!.a).toBeCloseTo(r.a.avgInputRatePerMTok, 4);
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

describe("compareRunsCost: drift detection", () => {
  // Helper that lets each test override the few fields drift cares about
  // without re-typing the boilerplate event/prompt tree every time.
  function mkRun(opts: {
    model?: string;
    label?: string;
    systemPreview?: string;
    /** When true, omit systemHash/systemChars to exercise the legacy
     * preview-only hash path (parser didn't supply full-text hash). */
    omitSystemHash?: boolean;
    toolCalls?: Array<{ name: string; rawArgs?: string; argsSummary?: string }>;
    extraPromptCount?: number;
  }): any {
    const model = opts.model || "claude-sonnet-4.5";
    const sysText = opts.systemPreview ?? "You are a helpful coding assistant.";
    function fnv1a(s: string): string {
      let h = 2166136261;
      for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
      return (h >>> 0).toString(16).padStart(8, "0");
    }
    const sysHash = fnv1a(sysText.trim().replace(/\s+/g, " "));
    const events: any[] = [
      {
        name: "panel/editAgent", model, cost: 0.01, output: 10,
        cached: 0, fresh: 1000, cacheWrite: 0, promptTokens: 1000,
        components: { system: 500, tool_defs: 400, current: 100 },
        responsePreview: "ok", currentText: "do the thing",
        systemPreview: sysText,
        ...(opts.omitSystemHash ? {} : { systemChars: sysText.length, systemHash: sysHash }),
        category: "primary", kind: "llm",
      },
      ...(opts.toolCalls || []).map((t) => ({
        name: t.name, model: "", cost: 0, output: 0, cached: 0, fresh: 0, cacheWrite: 0,
        promptTokens: 0,
        rawArgs: t.rawArgs || "{}",
        argsSummary: t.argsSummary || t.name,
        kind: "tool",
      })),
    ];
    const prompts: any[] = [{
      index: 0, cost: 0.01, output: 10, cached: 0, fresh: 1000, cacheWrite: 0,
      promptTokens: 1000, llmCount: 1, label: opts.label ?? "do the thing",
      events,
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
          systemPreview: sysText,
          ...(opts.omitSystemHash ? {} : { systemChars: sysText.length, systemHash: sysHash }),
          category: "primary", kind: "llm",
        }],
      });
    }
    return { prompts, totals: { promptTokens: 1000, output: 10, cached: 0, fresh: 1000, cacheWrite: 0, cost: 0.01, llmCalls: 1, toolCalls: 0, cacheHitRate: 0 } };
  }

  it("flags no drift when both runs are identical", () => {
    const r = compareRunsCost(mkRun({}), mkRun({}))!;
    expect(r.drift.hasAnyDrift).toBe(false);
    expect(r.drift.hasBlockingDrift).toBe(false);
    expect(r.drift.rows.every((row) => row.status === "match")).toBe(true);
    // Fingerprint sanity
    expect(r.fingerprintA.primaryModel).toBe("claude-sonnet-4.5");
    expect(r.fingerprintA.turnCount).toBe(1);
  });

  it("flags model drift as blocking", () => {
    const r = compareRunsCost(mkRun({}), mkRun({ model: "gpt-5" }))!;
    expect(r.drift.hasBlockingDrift).toBe(true);
    const modelRow = r.drift.rows.find((row) => row.key === "models")!;
    expect(modelRow.status).toBe("diff");
    expect(modelRow.blocking).toBe(true);
  });

  it("flags first-prompt drift as blocking", () => {
    const r = compareRunsCost(
      mkRun({ label: "write me a haiku" }),
      mkRun({ label: "write me a sonnet" }),
    )!;
    expect(r.drift.hasBlockingDrift).toBe(true);
    expect(r.drift.rows.find((row) => row.key === "first_prompt")!.status).toBe("diff");
  });

  it("flags system-prompt drift as non-blocking (it's expected for #3 test)", () => {
    const r = compareRunsCost(
      mkRun({ systemPreview: "long verbose prompt with many words" }),
      mkRun({ systemPreview: "short prompt" }),
    )!;
    const sysRow = r.drift.rows.find((row) => row.key === "system_prompt")!;
    expect(sysRow.status).toBe("diff");
    expect(sysRow.blocking).toBe(false);
    // Even though sys-prompt drifted, no blocking row should fire if everything
    // else matches.
    expect(r.drift.hasBlockingDrift).toBe(false);
  });

  it("downgrades a system-prompt 'match' to 'info' when only the preview was hashable", () => {
    // Both runs have identical previews but no full-text hash from the parser.
    // We can't prove identity beyond the preview, so the drift panel should
    // show 'info' (not 'match') and surface a caveat to the user.
    const r = compareRunsCost(
      mkRun({ omitSystemHash: true }),
      mkRun({ omitSystemHash: true }),
    )!;
    const sysRow = r.drift.rows.find((row) => row.key === "system_prompt")!;
    expect(sysRow.status).toBe("info");
    expect(sysRow.blocking).toBe(false);
    expect(sysRow.aText).toContain("~preview");
    expect(sysRow.bText).toContain("~preview");
    expect(sysRow.detail).toMatch(/first 400 characters/);
    // No 'diff' row, so hasAnyDrift remains false.
    expect(r.drift.hasAnyDrift).toBe(false);
    // And the fingerprint flags untrusted explicitly so consumers can decide.
    expect(r.fingerprintA.systemPromptHashTrusted).toBe(false);
    expect(r.fingerprintB.systemPromptHashTrusted).toBe(false);
  });

  it("trusts the full-text system hash when the parser supplies it", () => {
    const r = compareRunsCost(mkRun({}), mkRun({}))!;
    expect(r.fingerprintA.systemPromptHashTrusted).toBe(true);
    expect(r.fingerprintB.systemPromptHashTrusted).toBe(true);
    const sysRow = r.drift.rows.find((row) => row.key === "system_prompt")!;
    expect(sysRow.status).toBe("match");
    expect(sysRow.aText).not.toContain("~preview");
  });

  it("extracts edited file paths from edit_file tool calls", () => {
    const r = compareRunsCost(
      mkRun({ toolCalls: [
        { name: "edit_file", rawArgs: JSON.stringify({ filePath: "src/a.ts" }) },
        { name: "edit_file", rawArgs: JSON.stringify({ filePath: "src/b.ts" }) },
      ]}),
      mkRun({ toolCalls: [
        { name: "edit_file", rawArgs: JSON.stringify({ filePath: "src/a.ts" }) },
      ]}),
    )!;
    expect(r.fingerprintA.filesEdited).toEqual(["src/a.ts", "src/b.ts"]);
    expect(r.fingerprintB.filesEdited).toEqual(["src/a.ts"]);
    const filesRow = r.drift.rows.find((row) => row.key === "files_edited")!;
    expect(filesRow.status).toBe("diff");
    expect(filesRow.blocking).toBe(true);
    expect(filesRow.detail).toContain("A only");
    expect(filesRow.detail).toContain("src/b.ts");
  });

  it("flags MCP tool invocation as blocking drift (the killer case for the MCP test)", () => {
    const r = compareRunsCost(
      mkRun({ toolCalls: [{ name: "edit_file", rawArgs: JSON.stringify({ filePath: "src/a.ts" }) }] }),
      mkRun({ toolCalls: [
        { name: "edit_file", rawArgs: JSON.stringify({ filePath: "src/a.ts" }) },
        { name: "playwright_navigate", rawArgs: JSON.stringify({ url: "https://example.com" }) },
      ]}),
    )!;
    const toolsRow = r.drift.rows.find((row) => row.key === "tools_invoked")!;
    expect(toolsRow.status).toBe("diff");
    expect(toolsRow.blocking).toBe(true);
    expect(toolsRow.detail).toContain("playwright_navigate");
    expect(toolsRow.detail).toContain("B only");
  });

  it("read-only tools (read_file) count as files-touched but not files-edited", () => {
    const r = compareRunsCost(
      mkRun({ toolCalls: [
        { name: "read_file", rawArgs: JSON.stringify({ filePath: "src/x.ts" }) },
        { name: "read_file", rawArgs: JSON.stringify({ filePath: "src/y.ts" }) },
      ]}),
      mkRun({ toolCalls: [
        { name: "read_file", rawArgs: JSON.stringify({ filePath: "src/x.ts" }) },
      ]}),
    )!;
    expect(r.fingerprintA.filesTouched).toEqual(["src/x.ts", "src/y.ts"]);
    expect(r.fingerprintA.filesEdited).toEqual([]);
    expect(r.fingerprintB.filesEdited).toEqual([]);
    // Same tool invoked on both sides — no tools-invoked drift.
    expect(r.drift.rows.find((row) => row.key === "tools_invoked")!.status).toBe("match");
    // Files-edited matches (both empty) — no blocking drift.
    expect(r.drift.rows.find((row) => row.key === "files_edited")!.status).toBe("match");
    // Files-touched diverges, but is informational only.
    const touchedRow = r.drift.rows.find((row) => row.key === "files_touched")!;
    expect(touchedRow.status).toBe("info");
    expect(touchedRow.blocking).toBe(false);
    expect(r.drift.hasBlockingDrift).toBe(false);
  });

  it("turn-count drift flags as blocking", () => {
    const r = compareRunsCost(
      mkRun({}),
      mkRun({ extraPromptCount: 2 }),
    )!;
    expect(r.fingerprintA.turnCount).toBe(1);
    expect(r.fingerprintB.turnCount).toBe(3);
    expect(r.drift.rows.find((row) => row.key === "turns")!.status).toBe("diff");
    expect(r.drift.hasBlockingDrift).toBe(true);
  });

  it("extractFilePath handles fallback args summary when JSON parse fails", () => {
    // raw args is not valid JSON; fall back to summary's path-looking token
    const r = compareRunsCost(
      mkRun({ toolCalls: [
        { name: "edit_file", rawArgs: "not-json", argsSummary: "edit_file: api/services/cart.ts" },
      ]}),
      mkRun({}),
    )!;
    expect(r.fingerprintA.filesTouched).toEqual(["api/services/cart.ts"]);
  });

  it("splits cost into pre- and post-divergence components", () => {
    // mkRun produces a single LLM call with cost=0.01 and promptTokens=1000.
    // With no extra prompts, totalCost === preCost so postCost should be 0.
    const identical = compareRunsCost(mkRun({}), mkRun({}))!;
    expect(identical.divergenceSplit.preCostA).toBeCloseTo(0.01, 5);
    expect(identical.divergenceSplit.preCostB).toBeCloseTo(0.01, 5);
    expect(identical.divergenceSplit.postCostA).toBeCloseTo(0, 5);
    expect(identical.divergenceSplit.postCostB).toBeCloseTo(0, 5);
    expect(identical.divergenceSplit.preInputTokensA).toBe(1000);
    expect(identical.divergenceSplit.preInputDelta).toBe(0);

    // With extra follow-up prompts, postCost grows but preCost stays fixed.
    const longer = compareRunsCost(
      mkRun({}),
      mkRun({ extraPromptCount: 2 }),
    )!;
    expect(longer.divergenceSplit.preCostA).toBeCloseTo(0.01, 5);
    expect(longer.divergenceSplit.preCostB).toBeCloseTo(0.01, 5);
    expect(longer.divergenceSplit.preDelta).toBeCloseTo(0, 5);
    // B has 2 extra prompts at 0.005 each = 0.01 of post-divergence cost.
    expect(longer.divergenceSplit.postCostA).toBeCloseTo(0, 5);
    expect(longer.divergenceSplit.postCostB).toBeCloseTo(0.01, 5);
    expect(longer.divergenceSplit.postDelta).toBeCloseTo(0.01, 5);
  });
});
