// Pure cost-comparison logic for two parsed Copilot Chat exports.
//
// Consumes two `costAnalysis` objects (the structure emitted by
// copilotChatExportParser.ts) and produces everything the CostCompare view
// needs to render. NO side effects, NO LLM calls, NO formatting. Formatting
// is done in the view.
//
// Design notes:
//   - "Fixed" buckets = system, tool_defs (workspace context lives in
//     `current` per-prompt-1 in Copilot Chat exports; we treat it as
//     fixed per call IF the bucket value is large and nearly identical
//     between calls -- but for v1 we keep the definition simple).
//   - "Variable" = history + tool_results + current + response (output).
//   - Answer equivalence: byte-equal final responsePreview, after
//     trim+collapse-whitespace+lowercase.
//   - Buckets we compare across runs match the existing CostView buckets
//     in `CTX_KEYS`: system, tool_defs, history, tool_results, current,
//     output.

export type Bucket = "system" | "tool_defs" | "history" | "tool_results" | "current" | "output";

export const BUCKETS: Bucket[] = ["system", "tool_defs", "history", "tool_results", "current", "output"];
const FIXED_BUCKETS: Bucket[] = ["system", "tool_defs"];
const VARIABLE_BUCKETS: Bucket[] = ["history", "tool_results", "current", "output"];

interface CostAnalysisLike {
  prompts: PromptLike[];
  totals: TotalsLike;
}
interface PromptLike {
  index: number;
  cost: number;
  output: number;
  cached: number;
  fresh: number;
  cacheWrite: number;
  promptTokens: number;
  llmCount: number;
  events: EventLike[];
  /** User-facing prompt text (max ~200 chars) extracted from the export.
   * For overhead calls this will be e.g. "title" / "categorization". */
  label?: string;
}
interface EventLike {
  name: string;
  model: string;
  cost: number;
  output: number;
  cached: number;
  fresh: number;
  cacheWrite: number;
  promptTokens: number;
  components?: Partial<Record<Bucket, number>>;
  responsePreview?: string;
  currentText?: string;
  systemPreview?: string;
  /** Full character length of this call's system text. When present and >
   * systemPreview.length, the preview is truncated and downstream hashes of
   * systemPreview should be treated as preview-only. */
  systemChars?: number;
  /** Hash of the FULL (un-truncated) system text. Use this in preference to
   * hashing systemPreview when present. */
  systemHash?: string;
  argsSummary?: string;
  rawArgs?: string;
  /** "primary" = real user-facing chat call. "overhead" = UI/telemetry side
   * call (e.g. "title", "promptCategorization") that should be filtered out
   * when summarizing per-turn user prompts. */
  category?: "primary" | "overhead";
  kind?: "llm" | "tool";
}
interface TotalsLike {
  promptTokens: number;
  output: number;
  cached: number;
  fresh: number;
  cacheWrite: number;
  cost: number;
  llmCalls: number;
  toolCalls: number;
  cacheHitRate: number;
}

export interface RunSummary {
  totalCost: number;
  totalInput: number;        // promptTokens (raw, includes cached)
  totalOutput: number;
  totalCached: number;
  totalFresh: number;
  totalCacheWrite: number;
  cacheHitRate: number;      // 0..1
  promptCount: number;
  llmCallCount: number;
  fixedCost: number;         // sum of estimated bucket cost across system+tool_defs
  variableCost: number;      // remainder
  fixedShare: number;        // fixedCost / totalCost
  componentTokens: Record<Bucket, number>;  // sum across calls
  componentShare: Record<Bucket, number>;   // tokens-of-bucket / total-input-incl-output
  /** Pro-rated cost (in cents-style credit units, same as totalCost) per bucket. */
  bucketCost: Record<Bucket, number>;
  models: string[];                          // distinct models used
  primaryModel: string | null;               // model of most expensive call
  finalAnswer: string;                       // final assistant response across the whole run
  userPromptText: string;                    // last user prompt text (best-effort)
  /** Per-user-prompt summary (skipping overhead prompts like "title" /
   * "promptCategorization"). One entry per user-facing chat turn, in order. */
  userPrompts: Array<{ label: string; finalAnswer: string }>;
  /** Cache hit rate of the FIRST primary (non-overhead) LLM call. Used to
   * detect cache pollution: a brand-new conversation should start near 0. */
  firstPrimaryCallCacheHit: number;
  /** Total cached + fresh input tokens of the first primary call (denominator
   * for the hit rate above). When small, the rate is unreliable. */
  firstPrimaryCallInputTokens: number;
  /** Average effective input rate ($/1M input tokens), computed as
   * (totalCost - output-bucket-cost) / totalInput * 1e6. Surfaces model-rate
   * differences (e.g. premium vs. Auto-tier). */
  avgInputRatePerMTok: number;
  /** Average effective output rate ($/1M output tokens). */
  avgOutputRatePerMTok: number;
}

export interface KpiPair {
  key: string;
  label: string;
  a: number;
  b: number;
  delta: number;       // b - a
  deltaPct: number | null;  // (b - a) / a; null if a is 0
  /** Direction the user usually wants: "lower" means lower-is-better. */
  direction: "lower" | "higher" | "neutral";
}

export interface CallPair {
  /** Best-effort matched call name (e.g. "title", "panel/editAgent"). */
  name: string;
  a: EventLike | null;
  b: EventLike | null;
  /** Same model on both sides? */
  sameModel: boolean;
}

export type VerdictKind =
  | "noise"               // |delta_pct| < 0.02 - basically identical
  | "savings_equivalent"  // B cheaper, answers equivalent
  | "savings_divergent"   // B cheaper but answers differ
  | "more_expensive"      // B more expensive
  | "broadly_similar";    // catch-all

export interface Verdict {
  kind: VerdictKind;
  headline: string;
  detail: string;
  /** Color hint for the view: "neutral" | "success" | "warning" | "error" */
  tone: "neutral" | "success" | "warning" | "error";
}

export interface Recommendation {
  id: string;
  title: string;
  body: string;
}

export interface BucketDelta {
  bucket: Bucket;
  aCost: number;
  bCost: number;
  delta: number;          // bCost - aCost (negative = savings)
  deltaPct: number | null;
  /** Share of the absolute total swing this bucket contributed (0..1). Used
   * to size the waterfall bars proportionally. */
  shareOfSwing: number;
}

export interface CachePollution {
  /** True iff the comparison is suspected to be polluted by warm-cache reuse. */
  suspect: boolean;
  /** Which side(s) look cache-warmed. */
  side: "A" | "B" | "both" | null;
  /** Human-readable explanation of the heuristic that fired. */
  reason: string;
}

/** Per-run "fingerprint" that should be identical between A/B if the test
 * holds only the variable under study. Mismatches surface as drift. */
export interface RunFingerprint {
  models: string[];
  primaryModel: string | null;
  turnCount: number;
  llmCallCount: number;
  firstUserPrompt: string;
  firstUserPromptHash: string;
  systemPromptText: string;
  systemPromptChars: number;
  systemPromptHash: string;
  /** True when systemPromptHash was computed from the full system text (via
   * the parser), false when only the truncated preview was available. A false
   * value here means a System prompt drift row of "match" should be qualified
   * as "preview only". */
  systemPromptHashTrusted: boolean;
  filesTouched: string[];   // sorted unique paths from any tool args
  filesEdited: string[];    // sorted unique paths from edit/write/create tools
  toolsInvoked: string[];   // sorted unique tool names actually called
}

export interface DriftRow {
  /** Stable id for keying. */
  key: string;
  /** Display label for the row. */
  label: string;
  /** "match" = identical / "diff" = divergent / "info" = data-only, no judgement. */
  status: "match" | "diff" | "info";
  /** Side A summary (string for compact rendering). */
  aText: string;
  /** Side B summary. */
  bText: string;
  /** Optional extra detail (e.g. "A only:", "B only:" lists). */
  detail?: string;
  /** Whether this row, if drifted, likely invalidates the comparison. */
  blocking?: boolean;
}

export interface DriftReport {
  rows: DriftRow[];
  /** True iff any blocking row is in "diff" state. */
  hasBlockingDrift: boolean;
  /** True iff any row at all is in "diff" state. */
  hasAnyDrift: boolean;
}

export interface CostComparison {
  a: RunSummary;
  b: RunSummary;
  kpis: KpiPair[];
  callPairs: CallPair[];
  /** True iff both final answers are byte-equivalent after normalization. */
  answersEquivalent: boolean;
  finalAnswerA: string;
  finalAnswerB: string;
  userTextA: string;
  userTextB: string;
  /** Per-user-prompt detail per side (overhead prompts already filtered).
   * Useful for runs with multiple chat turns where the I/O panel needs to
   * show each prompt + response pair instead of just the last one. */
  userPromptsA: Array<{ label: string; finalAnswer: string }>;
  userPromptsB: Array<{ label: string; finalAnswer: string }>;
  /** Same number of LLM calls AND same call-name sequence. */
  sameShape: boolean;
  /** Headline verdict and tone. */
  verdict: Verdict;
  /** Rule-driven, deterministic recommendations relevant to THIS pair. */
  recommendations: Recommendation[];
  /** Per-bucket cost deltas (B - A), sorted by absolute delta descending.
   * Drives the waterfall view: at-a-glance "system saved 1.4 cr,
   * tool_defs saved 0.8 cr" attribution. */
  bucketDeltas: BucketDelta[];
  /** Cache-pollution diagnostic. When `suspect` is true the headline numbers
   * may be misleading because B inherited cache state from A (or vice-versa). */
  cachePollution: CachePollution;
  /** Side-by-side fingerprint for both runs (model, turns, files, tools, etc.).
   * Useful for the drift panel and direct programmatic comparisons. */
  fingerprintA: RunFingerprint;
  fingerprintB: RunFingerprint;
  /** Status rows for the "Run Drift" panel that surfaces things which should
   * be identical between A and B but might silently diverge. */
  drift: DriftReport;
}

// ---------- Helpers ----------

function summarizeRun(ca: CostAnalysisLike | null | undefined): RunSummary {
  const empty: RunSummary = {
    totalCost: 0, totalInput: 0, totalOutput: 0, totalCached: 0, totalFresh: 0, totalCacheWrite: 0,
    cacheHitRate: 0, promptCount: 0, llmCallCount: 0,
    fixedCost: 0, variableCost: 0, fixedShare: 0,
    componentTokens: zeroBuckets(), componentShare: zeroBuckets(), bucketCost: zeroBuckets(),
    models: [], primaryModel: null,
    finalAnswer: "", userPromptText: "", userPrompts: [],
    firstPrimaryCallCacheHit: 0, firstPrimaryCallInputTokens: 0,
    avgInputRatePerMTok: 0, avgOutputRatePerMTok: 0,
  };
  if (!ca || !Array.isArray(ca.prompts) || ca.prompts.length === 0) return empty;

  let totalCost = 0, totalInput = 0, totalOutput = 0, totalCached = 0, totalFresh = 0, totalCacheWrite = 0;
  let llmCallCount = 0;
  const compTok = zeroBuckets();
  const modelSet = new Set<string>();
  let mostExpensiveCall: EventLike | null = null;

  for (const p of ca.prompts) {
    totalCost += p.cost || 0;
    totalInput += p.promptTokens || 0;
    totalOutput += p.output || 0;
    totalCached += p.cached || 0;
    totalFresh += p.fresh || 0;
    totalCacheWrite += p.cacheWrite || 0;
    for (const ev of p.events || []) {
      llmCallCount++;
      if (ev.model) modelSet.add(ev.model);
      if (!mostExpensiveCall || (ev.cost || 0) > (mostExpensiveCall.cost || 0)) {
        mostExpensiveCall = ev;
      }
      if (ev.components) {
        for (const k of BUCKETS) {
          if (k === "output") continue;
          const v = (ev.components as any)[k] || 0;
          compTok[k] += v;
        }
      }
      compTok.output += ev.output || 0;
    }
  }

  // Fixed/variable cost: pro-rata each call's cost into buckets by token share
  // of that call's components, then sum fixed buckets vs variable buckets.
  // Also accumulate per-bucket cost for the waterfall.
  let fixedCost = 0, variableCost = 0;
  const bucketCost = zeroBuckets();
  for (const p of ca.prompts) {
    for (const ev of p.events || []) {
      const comps: Partial<Record<Bucket, number>> = {
        ...(ev.components || {}),
        output: ev.output || 0,
      };
      const sum = BUCKETS.reduce((a, k) => a + (comps[k] || 0), 0);
      if (sum <= 0) continue;
      for (const k of BUCKETS) {
        const share = (comps[k] || 0) / sum;
        const slice = (ev.cost || 0) * share;
        bucketCost[k] += slice;
        if (FIXED_BUCKETS.includes(k)) fixedCost += slice;
        else variableCost += slice;
      }
    }
  }

  const totalForShare = BUCKETS.reduce((a, k) => a + compTok[k], 0);
  const compShare = zeroBuckets();
  if (totalForShare > 0) {
    for (const k of BUCKETS) compShare[k] = compTok[k] / totalForShare;
  }

  const cacheDenom = totalCached + totalFresh + totalCacheWrite;
  const cacheHitRate = cacheDenom > 0 ? totalCached / cacheDenom : 0;

  // Final answer = response preview of the LAST event of the LAST non-overhead
  // prompt. Falls back to the very last event if every prompt is overhead.
  function isOverheadPrompt(p: PromptLike): boolean {
    const llmEvents = p.events.filter((e) => e.kind === "llm");
    if (llmEvents.length === 0) return false;
    return llmEvents.every((e) => e.category === "overhead");
  }
  const userFacingPrompts = ca.prompts.filter((p) => !isOverheadPrompt(p));
  const userPrompts: Array<{ label: string; finalAnswer: string }> = userFacingPrompts.map((p) => {
    const lastE = p.events.length ? p.events[p.events.length - 1] : null;
    return {
      label: (p.label || "").trim(),
      finalAnswer: (lastE && (lastE as any).responsePreview) || "",
    };
  });
  const lastUserPrompt = userPrompts.length ? userPrompts[userPrompts.length - 1] : null;
  const fallbackLast = ca.prompts[ca.prompts.length - 1];
  const fallbackLastEv = fallbackLast && fallbackLast.events.length
    ? fallbackLast.events[fallbackLast.events.length - 1]
    : null;
  const finalAnswer = lastUserPrompt
    ? lastUserPrompt.finalAnswer
    : ((fallbackLastEv && (fallbackLastEv as any).responsePreview) || "");
  const userPromptText = lastUserPrompt ? lastUserPrompt.label : "";

  // First-primary-call cache hit rate. Used by the cache-pollution detector
  // in compareRunsCost: a fresh conversation should start near 0% cache hit;
  // any meaningful rate on the first primary call hints at warm provider cache.
  let firstPrimaryCallCacheHit = 0, firstPrimaryCallInputTokens = 0;
  for (const p of ca.prompts) {
    let found = false;
    for (const ev of p.events || []) {
      if (ev.kind && ev.kind !== "llm") continue;
      if (ev.category === "overhead") continue;
      const denom = (ev.cached || 0) + (ev.fresh || 0) + (ev.cacheWrite || 0);
      firstPrimaryCallInputTokens = denom;
      firstPrimaryCallCacheHit = denom > 0 ? (ev.cached || 0) / denom : 0;
      found = true;
      break;
    }
    if (found) break;
  }

  // Effective rates per million tokens. Approximates the model's pricing by
  // splitting totalCost into input vs output along the bucket attribution.
  // Cost is in dollars (per pricing.js / copilotChatExportParser): direct
  // pass-through. Multiply by 1e6 to get per-million.
  const outputCost = bucketCost.output;
  const inputCostApprox = totalCost - outputCost;
  const avgInputRatePerMTok = totalInput > 0 ? (inputCostApprox / totalInput) * 1e6 : 0;
  const avgOutputRatePerMTok = totalOutput > 0 ? (outputCost / totalOutput) * 1e6 : 0;

  return {
    totalCost, totalInput, totalOutput, totalCached, totalFresh, totalCacheWrite,
    cacheHitRate, promptCount: ca.prompts.length, llmCallCount,
    fixedCost, variableCost,
    fixedShare: totalCost > 0 ? fixedCost / totalCost : 0,
    componentTokens: compTok, componentShare: compShare, bucketCost,
    models: Array.from(modelSet),
    primaryModel: mostExpensiveCall ? mostExpensiveCall.model : null,
    finalAnswer, userPromptText, userPrompts,
    firstPrimaryCallCacheHit, firstPrimaryCallInputTokens,
    avgInputRatePerMTok, avgOutputRatePerMTok,
  };
}

function zeroBuckets(): Record<Bucket, number> {
  return { system: 0, tool_defs: 0, history: 0, tool_results: 0, current: 0, output: 0 };
}

function normalizeAnswer(s: string): string {
  return (s || "").trim().toLowerCase().replace(/\s+/g, " ");
}

function buildCallPairs(a: CostAnalysisLike, b: CostAnalysisLike): { pairs: CallPair[]; sameShape: boolean } {
  const evsA: EventLike[] = [];
  const evsB: EventLike[] = [];
  // Only LLM events are pair-able; tool events lack token/cost fields and
  // their ordering is not stable across runs (different MCP setups produce
  // different tool sequences).
  for (const p of a.prompts || []) for (const ev of p.events || []) {
    if (!ev.kind || ev.kind === "llm") evsA.push(ev);
  }
  for (const p of b.prompts || []) for (const ev of p.events || []) {
    if (!ev.kind || ev.kind === "llm") evsB.push(ev);
  }

  const sameShape = evsA.length === evsB.length &&
    evsA.every((ev, i) => ev.name === evsB[i].name);

  const max = Math.max(evsA.length, evsB.length);
  const pairs: CallPair[] = [];
  for (let i = 0; i < max; i++) {
    const ea = evsA[i] || null;
    const eb = evsB[i] || null;
    pairs.push({
      name: ea?.name || eb?.name || `call ${i + 1}`,
      a: ea, b: eb,
      sameModel: !!(ea && eb && ea.model === eb.model),
    });
  }
  return { pairs, sameShape };
}

function buildKpis(a: RunSummary, b: RunSummary): KpiPair[] {
  function pair(key: string, label: string, av: number, bv: number, direction: "lower" | "higher" | "neutral"): KpiPair {
    const delta = bv - av;
    const deltaPct = av !== 0 ? delta / av : null;
    return { key, label, a: av, b: bv, delta, deltaPct, direction };
  }
  const aPerCall = a.llmCallCount > 0 ? a.totalCost / a.llmCallCount : 0;
  const bPerCall = b.llmCallCount > 0 ? b.totalCost / b.llmCallCount : 0;
  const aPerOut = a.totalOutput > 0 ? a.totalCost / a.totalOutput : 0;
  const bPerOut = b.totalOutput > 0 ? b.totalCost / b.totalOutput : 0;
  return [
    pair("total_cost", "Total cost", a.totalCost, b.totalCost, "lower"),
    pair("output_tokens", "Output tokens", a.totalOutput, b.totalOutput, "neutral"),
    pair("cache_hit", "Cache hit rate", a.cacheHitRate, b.cacheHitRate, "higher"),
    pair("fixed_share", "Fixed overhead share", a.fixedShare, b.fixedShare, "neutral"),
    pair("cr_per_call", "Cost per LLM call", aPerCall, bPerCall, "lower"),
    pair("cr_per_out_tok", "Cost per output token", aPerOut, bPerOut, "lower"),
    pair("avg_in_rate", "Input $/1M tok", a.avgInputRatePerMTok, b.avgInputRatePerMTok, "lower"),
    pair("avg_out_rate", "Output $/1M tok", a.avgOutputRatePerMTok, b.avgOutputRatePerMTok, "lower"),
  ];
}

function buildBucketDeltas(a: RunSummary, b: RunSummary): BucketDelta[] {
  const raw = BUCKETS.map((bucket): BucketDelta => {
    const aCost = a.bucketCost[bucket];
    const bCost = b.bucketCost[bucket];
    const delta = bCost - aCost;
    return {
      bucket,
      aCost, bCost, delta,
      deltaPct: aCost !== 0 ? delta / aCost : null,
      shareOfSwing: 0,
    };
  });
  const totalSwing = raw.reduce((s, d) => s + Math.abs(d.delta), 0);
  if (totalSwing > 0) {
    for (const d of raw) d.shareOfSwing = Math.abs(d.delta) / totalSwing;
  }
  // Sort by absolute delta descending so the dominant lines render first.
  return raw.slice().sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta));
}

function detectCachePollution(a: RunSummary, b: RunSummary): CachePollution {
  // Heuristic: a fresh conversation's first primary LLM call should hit
  // ~0% cache (the model provider has not seen this prefix before). When the
  // first primary call shows >40% cache hit AND has a meaningful denominator
  // (>500 input tokens — anything smaller is statistically noisy), it
  // strongly suggests the run inherited a warm provider cache from a recent
  // sibling run in the same workspace.
  const HIT_THRESHOLD = 0.40;
  const TOK_FLOOR = 500;
  const aWarm = a.firstPrimaryCallCacheHit > HIT_THRESHOLD && a.firstPrimaryCallInputTokens > TOK_FLOOR;
  const bWarm = b.firstPrimaryCallCacheHit > HIT_THRESHOLD && b.firstPrimaryCallInputTokens > TOK_FLOOR;
  if (!aWarm && !bWarm) {
    return { suspect: false, side: null, reason: "Both runs started with cold cache (first primary call hit < 40%)." };
  }
  const fmt = (s: RunSummary) => (s.firstPrimaryCallCacheHit * 100).toFixed(0) + "%";
  if (aWarm && bWarm) {
    return {
      suspect: true,
      side: "both",
      reason: "Both runs' first primary calls had high cache hits (A: " + fmt(a) + ", B: " + fmt(b) +
        "). Both look cache-warmed — the absolute cost numbers reflect provider cache state, not what a cold run would cost.",
    };
  }
  if (bWarm) {
    return {
      suspect: true,
      side: "B",
      reason: "B's first primary call hit " + fmt(b) + " of cache (vs " + fmt(a) +
        " for A). B likely inherited cache from a recent run — the savings shown for B may be inflated. Re-run B from a cold cache (new VS Code window or wait several minutes) to confirm.",
    };
  }
  return {
    suspect: true,
    side: "A",
    reason: "A's first primary call hit " + fmt(a) + " of cache (vs " + fmt(b) +
      " for B). A looks cache-warmed — B may appear more expensive than it really is. Re-run A from a cold cache to confirm.",
  };
}

function buildVerdict(a: RunSummary, b: RunSummary, equivalent: boolean): Verdict {
  const deltaPct = a.totalCost > 0 ? (b.totalCost - a.totalCost) / a.totalCost : 0;
  const absPct = Math.abs(deltaPct);

  if (absPct < 0.02) {
    return {
      kind: "noise",
      headline: "Cost is essentially identical (Δ " + formatPctSigned(deltaPct) + ")",
      detail: equivalent
        ? "Both runs produced equivalent answers and cost within 2% of each other. The difference is statistical noise."
        : "Cost is within 2%. The minor delta is statistical noise, but the answers differ — verify that's acceptable before drawing conclusions.",
      tone: "neutral",
    };
  }
  if (deltaPct < 0 && equivalent) {
    return {
      kind: "savings_equivalent",
      headline: "Run B saved " + formatPctSigned(-deltaPct) + " with an equivalent answer",
      detail: "B is cheaper by " + formatPctSigned(-deltaPct) + " and produced the same final response. The change appears to be a real win.",
      tone: "success",
    };
  }
  if (deltaPct < 0 && !equivalent) {
    return {
      kind: "savings_divergent",
      headline: "Run B was " + formatPctSigned(-deltaPct) + " cheaper, but answers differ",
      detail: "B is cheaper, but the final responses are not equivalent. Verify that B's answer is acceptable before concluding the strategy works.",
      tone: "warning",
    };
  }
  return {
    kind: "more_expensive",
    headline: "Run B was " + formatPctSigned(deltaPct) + " more expensive",
    detail: equivalent
      ? "B costs more for the same final answer. Either A's strategy is more efficient, or B used a more expensive model."
      : "B costs more AND produced a different answer. Compare the answers first to decide which result you actually want.",
    tone: deltaPct > 0.20 ? "error" : "warning",
  };
}

function formatPctSigned(p: number): string {
  const sign = p < 0 ? "-" : (p > 0 ? "+" : "");
  return sign + (Math.abs(p) * 100).toFixed(Math.abs(p) < 0.01 ? 2 : 1) + "%";
}

function buildRecommendations(a: RunSummary, b: RunSummary, equivalent: boolean, pollution: CachePollution): Recommendation[] {
  const recs: Recommendation[] = [];
  const deltaPct = a.totalCost > 0 ? (b.totalCost - a.totalCost) / a.totalCost : 0;
  const avgFixedShare = (a.fixedShare + b.fixedShare) / 2;
  const toolDefsShare = (a.componentShare.tool_defs + b.componentShare.tool_defs) / 2;
  const totalUserText = (a.userPromptText.length + b.userPromptText.length) / 2;

  // Cache pollution always leads — it dwarfs every other interpretation when present.
  if (pollution.suspect) {
    recs.push({
      id: "cache_pollution",
      title: "Re-run from a cold cache before trusting these numbers",
      body: pollution.reason,
    });
  }

  if (Math.abs(deltaPct) < 0.05 && avgFixedShare > 0.80) {
    recs.push({
      id: "noise_dominated_by_overhead",
      title: "The cost difference is dominated by fixed overhead",
      body: "On average " + (avgFixedShare * 100).toFixed(0) + "% of each run is fixed overhead (system + tool defs). " +
        "Differences in your prompt text only affect a tiny variable slice. Real savings come from reducing the overhead.",
    });
  }

  if (toolDefsShare > 0.50) {
    recs.push({
      id: "attack_tool_defs",
      title: "Trim tool definitions to cut the biggest line item",
      body: "Tool definitions average " + (toolDefsShare * 100).toFixed(0) + "% of cost. " +
        "Disabling MCP servers or extension tools you don't need would save more than any prompt-side change.",
    });
  }

  // "Cheaper model for trivial answers" heuristic: if average output is small AND
  // most expensive model is a premium one.
  const avgOutput = (a.totalOutput + b.totalOutput) / 2;
  const PREMIUM_HINTS = ["sonnet", "opus", "gpt-5", "gpt-4o-2024", "gpt-4-turbo"];
  const usingPremium = [a.primaryModel, b.primaryModel].some(m =>
    m && PREMIUM_HINTS.some(h => m.toLowerCase().includes(h)));
  if (avgOutput < 50 && usingPremium) {
    recs.push({
      id: "cheaper_model_for_trivial",
      title: "Route trivial questions to a cheaper model",
      body: "The most expensive call ran on a premium model but produced under 50 tokens of output. " +
        "Routing factual one-liners to a smaller model would cut the bulk of this run.",
    });
  }

  if (totalUserText > 0 && totalUserText < 100) {
    recs.push({
      id: "tiny_user_text",
      title: "Try this experiment on a real coding task",
      body: "Your user message is under 100 characters on average — the lowest-possible variable share. " +
        "Re-running on a substantive prompt would let any prompting-style difference show up clearly.",
    });
  }

  if (Math.abs(deltaPct) > 0.10 && equivalent) {
    recs.push({
      id: "real_win",
      title: "This looks like a real, repeatable win",
      body: "Cost differs by " + formatPctSigned(deltaPct) + " with equivalent answers. Worth running again on a different task to confirm the pattern holds.",
    });
  }

  return recs;
}

// ---------- Drift fingerprinting ----------

/** Tool name patterns (case-insensitive substring match) that indicate the
 * call modifies a file. Read-only tools (read_file, grep_search, list_dir)
 * are intentionally excluded so "filesEdited" reflects intent-to-change. */
const EDIT_TOOL_PATTERNS = [
  "edit_file", "create_file", "write_file", "apply_patch",
  "str_replace", "replace_string", "insert_edit", "multi_replace",
  "edit_notebook", "create_directory",
];

function isEditTool(name: string): boolean {
  const lc = (name || "").toLowerCase();
  return EDIT_TOOL_PATTERNS.some((p) => lc.includes(p));
}

/** Extract the first file-path-like value out of a tool call's args. Walks
 * the parsed-JSON object looking for canonical key names. Returns null when
 * the args don't carry a path or aren't valid JSON. */
function extractFilePath(rawArgs: string | undefined, argsSummary: string | undefined): string | null {
  if (rawArgs) {
    try {
      const obj = JSON.parse(rawArgs);
      if (obj && typeof obj === "object") {
        const keys = ["filePath", "file_path", "path", "file", "filepath", "target_file", "uri"];
        for (const k of keys) {
          const v = (obj as Record<string, unknown>)[k];
          if (typeof v === "string" && v.length > 0) return v;
        }
      }
    } catch { /* not JSON, fall through */ }
  }
  // Fallback: try to pull a path-looking token out of the human summary.
  if (argsSummary) {
    const m = argsSummary.match(/[\w.\-]+\/[\w./\-]+/);
    if (m) return m[0];
  }
  return null;
}

/** Stable, dependency-free 32-bit FNV-1a string hash. Returns 8-char hex.
 * Sufficient to flag identity vs divergence; not for any security purpose. */
function hashStr(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

function normalizeForHash(s: string): string {
  return (s || "").trim().replace(/\s+/g, " ");
}

function buildFingerprint(ca: CostAnalysisLike | null | undefined, summary: RunSummary): RunFingerprint {
  const empty: RunFingerprint = {
    models: [], primaryModel: null,
    turnCount: 0, llmCallCount: 0,
    firstUserPrompt: "", firstUserPromptHash: "00000000",
    systemPromptText: "", systemPromptChars: 0, systemPromptHash: "00000000",
    systemPromptHashTrusted: false,
    filesTouched: [], filesEdited: [], toolsInvoked: [],
  };
  if (!ca || !Array.isArray(ca.prompts) || ca.prompts.length === 0) return empty;

  // First user prompt: the label of the first non-overhead prompt, falling
  // back to the currentText of the first primary LLM event. Tests typically
  // start from a single user message so this captures "the prompt".
  let firstUserPrompt = "";
  for (const p of ca.prompts) {
    const llmEvents = (p.events || []).filter((e) => e.kind === "llm" || e.kind === undefined);
    if (llmEvents.length === 0) continue;
    const allOverhead = llmEvents.every((e) => e.category === "overhead");
    if (allOverhead) continue;
    firstUserPrompt = (p.label || "").trim();
    if (!firstUserPrompt) {
      const firstPrimary = llmEvents.find((e) => e.category !== "overhead");
      if (firstPrimary && firstPrimary.currentText) {
        firstUserPrompt = firstPrimary.currentText.trim();
      }
    }
    break;
  }

  // System prompt: prefer the parser-provided full-text hash + char count.
  // Fall back to hashing the 400-char preview only when neither is present
  // (older parsers / non-Copilot-Chat formats).
  let systemPromptText = "";
  let systemPromptChars = 0;
  let systemPromptHash = "00000000";
  let systemPromptHashTrusted = false;
  for (const p of ca.prompts) {
    let found = false;
    for (const ev of p.events || []) {
      if (ev.kind && ev.kind !== "llm") continue;
      if (ev.category === "overhead") continue;
      systemPromptText = (ev.systemPreview || "").trim();
      if (typeof ev.systemHash === "string" && ev.systemHash.length > 0) {
        systemPromptHash = ev.systemHash;
        systemPromptHashTrusted = true;
      } else {
        systemPromptHash = hashStr(normalizeForHash(systemPromptText));
        systemPromptHashTrusted = false;
      }
      systemPromptChars = typeof ev.systemChars === "number" && ev.systemChars >= 0
        ? ev.systemChars
        : systemPromptText.length;
      found = true;
      break;
    }
    if (found) break;
  }

  const filesTouched = new Set<string>();
  const filesEdited = new Set<string>();
  const toolsInvoked = new Set<string>();
  for (const p of ca.prompts) {
    for (const ev of p.events || []) {
      if (ev.kind !== "tool") continue;
      const name = (ev.name || "").trim();
      if (name) toolsInvoked.add(name);
      const path = extractFilePath(ev.rawArgs, ev.argsSummary);
      if (path) {
        filesTouched.add(path);
        if (isEditTool(name)) filesEdited.add(path);
      }
    }
  }

  // turnCount: number of non-overhead prompts (one per user-facing chat turn).
  const turnCount = ca.prompts.filter((p) => {
    const llmEvents = (p.events || []).filter((e) => e.kind === "llm" || e.kind === undefined);
    if (llmEvents.length === 0) return false;
    return !llmEvents.every((e) => e.category === "overhead");
  }).length;

  return {
    models: summary.models.slice().sort(),
    primaryModel: summary.primaryModel,
    turnCount,
    llmCallCount: summary.llmCallCount,
    firstUserPrompt,
    firstUserPromptHash: hashStr(normalizeForHash(firstUserPrompt)),
    systemPromptText,
    systemPromptChars,
    systemPromptHash,
    systemPromptHashTrusted,
    filesTouched: Array.from(filesTouched).sort(),
    filesEdited: Array.from(filesEdited).sort(),
    toolsInvoked: Array.from(toolsInvoked).sort(),
  };
}

function setDiff(a: string[], b: string[]): { aOnly: string[]; bOnly: string[]; overlap: string[] } {
  const sa = new Set(a);
  const sb = new Set(b);
  const aOnly: string[] = [], bOnly: string[] = [], overlap: string[] = [];
  for (const v of a) (sb.has(v) ? overlap : aOnly).push(v);
  for (const v of b) if (!sa.has(v)) bOnly.push(v);
  return { aOnly, bOnly, overlap };
}

function buildDriftReport(fa: RunFingerprint, fb: RunFingerprint): DriftReport {
  const rows: DriftRow[] = [];

  // Models — blocking. If A and B ran on different models, every cost number
  // is misleading.
  const modelMatch = fa.primaryModel === fb.primaryModel;
  rows.push({
    key: "models",
    label: "Primary model",
    status: modelMatch ? "match" : "diff",
    aText: fa.primaryModel || "(none)",
    bText: fb.primaryModel || "(none)",
    blocking: true,
  });

  // First prompt — blocking. If the user typed different prompts, you're not
  // running the same test.
  const promptMatch = fa.firstUserPromptHash === fb.firstUserPromptHash;
  rows.push({
    key: "first_prompt",
    label: "First user prompt",
    status: promptMatch ? "match" : "diff",
    aText: promptMatch ? "identical (hash " + fa.firstUserPromptHash + ")" : truncate(fa.firstUserPrompt, 80),
    bText: promptMatch ? "" : truncate(fb.firstUserPrompt, 80),
    blocking: true,
  });

  // System prompt — non-blocking by default (this IS what techniques like #3
  // change), but we surface byte size and hash so divergence is visible.
  const sysMatch = fa.systemPromptHash === fb.systemPromptHash;
  const sysTrusted = fa.systemPromptHashTrusted && fb.systemPromptHashTrusted;
  const sysHashSuffix = sysTrusted ? "" : " ~preview";
  let sysDetail: string | undefined;
  if (!sysMatch) {
    sysDetail = "System prompt content differs between runs. Expected if you're testing instructions; unexpected otherwise.";
  } else if (!sysTrusted) {
    sysDetail = "Hashes match on the first 400 characters only. The full system text was not available, so identity beyond char 400 is not verified.";
  }
  rows.push({
    key: "system_prompt",
    label: "System prompt",
    status: sysMatch ? (sysTrusted ? "match" : "info") : "diff",
    aText: fa.systemPromptChars + " chars (hash " + fa.systemPromptHash + sysHashSuffix + ")",
    bText: fb.systemPromptChars + " chars (hash " + fb.systemPromptHash + sysHashSuffix + ")",
    detail: sysDetail,
    blocking: false,
  });

  // Turn count — blocking. Different turn counts = different conversations.
  const turnMatch = fa.turnCount === fb.turnCount;
  rows.push({
    key: "turns",
    label: "User turns",
    status: turnMatch ? "match" : "diff",
    aText: String(fa.turnCount),
    bText: String(fb.turnCount),
    blocking: true,
  });

  // LLM call count — informational. Different counts can be a legitimate
  // result (one side took fewer steps) or a sign of divergence.
  const callMatch = fa.llmCallCount === fb.llmCallCount;
  rows.push({
    key: "llm_calls",
    label: "LLM calls",
    status: callMatch ? "match" : "info",
    aText: String(fa.llmCallCount),
    bText: String(fb.llmCallCount),
    detail: callMatch ? undefined : "Different call counts can mean the agent took a different path.",
    blocking: false,
  });

  // Files edited — blocking. If A changed 12 files and B changed 8, the work
  // is not the same.
  const editsDiff = setDiff(fa.filesEdited, fb.filesEdited);
  const editsMatch = editsDiff.aOnly.length === 0 && editsDiff.bOnly.length === 0;
  rows.push({
    key: "files_edited",
    label: "Files edited",
    status: editsMatch ? "match" : "diff",
    aText: fa.filesEdited.length + " files",
    bText: fb.filesEdited.length + " files",
    detail: editsMatch
      ? undefined
      : formatSetDiff("edited", editsDiff),
    blocking: true,
  });

  // Files touched (read+write). Informational. Useful for spotting "B happened
  // to read the README, A didn't" without flagging it as a hard failure.
  const touchedDiff = setDiff(fa.filesTouched, fb.filesTouched);
  const touchedMatch = touchedDiff.aOnly.length === 0 && touchedDiff.bOnly.length === 0;
  rows.push({
    key: "files_touched",
    label: "Files referenced",
    status: touchedMatch ? "match" : "info",
    aText: fa.filesTouched.length + " files",
    bText: fb.filesTouched.length + " files",
    detail: touchedMatch ? undefined : formatSetDiff("referenced", touchedDiff),
    blocking: false,
  });

  // Tools invoked — blocking. If only one side called an MCP tool, the
  // comparison is contaminated for the MCP-audit experiment.
  const toolsDiff = setDiff(fa.toolsInvoked, fb.toolsInvoked);
  const toolsMatch = toolsDiff.aOnly.length === 0 && toolsDiff.bOnly.length === 0;
  rows.push({
    key: "tools_invoked",
    label: "Tools invoked",
    status: toolsMatch ? "match" : "diff",
    aText: fa.toolsInvoked.length + " distinct",
    bText: fb.toolsInvoked.length + " distinct",
    detail: toolsMatch ? undefined : formatSetDiff("invoked", toolsDiff),
    blocking: true,
  });

  const hasAnyDrift = rows.some((r) => r.status === "diff");
  const hasBlockingDrift = rows.some((r) => r.status === "diff" && r.blocking);
  return { rows, hasBlockingDrift, hasAnyDrift };
}

function truncate(s: string, n: number): string {
  if (!s) return "(empty)";
  return s.length <= n ? s : s.slice(0, n) + "…";
}

function formatSetDiff(verb: string, d: { aOnly: string[]; bOnly: string[] }): string {
  const parts: string[] = [];
  if (d.aOnly.length) parts.push("A only " + verb + ": " + d.aOnly.slice(0, 5).join(", ") + (d.aOnly.length > 5 ? " (+" + (d.aOnly.length - 5) + ")" : ""));
  if (d.bOnly.length) parts.push("B only " + verb + ": " + d.bOnly.slice(0, 5).join(", ") + (d.bOnly.length > 5 ? " (+" + (d.bOnly.length - 5) + ")" : ""));
  return parts.join(" · ");
}

// ---------- Main ----------

export function compareRunsCost(
  costA: CostAnalysisLike | null | undefined,
  costB: CostAnalysisLike | null | undefined,
): CostComparison | null {
  if (!costA || !costB) return null;
  const a = summarizeRun(costA);
  const b = summarizeRun(costB);
  const { pairs, sameShape } = buildCallPairs(costA, costB);
  const equivalent = a.finalAnswer.length > 0 && b.finalAnswer.length > 0 &&
    normalizeAnswer(a.finalAnswer) === normalizeAnswer(b.finalAnswer);
  const cachePollution = detectCachePollution(a, b);
  const fingerprintA = buildFingerprint(costA, a);
  const fingerprintB = buildFingerprint(costB, b);
  const drift = buildDriftReport(fingerprintA, fingerprintB);
  return {
    a, b,
    kpis: buildKpis(a, b),
    callPairs: pairs,
    answersEquivalent: equivalent,
    finalAnswerA: a.finalAnswer,
    finalAnswerB: b.finalAnswer,
    userTextA: a.userPromptText,
    userTextB: b.userPromptText,
    userPromptsA: a.userPrompts,
    userPromptsB: b.userPrompts,
    sameShape,
    verdict: buildVerdict(a, b, equivalent),
    recommendations: buildRecommendations(a, b, equivalent, cachePollution),
    bucketDeltas: buildBucketDeltas(a, b),
    cachePollution,
    fingerprintA,
    fingerprintB,
    drift,
  };
}
