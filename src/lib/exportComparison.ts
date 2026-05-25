// Pure formatter that turns a CostComparison into a single markdown blob
// designed for paste-into-chat. Lossless reference for the comparison's
// numeric state plus the deterministic axes (drift, behavioral KPIs,
// projections) so two parties can discuss the same result without
// transcribing screenshots.
//
// Pure function. No I/O, no formatting choices that depend on theme.

import type { CostComparison, BehavioralKpiValue, DriftRow, BucketDelta } from "./compareCost";
import { inferTechniqueFromRunNames } from "./runDisplayName";

export interface FormatOptions {
  nameA?: string;
  nameB?: string;
  /** Optional technique-under-test label to include in the header. */
  technique?: string;
}

function fmtCr(usd: number): string {
  if (!isFinite(usd)) return "--";
  const cr = usd * 100;
  if (cr === 0) return "0 cr";
  if (Math.abs(cr) < 0.01) return cr.toFixed(3) + " cr";
  if (Math.abs(cr) < 10)   return cr.toFixed(2) + " cr";
  if (Math.abs(cr) < 100)  return cr.toFixed(1) + " cr";
  return Math.round(cr).toLocaleString() + " cr";
}

function fmtPctSigned(n: number | null): string {
  if (n == null || !isFinite(n)) return "--";
  const sign = n < 0 ? "" : "+";
  return sign + (n * 100).toFixed(Math.abs(n) < 0.01 ? 2 : 1) + "%";
}

function fmtNum(n: number, decimals = 0): string {
  if (!isFinite(n)) return "--";
  if (decimals > 0) return n.toFixed(decimals);
  return Math.round(n).toLocaleString();
}

function fmtSignedTok(n: number): string {
  if (n === 0) return "0";
  return (n > 0 ? "+" : "") + Math.round(n).toLocaleString();
}

function trimAnswer(s: string, max = 200): string {
  if (!s) return "(empty)";
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : flat.slice(0, max) + "…";
}

function kpiRow(label: string, kpi: BehavioralKpiValue, decimals = 0): string {
  const a = fmtNum(kpi.a, decimals);
  const b = fmtNum(kpi.b, decimals);
  const sign = kpi.delta > 0 ? "+" : ""; // negative numbers print their own minus
  const deltaStr = decimals > 0 ? kpi.delta.toFixed(decimals) : Math.round(kpi.delta).toLocaleString();
  const pct = fmtPctSigned(kpi.deltaPct);
  return `| ${label} | ${a} | ${b} | ${sign}${deltaStr} | ${pct} |`;
}

function driftRow(row: DriftRow): string {
  const icon = row.status === "match" ? "✓" : row.status === "diff" ? "⚠" : "•";
  const blocking = row.blocking && row.status === "diff" ? " (blocking)" : "";
  const detail = row.detail ? `<br/>${row.detail.replace(/\n/g, "<br/>")}` : "";
  return `| ${icon} | ${row.label}${blocking} | ${row.aText} | ${row.bText}${detail} |`;
}

function bucketRow(d: BucketDelta): string {
  return `| ${d.bucket} | ${fmtCr(d.delta)} | ${fmtPctSigned(d.deltaPct)} |`;
}

export function formatComparisonAsMarkdown(
  cmp: CostComparison,
  opts: FormatOptions = {}
): string {
  const nameA = opts.nameA || "Run A";
  const nameB = opts.nameB || "Run B";
  const technique = opts.technique;
  const lines: string[] = [];

  // Header
  lines.push(`# Cost compare summary: ${nameA} vs ${nameB}`);
  lines.push("");
  if (technique) {
    lines.push(`**Technique under test:** ${technique}`);
    lines.push("");
  }
  lines.push(`**Verdict:** ${cmp.verdict.headline}`);
  if (cmp.verdict.detail) lines.push(`> ${cmp.verdict.detail}`);
  lines.push("");
  lines.push(`**Final answers equivalent:** ${cmp.answersEquivalent ? "yes" : "no"}`);
  lines.push("");

  // Run drift
  lines.push("## Run drift");
  lines.push("Things that should be identical between A and B if the test holds only the variable under study.");
  lines.push("");
  lines.push("| Status | Axis | A | B |");
  lines.push("|---|---|---|---|");
  for (const row of cmp.drift.rows) lines.push(driftRow(row));
  lines.push("");
  if (cmp.drift.hasBlockingDrift) {
    lines.push("> ⚠ Blocking drift detected. Cost numbers below may not be causally attributable to the technique.");
    lines.push("");
  }

  // Pre/post divergence
  const ds = cmp.divergenceSplit;
  lines.push("## Pre- vs post-divergence cost split");
  lines.push("Pre-divergence = first primary LLM call (path-free, prefix only). Post-divergence = everything after (path-dependent).");
  lines.push("");
  lines.push(`- **Prefix tax (input tokens, first primary call):** A ${fmtNum(ds.preInputTokensA)} · B ${fmtNum(ds.preInputTokensB)} · Δ ${fmtSignedTok(ds.preInputDelta)} tok`);
  lines.push(`- **Pre-divergence cost:** A ${fmtCr(ds.preCostA)} · B ${fmtCr(ds.preCostB)} · Δ ${ds.preDelta >= 0 ? "+" : ""}${fmtCr(ds.preDelta)} (${fmtPctSigned(ds.preDeltaPct)})`);
  lines.push(`- **Post-divergence cost:** A ${fmtCr(ds.postCostA)} · B ${fmtCr(ds.postCostB)} · Δ ${ds.postDelta >= 0 ? "+" : ""}${fmtCr(ds.postDelta)} (${fmtPctSigned(ds.postDeltaPct)})`);
  lines.push("");

  // Prefix tax projection
  if (cmp.prefixTaxProjections && cmp.prefixTaxProjections.length > 0 && ds.preInputDelta !== 0) {
    lines.push("## Prefix tax projected over each run's actual call shape");
    lines.push(`Lower bound: assumes path stays identical. Cache amortization built in via each call's effective per-input-token cost.`);
    lines.push("");
    lines.push("| Template | Calls | Template total | Projected extra | Δ % |");
    lines.push("|---|---|---|---|---|");
    for (const p of cmp.prefixTaxProjections) {
      const label = p.templateRef === "A" ? `A · ${nameA}` : `B · ${nameB}`;
      lines.push(`| ${label} | ${p.callCount} | ${fmtCr(p.templateTotalCost)} | ${p.projectedExtraCost >= 0 ? "+" : ""}${fmtCr(p.projectedExtraCost)} | ${fmtPctSigned(p.projectedExtraPct)} |`);
    }
    lines.push("");
  }

  // Headline KPIs
  lines.push("## Headline cost KPIs");
  lines.push("");
  lines.push("| KPI | A | B | Δ | Δ % |");
  lines.push("|---|---|---|---|---|");
  for (const k of cmp.kpis) {
    const sign = k.delta > 0 ? "+" : "";
    const aFmt = k.key.includes("cost") || k.key === "totalCost" ? fmtCr(k.a) : fmtNum(k.a, 2);
    const bFmt = k.key.includes("cost") || k.key === "totalCost" ? fmtCr(k.b) : fmtNum(k.b, 2);
    const dFmt = k.key.includes("cost") || k.key === "totalCost" ? `${sign}${fmtCr(k.delta)}` : `${sign}${fmtNum(k.delta, 2)}`;
    lines.push(`| ${k.label} | ${aFmt} | ${bFmt} | ${dFmt} | ${fmtPctSigned(k.deltaPct)} |`);
  }
  lines.push("");

  // Behavioral KPIs
  const bk = cmp.behavioralKpis;
  lines.push("## Behavioral KPIs");
  lines.push("Cost-free, deterministic. Use these as the primary axes for path-affecting or output-affecting techniques (cost is descriptive only at N=1).");
  lines.push("");
  lines.push("| Metric | A | B | Δ | Δ % |");
  lines.push("|---|---|---|---|---|");
  lines.push(kpiRow("Primary LLM calls", bk.primaryLlmCalls));
  lines.push(kpiRow("Tool calls", bk.toolCalls));
  lines.push(kpiRow("Distinct tools", bk.distinctTools));
  lines.push(kpiRow("Distinct files touched", bk.distinctFilesTouched));
  lines.push(kpiRow("Total output tokens", bk.totalOutputTokens));
  lines.push(kpiRow("Avg output per call", bk.avgOutputPerCall, 1));
  lines.push(kpiRow("Avg user message chars", bk.avgUserMessageChars, 1));
  lines.push(kpiRow("User turns", bk.userTurns));
  lines.push("");

  // Bucket waterfall
  lines.push("## Per-bucket cost delta (B − A)");
  lines.push("");
  lines.push("| Bucket | Δ cost | Δ % |");
  lines.push("|---|---|---|");
  for (const d of cmp.bucketDeltas) lines.push(bucketRow(d));
  lines.push("");

  // Cache pollution
  if (cmp.cachePollution.suspect) {
    lines.push("## ⚠ Cache pollution suspected");
    if (cmp.cachePollution.reason) {
      lines.push(`> ${cmp.cachePollution.reason}`);
    }
    lines.push("");
  }

  // Recommendations
  if (cmp.recommendations.length > 0) {
    lines.push("## Recommendations (rule-based, no LLM)");
    lines.push("");
    for (const r of cmp.recommendations) {
      lines.push(`- **${r.title}** -- ${r.body}`);
    }
    lines.push("");
  }

  // Final answer hashes + previews
  lines.push("## Final responses");
  lines.push("");
  lines.push(`### A · ${nameA}`);
  lines.push("```");
  lines.push(trimAnswer(cmp.finalAnswerA));
  lines.push("```");
  lines.push("");
  lines.push(`### B · ${nameB}`);
  lines.push("```");
  lines.push(trimAnswer(cmp.finalAnswerB));
  lines.push("```");
  lines.push("");

  lines.push("---");
  lines.push("Generated from agentviz Cost Compare. All numbers computed deterministically from the parsed cost analysis.");

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// LLM analysis export
// ---------------------------------------------------------------------------
//
// Wraps formatComparisonAsMarkdown with analyst instructions so an external
// LLM can write a focused report comparing two runs. Mirrors the
// single-session llmAnalysisExport pattern: structured facts (the markdown
// summary) + a "what to produce" instruction block, all in one pasteable
// string.

export interface LlmCompareOptions extends FormatOptions {
  /** Optional one-line description of what changed between A and B
   * (e.g. "B disables tool defs", "B uses Auto mode"). Helps the analyst
   * frame the diff as a hypothesis under test. */
  techniqueUnderTest?: string;
}

// Plan-shaped input is multi-line and typically contains structured
// labels like "Hypothesis:", "Expected effect:", "Setup A", "Setup B".
// If we see at least two of these markers, treat the input as a full
// A/B test handoff plan and ask the analyst to verify each item.
function looksLikePlan(text: string | undefined): boolean {
  if (!text) return false;
  const t = text.toLowerCase();
  const markers = [
    "hypothesis:",
    "expected effect:",
    "setup a",
    "setup b",
    "validation:",
    "a/b test handoff",
  ];
  let hits = 0;
  for (const m of markers) {
    if (t.includes(m)) hits++;
    if (hits >= 2) return true;
  }
  return false;
}

function buildComparePromptHeader(
  nameA: string,
  nameB: string,
  hypothesis: string | null,
  sharedContext: string | null,
  explicitTechnique: string | undefined,
): string {
  const planMode = looksLikePlan(explicitTechnique);
  const lines: string[] = [];
  lines.push("# Cost Compare analysis prompt");
  lines.push("");
  lines.push("You are a Copilot cost-optimization analyst. The block below contains a");
  lines.push("deterministic, side-by-side comparison of two VS Code Copilot Chat runs,");
  lines.push("exported from agentviz Cost Compare. All numbers in the block are ground");
  lines.push("truth.");
  lines.push("");
  lines.push("## Runs under comparison");
  lines.push("");
  lines.push(`- **A** = \`${nameA}\``);
  lines.push(`- **B** = \`${nameB}\``);
  if (sharedContext) {
    lines.push(`- Shared scenario inferred from the names: \`${sharedContext}\``);
  }
  lines.push("");
  lines.push("**Use the run labels above (or their short variants) throughout the report");
  lines.push("instead of generic \"A\" and \"B\". For example, write");
  lines.push(`\"${nameA} spent fewer tokens on tool definitions than ${nameB}\" rather than`);
  lines.push("\"A spent fewer tokens than B\".**");
  lines.push("");

  if (explicitTechnique && planMode) {
    lines.push("## Experiment plan from the prior single-session analysis");
    lines.push("");
    lines.push("The developer ran a single-session analysis on a previous run, got an");
    lines.push("A/B test handoff block, implemented the experiment, and pasted that");
    lines.push("plan here. Your job is to **verify the plan against the diff**:");
    lines.push("which items landed, which had the expected effect, which had side");
    lines.push("effects, which are not detectable in the diff.");
    lines.push("");
    lines.push("```text");
    lines.push(explicitTechnique.trim());
    lines.push("```");
    lines.push("");
  } else if (explicitTechnique) {
    lines.push("## Technique under test (provided)");
    lines.push("");
    lines.push(explicitTechnique.trim());
    lines.push("");
  } else if (hypothesis) {
    lines.push("## Technique under test (inferred from file names)");
    lines.push("");
    lines.push(hypothesis);
    lines.push("");
    lines.push("This was inferred from the file names. If the names do not actually");
    lines.push("encode the experiment intent, treat this as a weak hint only and lead");
    lines.push("with what the numbers actually show.");
    lines.push("");
  } else {
    lines.push("## Technique under test");
    lines.push("");
    lines.push("The run names do not encode an obvious experiment hypothesis. Infer what");
    lines.push("you can from the numbers themselves: are the runs the same workflow with");
    lines.push("different settings, the same prompt at different times, or two unrelated");
    lines.push("sessions? Say so plainly in the report.");
    lines.push("");
  }

  return lines.join("\n");
}

function buildReportInstructions(planMode: boolean): string {
  const lines: string[] = [];
  lines.push("## What to produce");
  lines.push("");
  lines.push("Write a focused developer-facing report with these sections, in order.");
  lines.push("Use the run labels from \"Runs under comparison\" above; do not say \"A\"");
  lines.push("or \"B\" in prose unless quoting a table.");
  lines.push("");
  lines.push("### What changed");
  lines.push("2–3 sentences. Name the technique under test (use the provided or");
  lines.push("inferred hypothesis above). State whether the runs are equivalent in");
  lines.push("shape (same call count, same answers, same drift status) or whether");
  lines.push("the second run diverged behaviorally from the first. If the runs");
  lines.push("diverged, say so plainly — divergent runs cannot cleanly attribute");
  lines.push("cost deltas to the technique.");
  lines.push("");
  lines.push("### Cost outcome");
  lines.push("One short paragraph. Did the second run save money, cost more, or stay");
  lines.push("flat? Quote the headline delta in both cr and USD if shown. Use the");
  lines.push("pre-vs-post-divergence split to say what fraction of the delta is");
  lines.push("attributable to the prompt prefix change vs path-dependent agent");
  lines.push("behavior. If a projection is shown, quote the projected savings over N");
  lines.push("calls.");
  lines.push("");
  lines.push("### What caused it");
  lines.push("3–5 bullets. Translate the bucket waterfall and per-call breakdown");
  lines.push("into developer meaning, e.g. \"<nameB> dropped tool_defs by X cr");
  lines.push("because tools were unregistered\", \"<nameB> paid less in history");
  lines.push("because the conversation was shorter\", \"<nameB> output Y% fewer");
  lines.push("response tokens because the answer was terser\". Avoid raw field");
  lines.push("names. End each bullet with the supporting number. Use the bucket");
  lines.push("vocabulary defined in the appendix below.");
  lines.push("");

  if (planMode) {
    lines.push("### Did the planned change land?");
    lines.push("This section is required because the developer provided an");
    lines.push("experiment plan from the prior single-session analysis. For each");
    lines.push("item in the plan (Hypothesis, Expected effect, Setup B differences,");
    lines.push("Validation), give one bullet with a verdict prefix:");
    lines.push("");
    lines.push("- ✅ **Landed, effect as expected** — the diff shows the change and");
    lines.push("  the numbers match the predicted direction and magnitude.");
    lines.push("- ✅ **Landed, smaller/larger than expected** — the change is");
    lines.push("  visible but the effect is materially different. Quote both the");
    lines.push("  expected and observed numbers.");
    lines.push("- ⚠ **Landed with side effect** — the change is visible but caused");
    lines.push("  an unintended shift (e.g. answer divergence, drift, cache pollution).");
    lines.push("- ❌ **Not detectable in the diff** — the diff does not show evidence");
    lines.push("  the change was actually made. Ask the developer to confirm.");
    lines.push("- ❓ **Not measurable from this comparison** — the plan asks about");
    lines.push("  something the comparison cannot show (e.g. answer quality without");
    lines.push("  validation data).");
    lines.push("");
    lines.push("Cite the supporting metric in parentheses for each bullet.");
    lines.push("");
  }

  lines.push("### Warnings and caveats");
  lines.push("Surface anything that makes the comparison less trustworthy:");
  lines.push("- run drift on identical-by-construction axes (blocking),");
  lines.push("- cache pollution (a fresh cache run vs a warm cache run),");
  lines.push("- divergent answers when the technique was expected to be answer-equivalent,");
  lines.push("- different call shapes when the technique was expected to be shape-preserving.");
  lines.push("");
  lines.push("If the inferred hypothesis from the file names does not match what");
  lines.push("the numbers show (e.g. names suggest \"tool defs disabled\" but");
  lines.push("tool_defs cost is unchanged), call that out explicitly.");
  lines.push("");
  lines.push("If no caveats apply, say \"No blocking caveats. The comparison is");
  lines.push("attributable to the technique under test.\"");
  lines.push("");
  lines.push("### What to validate next");
  lines.push("2–3 bullets. What follow-up runs or measurements would make the");
  lines.push("result more conclusive? Examples: re-run with cache pre-warmed on");
  lines.push("both sides, re-run with the same first prompt to remove prefix");
  lines.push("drift, capture quality validation (tests / human review) before");
  lines.push("claiming the cheaper run is \"as good\".");
  lines.push(planMode
    ? "If any plan item came back as ❌ or ❓, the first validation step should be re-running the experiment with that item explicitly addressed."
    : "");
  lines.push("");
  lines.push("## Rules");
  lines.push("");
  lines.push("- Do not invent metrics. Only use numbers present in the comparison");
  lines.push("  block. If a metric is missing, say so explicitly.");
  lines.push("- Refer to the runs by their labels (provided above), not \"A\" / \"B\".");
  lines.push("- If the runs have different answers and the technique was supposed");
  lines.push("  to preserve the answer, flag that as a blocking caveat before");
  lines.push("  recommending the cheaper run.");
  lines.push("- Do not recommend a cheaper model or Auto mode based on this");
  lines.push("  comparison alone unless quality validation is mentioned in the");
  lines.push("  block.");
  if (planMode) {
    lines.push("- The plan-verification section is required. Do not skip it, even");
    lines.push("  if the plan looks incomplete; mark unmeasurable items as ❓.");
  }
  lines.push("- Keep the report " + (planMode ? "500–700" : "400–600") + " words. Use bullets liberally. Avoid section");
  lines.push("  preambles like \"In this section we will…\".");
  lines.push("- Cite numbers inline; do not duplicate the comparison block.");
  lines.push("");
  lines.push("The comparison block is the source of truth. If your prose seems to");
  lines.push("contradict it, the block wins — rewrite the prose.");
  lines.push("");
  lines.push("## Shared vocabulary (matches the single-session LLM analysis)");
  lines.push("");
  lines.push("- **Bucket / cost category** — where tokens are spent in a single call:");
  lines.push("  - `system` = system prompt + custom chat mode instructions.");
  lines.push("  - `tool_defs` = tool/skill registration overhead (shipped every call).");
  lines.push("  - `history` = accumulated conversation history.");
  lines.push("  - `tool_results` = output of tool calls carried back into context.");
  lines.push("  - `current` = the user's prompt for this turn.");
  lines.push("  - `output` = the model's response.");
  lines.push("- **Workflow shape** — `efficient_single_pass`, `tool_heavy_but_expected`, `many_model_turns_for_repeatable_workflow`, `terminal_heavy_orchestration`, `hidden_deliberation_spike`.");
  lines.push("- **Cache pollution** — a comparison artifact where one run hit a warm cache and the other did not. Single-session analysis calls this `cache_health: poor`. Both views agree.");
  lines.push("- **Fixed vs variable cost** — the share of cost paid on every call regardless of the user's request (system + tool_defs + skill carry) vs the share that scales with the actual work. Single-session calls this `every_call_overhead`.");
  return lines.join("\n");
}

export function buildComparisonLlmPrompt(
  cmp: CostComparison,
  opts: LlmCompareOptions = {}
): string {
  const facts = formatComparisonAsMarkdown(cmp, opts);
  const inferred = inferTechniqueFromRunNames(opts.nameA, opts.nameB);
  const header = buildComparePromptHeader(
    inferred.nameA,
    inferred.nameB,
    inferred.hypothesis,
    inferred.sharedContext,
    opts.techniqueUnderTest,
  );
  const planMode = looksLikePlan(opts.techniqueUnderTest);
  return [
    header,
    buildReportInstructions(planMode),
    "## Comparison facts (source of truth)\n",
    facts,
  ].join("\n");
}
