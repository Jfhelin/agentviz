// Pure formatter that turns a CostComparison into a single markdown blob
// designed for paste-into-chat. Lossless reference for the comparison's
// numeric state plus the deterministic axes (drift, behavioral KPIs,
// projections) so two parties can discuss the same result without
// transcribing screenshots.
//
// Pure function. No I/O, no formatting choices that depend on theme.

import type { CostComparison, BehavioralKpiValue, DriftRow, BucketDelta } from "./compareCost";

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
