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
  models: string[];                          // distinct models used
  primaryModel: string | null;               // model of most expensive call
  finalAnswer: string;                       // final assistant response across the whole run
  userPromptText: string;                    // last user prompt text (best-effort)
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
  /** Same number of LLM calls AND same call-name sequence. */
  sameShape: boolean;
  /** Headline verdict and tone. */
  verdict: Verdict;
  /** Rule-driven, deterministic recommendations relevant to THIS pair. */
  recommendations: Recommendation[];
}

// ---------- Helpers ----------

function summarizeRun(ca: CostAnalysisLike | null | undefined): RunSummary {
  const empty: RunSummary = {
    totalCost: 0, totalInput: 0, totalOutput: 0, totalCached: 0, totalFresh: 0, totalCacheWrite: 0,
    cacheHitRate: 0, promptCount: 0, llmCallCount: 0,
    fixedCost: 0, variableCost: 0, fixedShare: 0,
    componentTokens: zeroBuckets(), componentShare: zeroBuckets(),
    models: [], primaryModel: null,
    finalAnswer: "", userPromptText: "",
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
  let fixedCost = 0, variableCost = 0;
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

  // Final answer = response preview of the LAST event of the LAST prompt
  const lastPrompt = ca.prompts[ca.prompts.length - 1];
  const lastEv = lastPrompt && lastPrompt.events && lastPrompt.events.length
    ? lastPrompt.events[lastPrompt.events.length - 1]
    : null;
  const finalAnswer = (lastEv && lastEv.responsePreview) || "";

  // Best-effort user prompt text: search the last prompt's events' currentText
  // for "User message:\n" marker, falling back to last 200 chars of currentText.
  let userPromptText = "";
  if (lastPrompt && lastPrompt.events) {
    for (let i = lastPrompt.events.length - 1; i >= 0; i--) {
      const ct = lastPrompt.events[i].currentText || "";
      const marker = "User message:\n";
      const idx = ct.lastIndexOf(marker);
      if (idx >= 0) {
        userPromptText = ct.slice(idx + marker.length).trim();
        break;
      }
    }
  }

  return {
    totalCost, totalInput, totalOutput, totalCached, totalFresh, totalCacheWrite,
    cacheHitRate, promptCount: ca.prompts.length, llmCallCount,
    fixedCost, variableCost,
    fixedShare: totalCost > 0 ? fixedCost / totalCost : 0,
    componentTokens: compTok, componentShare: compShare,
    models: Array.from(modelSet),
    primaryModel: mostExpensiveCall ? mostExpensiveCall.model : null,
    finalAnswer, userPromptText,
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
  for (const p of a.prompts || []) for (const ev of p.events || []) evsA.push(ev);
  for (const p of b.prompts || []) for (const ev of p.events || []) evsB.push(ev);

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
  ];
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

function buildRecommendations(a: RunSummary, b: RunSummary, equivalent: boolean): Recommendation[] {
  const recs: Recommendation[] = [];
  const deltaPct = a.totalCost > 0 ? (b.totalCost - a.totalCost) / a.totalCost : 0;
  const avgFixedShare = (a.fixedShare + b.fixedShare) / 2;
  const toolDefsShare = (a.componentShare.tool_defs + b.componentShare.tool_defs) / 2;
  const totalUserText = (a.userPromptText.length + b.userPromptText.length) / 2;

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
  return {
    a, b,
    kpis: buildKpis(a, b),
    callPairs: pairs,
    answersEquivalent: equivalent,
    finalAnswerA: a.finalAnswer,
    finalAnswerB: b.finalAnswer,
    userTextA: a.userPromptText,
    userTextB: b.userPromptText,
    sameShape,
    verdict: buildVerdict(a, b, equivalent),
    recommendations: buildRecommendations(a, b, equivalent),
  };
}
