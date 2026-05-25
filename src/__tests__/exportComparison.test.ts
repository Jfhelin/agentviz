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
    expect(md).toContain("## Final-response signals");
    expect(md).toContain("## Edit artifacts diff");
    expect(md).toContain("## Final responses");
  });

  it("ships the FULL final response (not a 200-char preview) in the facts block", () => {
    // Build a run whose final response is well over 200 chars
    const longResponse = "Done. ".repeat(80) + "End.";
    expect(longResponse.length).toBeGreaterThan(450);
    const runA = mkRun({});
    runA.prompts[0].events[0].responsePreview = longResponse;
    const runB = mkRun({});
    runB.prompts[0].events[0].responsePreview = longResponse;
    const cmp = compareRunsCost(runA, runB)!;
    const md = formatComparisonAsMarkdown(cmp, { nameA: "a", nameB: "b" });
    expect(md).toContain(longResponse);
  });

  it("extracts deterministic final-response signals (numbers, paths, format counts)", () => {
    const runA = mkRun({});
    runA.prompts[0].events[0].responsePreview =
      "Done. **Processed:** 9 receipts (1 skipped).\nOutput: `/tmp/expense-summary.md`\nValidation: `/tmp/expense-summary.validation.json`";
    const runB = mkRun({});
    runB.prompts[0].events[0].responsePreview =
      "Done. 9 receipts processed (1 skipped — wrong trip).\n| Original | New |\n|---|---|\n| a.jpg | b.jpg |\nOutput: `/tmp/expense-summary.md`";
    const cmp = compareRunsCost(runA, runB)!;
    const md = formatComparisonAsMarkdown(cmp, { nameA: "a", nameB: "b" });
    expect(md).toContain("Numbers mentioned");
    // Both finals mention "9" and "1" so overlap should include both
    expect(md).toMatch(/overlap:.*9.*1|overlap:.*1.*9/);
    expect(md).toContain("File paths mentioned");
    // expense-summary.md is in both
    expect(md).toContain("expense-summary.md");
    // B has a markdown table, A doesn't
    expect(md).toContain("Markdown tables");
    expect(md).toContain("substantive_numbers_agree");
    expect(md).toContain("referenced_paths_agree");
  });

  it("reports identical content hashes for byte-identical edits and 'differ' otherwise", () => {
    const sameContent = "console.log('hello');\nexport const x = 1;\n";
    const otherContent = "console.log('different');\n";
    const runA = mkRun({ toolCalls: [] });
    runA.prompts[0].events.push({
      name: "edit_file", model: "", cost: 0, output: 0, cached: 0, fresh: 0, cacheWrite: 0,
      promptTokens: 0,
      rawArgs: JSON.stringify({ filePath: "/work/a.ts", code: sameContent }),
      argsSummary: "edit_file /work/a.ts", kind: "tool",
    });
    runA.prompts[0].events.push({
      name: "edit_file", model: "", cost: 0, output: 0, cached: 0, fresh: 0, cacheWrite: 0,
      promptTokens: 0,
      rawArgs: JSON.stringify({ filePath: "/work/b.ts", code: sameContent }),
      argsSummary: "edit_file /work/b.ts", kind: "tool",
    });
    const runB = mkRun({ toolCalls: [] });
    runB.prompts[0].events.push({
      name: "edit_file", model: "", cost: 0, output: 0, cached: 0, fresh: 0, cacheWrite: 0,
      promptTokens: 0,
      rawArgs: JSON.stringify({ filePath: "/work/a.ts", code: sameContent }),
      argsSummary: "edit_file /work/a.ts", kind: "tool",
    });
    runB.prompts[0].events.push({
      name: "edit_file", model: "", cost: 0, output: 0, cached: 0, fresh: 0, cacheWrite: 0,
      promptTokens: 0,
      rawArgs: JSON.stringify({ filePath: "/work/b.ts", code: otherContent }),
      argsSummary: "edit_file /work/b.ts", kind: "tool",
    });
    const cmp = compareRunsCost(runA, runB)!;
    const md = formatComparisonAsMarkdown(cmp, { nameA: "a", nameB: "b" });
    expect(md).toContain("/work/a.ts");
    expect(md).toContain("/work/b.ts");
    expect(md).toContain("identical");
    expect(md).toContain("differ");
    expect(md).toContain("artifacts_identical:** false");
    expect(md).toContain("artifacts_with_extractable_content");
    // full-write edits should be labeled as such in the Kind column
    expect(md).toContain("full-write");
  });

  it("captures partial-replace edits as old→new pairs (the common LLM code-edit case)", () => {
    // Same str_replace on both sides: same oldString → same newString → identical hash
    const oldS = "function foo() { return 1; }";
    const newS = "function foo() { return 2; }";
    const runA = mkRun({ toolCalls: [] });
    runA.prompts[0].events.push({
      name: "replace_string_in_file", model: "", cost: 0, output: 0, cached: 0, fresh: 0, cacheWrite: 0,
      promptTokens: 0,
      rawArgs: JSON.stringify({ filePath: "/work/foo.js", oldString: oldS, newString: newS }),
      argsSummary: "replace_string_in_file /work/foo.js", kind: "tool",
    });
    const runB = mkRun({ toolCalls: [] });
    runB.prompts[0].events.push({
      name: "replace_string_in_file", model: "", cost: 0, output: 0, cached: 0, fresh: 0, cacheWrite: 0,
      promptTokens: 0,
      rawArgs: JSON.stringify({ filePath: "/work/foo.js", oldString: oldS, newString: newS }),
      argsSummary: "replace_string_in_file /work/foo.js", kind: "tool",
    });
    const cmp = compareRunsCost(runA, runB)!;
    const md = formatComparisonAsMarkdown(cmp, { nameA: "a", nameB: "b" });
    expect(md).toContain("partial-replace");
    expect(md).toContain("/work/foo.js");
    // identical change request -> identical hash
    expect(md).toContain("artifacts_identical:** true");
    // the caveat warning fires when partial-replace rows exist
    expect(md).toContain("change-request");
  });

  it("surfaces edit-count mismatch as a coverage/thoroughness signal", () => {
    // Simulate the real test case: same file edited 3 times in A vs 2 times in B.
    // (Test scaled down — the principle is identical for 12 vs 8.)
    const oldS1 = "// TODO 1"; const newS1 = "// Done 1";
    const oldS2 = "// TODO 2"; const newS2 = "// Done 2";
    const oldS3 = "// TODO 3"; const newS3 = "// Done 3";
    const runA = mkRun({ toolCalls: [] });
    for (const [o, n] of [[oldS1, newS1], [oldS2, newS2], [oldS3, newS3]] as const) {
      runA.prompts[0].events.push({
        name: "replace_string_in_file", model: "", cost: 0, output: 0, cached: 0, fresh: 0, cacheWrite: 0,
        promptTokens: 0,
        rawArgs: JSON.stringify({ filePath: "/work/doc.md", oldString: o, newString: n }),
        argsSummary: "replace_string_in_file /work/doc.md", kind: "tool",
      });
    }
    const runB = mkRun({ toolCalls: [] });
    for (const [o, n] of [[oldS1, newS1], [oldS2, newS2]] as const) {
      runB.prompts[0].events.push({
        name: "replace_string_in_file", model: "", cost: 0, output: 0, cached: 0, fresh: 0, cacheWrite: 0,
        promptTokens: 0,
        rawArgs: JSON.stringify({ filePath: "/work/doc.md", oldString: o, newString: n }),
        argsSummary: "replace_string_in_file /work/doc.md", kind: "tool",
      });
    }
    const cmp = compareRunsCost(runA, runB)!;
    const md = formatComparisonAsMarkdown(cmp, { nameA: "a", nameB: "b" });
    // Per-row counts visible
    expect(md).toMatch(/\| 3 \| 2 \|/);
    // Top-level totals visible
    expect(md).toContain("total_edit_calls:** A=3, B=2");
    // Mismatch list emitted with the coverage hint
    expect(md).toContain("paths_with_edit_count_mismatch");
    expect(md).toContain("/work/doc.md");
    expect(md).toContain("coverage/thoroughness signal");
  });

  it("instructs the analyst to use depth-of-change for coverage-shaped tasks", () => {
    const cmp = compareRunsCost(mkRun({}), mkRun({}))!;
    const out = buildComparisonLlmPrompt(cmp, { nameA: "a", nameB: "b" });
    expect(out).toContain("Depth-of-change signals");
    expect(out).toContain("paths_with_edit_count_mismatch");
    expect(out).toContain("coverage/thoroughness signal");
    // The "12 vs 8" worked example must appear so the analyst recognizes the shape
    expect(out).toContain("12 vs 8");
    // And the explicit anti-rule for "one function" / "this bug"-shaped tasks
    expect(out).toContain("churn, not coverage");
  });

  it("splits output verbosity into reasoning vs visible tokens", () => {
    // A: 100 output, 60 reasoning, 40 visible
    // B: 100 output, 0 reasoning, 100 visible -> same total, very different attribution
    const runA = mkRun({});
    runA.prompts[0].events[0].output = 100;
    runA.prompts[0].events[0].reasoningTokens = 60;
    runA.prompts[0].output = 100;
    const runB = mkRun({});
    runB.prompts[0].events[0].output = 100;
    runB.prompts[0].events[0].reasoningTokens = 0;
    runB.prompts[0].output = 100;
    const cmp = compareRunsCost(runA, runB)!;
    const md = formatComparisonAsMarkdown(cmp, { nameA: "a", nameB: "b" });
    expect(md).toContain("reasoning_tokens:** A=60, B=0");
    expect(md).toContain("visible_output_tokens:** A=40, B=100");
    // KPI table indented rows
    expect(md).toContain("Reasoning (hidden from user)");
    expect(md).toContain("Visible response tokens");
  });

  it("states 'reasoning_used: false' when neither run used extended thinking", () => {
    const cmp = compareRunsCost(mkRun({}), mkRun({}))!;
    const md = formatComparisonAsMarkdown(cmp, { nameA: "a", nameB: "b" });
    expect(md).toContain("reasoning_used:** false");
    expect(md).toContain("100% visible response text");
  });

  it("instructs the analyst to attribute every verbosity delta to reasoning vs visible", () => {
    const cmp = compareRunsCost(mkRun({}), mkRun({}))!;
    const out = buildComparisonLlmPrompt(cmp, { nameA: "a", nameB: "b" });
    expect(out).toContain("output-token attribution");
    expect(out).toContain("reasoning_tokens");
    expect(out).toContain("visible_output_tokens");
    expect(out).toContain("end user");
    expect(out).toContain("user actually saw");
  });

  it("treats different newString on the same partial-replace as 'differ'", () => {
    const oldS = "const VERSION = '1.0.0';";
    const runA = mkRun({ toolCalls: [] });
    runA.prompts[0].events.push({
      name: "str_replace", model: "", cost: 0, output: 0, cached: 0, fresh: 0, cacheWrite: 0,
      promptTokens: 0,
      rawArgs: JSON.stringify({ filePath: "/work/v.ts", oldString: oldS, newString: "const VERSION = '2.0.0';" }),
      argsSummary: "str_replace /work/v.ts", kind: "tool",
    });
    const runB = mkRun({ toolCalls: [] });
    runB.prompts[0].events.push({
      name: "str_replace", model: "", cost: 0, output: 0, cached: 0, fresh: 0, cacheWrite: 0,
      promptTokens: 0,
      rawArgs: JSON.stringify({ filePath: "/work/v.ts", oldString: oldS, newString: "const VERSION = '3.0.0';" }),
      argsSummary: "str_replace /work/v.ts", kind: "tool",
    });
    const cmp = compareRunsCost(runA, runB)!;
    const md = formatComparisonAsMarkdown(cmp, { nameA: "a", nameB: "b" });
    expect(md).toContain("partial-replace");
    expect(md).toContain("| differ |");
    expect(md).toContain("artifacts_identical:** false");
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

  it("ships long final answers in full (no aggressive trim) so the analyst can judge quality", () => {
    const longAnswer = "x".repeat(500);
    const runWithLong: any = mkRun({});
    runWithLong.prompts[0].events[0].responsePreview = longAnswer;
    const cmp = compareRunsCost(runWithLong, mkRun({}))!;
    const md = formatComparisonAsMarkdown(cmp, { nameA: "a", nameB: "b" });
    // Full 500-char content must be present (Layer 1: no trim in facts block)
    expect(md).toContain(longAnswer);
  });
});

import { buildComparisonLlmPrompt } from "../lib/exportComparison";

describe("buildComparisonLlmPrompt", () => {
  it("wraps comparison markdown with analyst instructions and run names", () => {
    const cmp = compareRunsCost(mkRun({}), mkRun({}))!;
    const out = buildComparisonLlmPrompt(cmp, { nameA: "baseline", nameB: "experiment" });
    expect(out).toContain("Cost Compare analysis prompt");
    expect(out).toContain("Runs under comparison");
    expect(out).toContain("Experiment summary");
    expect(out).toContain("What changed");
    expect(out).toContain("A/B verdict");
    expect(out).toContain("Core story");
    expect(out).toContain("Behavior comparison");
    expect(out).toContain("Output quality comparison");
    expect(out).toContain("Artifact outcome");
    expect(out).toContain("Cost outcome");
    expect(out).toContain("Cost drivers");
    expect(out).toContain("Divergence analysis");
    expect(out).toContain("Fixed overhead vs work-dependent cost");
    expect(out).toContain("Was the extra cost worth it?");
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

  it("triggers the 'Did the planned change land?' section when a multi-line plan is provided", () => {
    const cmp = compareRunsCost(mkRun({}), mkRun({}))!;
    const plan = [
      "Hypothesis: trimming tool defs shaves ~15% off every-call overhead.",
      "Expected effect: tool_defs bucket shrinks; history unchanged.",
      "Setup A (baseline): all skills enabled.",
      "Setup B (experiment): skills.json pruned to 3.",
      "Validation: same task list, same final summary.",
      "Risk: dropped skill causes a fallback search loop.",
    ].join("\n");
    const out = buildComparisonLlmPrompt(cmp, {
      nameA: "baseline",
      nameB: "pruned",
      techniqueUnderTest: plan,
    });
    expect(out).toContain("Experiment plan from the prior single-session analysis");
    expect(out).toContain("Did the planned change land?");
    expect(out).toContain("Hypothesis: trimming tool defs");
  });

  it("does NOT trigger the verification section for a single-line hypothesis", () => {
    const cmp = compareRunsCost(mkRun({}), mkRun({}))!;
    const out = buildComparisonLlmPrompt(cmp, {
      nameA: "baseline",
      nameB: "experiment",
      techniqueUnderTest: "B disables tool definitions",
    });
    expect(out).toContain("Technique under test");
    expect(out).not.toContain("Did the planned change land?");
  });

  it("always includes the shared-vocabulary appendix that aligns with single-session analysis", () => {
    const cmp = compareRunsCost(mkRun({}), mkRun({}))!;
    const out = buildComparisonLlmPrompt(cmp, { nameA: "a", nameB: "b" });
    expect(out).toContain("Shared vocabulary (matches the single-session LLM analysis)");
    expect(out).toContain("every_call_overhead");
    expect(out).toContain("cache_health: poor");
  });

  it("includes the user goal in the facts so the analyst can judge output quality", () => {
    const cmp = compareRunsCost(mkRun({}), mkRun({}))!;
    const out = buildComparisonLlmPrompt(cmp, { nameA: "a", nameB: "b" });
    expect(out).toContain("User goal");
    // mkRun uses "do the thing" as the first user prompt for both runs
    expect(out).toContain("do the thing");
  });

  it("instructs the analyst to produce an Output quality verdict in the report", () => {
    const cmp = compareRunsCost(mkRun({}), mkRun({}))!;
    const out = buildComparisonLlmPrompt(cmp, { nameA: "a", nameB: "b" });
    expect(out).toContain("### Output quality comparison");
    expect(out).toMatch(/answered better/);
    expect(out).toMatch(/Equivalent for the user's goal/);
    expect(out).toContain("Do not infer quality from cost");
    // New: usability-profile verdict so a format-only divergence isn't a cop-out
    expect(out).toContain("Different usefulness profile");
    // New: must judge meaning, not string equality
    expect(out).toMatch(/Judge[\s\S]*?meaning[\s\S]*?not string equality/i);
  });

  it("instructs the analyst to lead Output quality and Artifact outcome with the deterministic blocks", () => {
    const cmp = compareRunsCost(mkRun({}), mkRun({}))!;
    const out = buildComparisonLlmPrompt(cmp, { nameA: "a", nameB: "b" });
    // Output quality must reference Final-response signals + Edit artifacts diff
    expect(out).toContain("Final-response signals block");
    expect(out).toContain("substantive_numbers_agree");
    expect(out).toContain("referenced_paths_agree");
    expect(out).toContain("Edit artifacts diff block");
    expect(out).toContain("artifacts_identical");
    // Artifact outcome must lead with the diff block
    expect(out).toMatch(/Lead with the Edit artifacts diff block/);
  });

  it("includes the What changed scannable table and Core story hello-world framing", () => {
    const cmp = compareRunsCost(mkRun({}), mkRun({}))!;
    const out = buildComparisonLlmPrompt(cmp, { nameA: "a", nameB: "b" });
    expect(out).toContain("### What changed");
    expect(out).toContain("| Area | Changed? | Meaning |");
    expect(out).toContain("### Core story");
    expect(out).toMatch(/hello-world/i);
    expect(out).toMatch(/pre-divergence/);
    expect(out).toMatch(/amplification/i);
  });

  it("warns about telemetry path truncation in Artifact outcome and consolidates caveats", () => {
    const cmp = compareRunsCost(mkRun({}), mkRun({}))!;
    const out = buildComparisonLlmPrompt(cmp, { nameA: "a", nameB: "b" });
    expect(out).toContain("Path-anomaly check");
    expect(out).toMatch(/telemetry string truncation/i);
    expect(out).toContain("Maybe noise");
    // Anti-repetition guidance
    expect(out).toMatch(/do not[\s]+repeat/i);
  });

  it("gives the decision rule for Was the extra cost worth it", () => {
    const cmp = compareRunsCost(mkRun({}), mkRun({}))!;
    const out = buildComparisonLlmPrompt(cmp, { nameA: "a", nameB: "b" });
    expect(out).toContain("practical decision rule");
    expect(out).toContain("Unproven.");
  });

  it("emits deterministic decision-support, behavior-diff, configuration-diff, and fixed-vs-variable blocks in the facts", () => {
    const cmp = compareRunsCost(mkRun({}), mkRun({}))!;
    const out = buildComparisonLlmPrompt(cmp, { nameA: "a", nameB: "b" });
    expect(out).toContain("## Decision support");
    expect(out).toContain("cheaper_run:");
    expect(out).toContain("attribution_confidence:");
    expect(out).toContain("safe_to_recommend_cheaper_run:");
    expect(out).toContain("## Behavior diff");
    expect(out).toContain("same_call_shape:");
    expect(out).toContain("same_final_answer:");
    expect(out).toContain("## Configuration diff");
    expect(out).toContain("primary_model_same:");
    expect(out).toContain("system_prompt_hash:");
    expect(out).toContain("## Fixed vs variable cost");
    expect(out).toContain("fixed_overhead_share_a:");
    expect(out).toContain("fixed_overhead_share_b:");
  });

  it("encodes the hard rules and requires Artifact outcome and 'Was the extra cost worth it?' sections", () => {
    const cmp = compareRunsCost(mkRun({}), mkRun({}))!;
    const out = buildComparisonLlmPrompt(cmp, { nameA: "a", nameB: "b" });
    expect(out).toContain("Hard rules");
    expect(out).toContain("Never treat lower cost as better by itself");
    expect(out).toContain("Always include \"Artifact outcome\"");
    expect(out).toContain("Always include \"Was the extra cost worth it?\"");
    expect(out).toContain("attribution_confidence");
  });
});
