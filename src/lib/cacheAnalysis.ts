/**
 * Cache analysis for VS Code Copilot Chat exports.
 *
 * Computes per-call deltas with per-model baselines, recommit detection,
 * model-switch detection, and unexpected-cache-miss diagnosis (tool-defs diff).
 *
 * All functions are pure. No LLM calls. Cache scope is per-model (an Anthropic
 * cache prefix is invisible to OpenAI and vice versa, so baselines reset).
 */

export interface ToolDef {
  name: string;
  // The tool def is sent verbatim to the API; any byte change invalidates the
  // cached prefix. We keep the raw object so we can hash and diff.
  [key: string]: unknown;
}

export interface RawCallUsage {
  prompt_tokens: number;
  completion_tokens: number;
  cached_tokens: number;
  cache_write: number;
}

export interface CallInput {
  /** Stable per-call identifier (e.g. log id). */
  id: string;
  /** Model name, e.g. "claude-sonnet-4.6" or "gpt-4o-mini-2024-07-18". */
  model: string;
  usage: RawCallUsage;
  tools: ToolDef[];
  /** Component breakdown in tokens (may be approximate, scaled to prompt_tokens). */
  components: ComponentBreakdown;
  /** Raw character counts per bucket. Stable across calls (independent of
   * the per-call scale factor used to derive `components`), so diffing these
   * gives an accurate "what content actually changed" signal for the
   * per-bucket new-attribution. Optional for backward compatibility. */
  componentChars?: ComponentBreakdown;
}

export interface ComponentBreakdown {
  system: number;
  tool_defs: number;
  history: number;
  tool_results: number;
  current: number;
}

export interface CacheMissDiag {
  /** Number of tool definitions that differ vs the previous same-model call. */
  toolDefsChanged: number;
  toolDefsTotal: number;
  changedSample: string[];
  added: string[];
  removed: string[];
  /** True when no structural difference was found, suggesting TTL expiry. */
  likelyTtlExpiry: boolean;
}

export interface CallAnalysis {
  id: string;
  model: string;
  modelSwitched: boolean;
  /** prompt_tokens of the previous call ON THE SAME MODEL (0 if first). */
  prevPt: number;
  /**
   * prompt_tokens minus prevPt (clamped >= -inf). Negative deltas can occur
   * when context is trimmed; we surface them as-is so users see the trim.
   */
  deltaVsPrev: number;
  /** fresh + cache_write -- what the API treats as "new" billing this call. */
  newTotal: number;
  /** Of newTotal, how much is genuinely new vs cache-recommit overhead. */
  trulyNew: number;
  /** cache_write tokens that re-wrote already-known content (TTL expiry etc). */
  recommit: number;
  /**
   * True when cached_tokens=0 but a prior call on the same model had non-trivial
   * pt. Comes with a diag explaining what changed.
   */
  unexpectedMiss: boolean;
  cacheMissDiag: CacheMissDiag | null;
  /** newTotal split across the 5 input buckets, scaled per-model deltas. */
  newPerBucket: ComponentBreakdown;
}

export interface PromptAnalysis {
  /** True when this prompt's first call switched models from the prev prompt. */
  modelSwitchedIn: boolean;
  contextInitial: number;
  contextFinal: number;
  contextGrowth: number;
  cacheRecommit: number;
  /** Sum across the prompt's calls of newTotal split per bucket. */
  newPerBucket: ComponentBreakdown;
  newTotal: number;
  /** Number of unexpected cache misses across this prompt's calls. */
  unexpectedMissCount: number;
  /** Sum of pt across calls that suffered an unexpected miss. */
  unexpectedMissTokens: number;
  /** Cost of unexpected-miss calls. */
  unexpectedMissCost: number;
}

const INPUT_KEYS: (keyof ComponentBreakdown)[] = [
  "system", "tool_defs", "history", "tool_results", "current",
];

const MIN_PRIOR_PT_FOR_MISS_DIAG = 1000;

export function emptyComponents(): ComponentBreakdown {
  return { system: 0, tool_defs: 0, history: 0, tool_results: 0, current: 0 };
}

/**
 * Compute the truly-new and recommit split for a single call.
 * On a model switch, the prior cache is invisible: every billed token is new.
 */
export function computeCallNewSplit(
  newTotal: number,
  deltaVsPrev: number,
  modelSwitched: boolean,
): { trulyNew: number; recommit: number } {
  if (modelSwitched) return { trulyNew: newTotal, recommit: 0 };
  const trulyNew = Math.max(0, deltaVsPrev);
  const recommit = Math.max(0, newTotal - trulyNew);
  return { trulyNew, recommit };
}

/**
 * Diff two tool arrays. Returns a structured summary for the cache-miss panel.
 */
export function diffTools(prev: ToolDef[], curr: ToolDef[]): CacheMissDiag {
  const stringify = (t: ToolDef) => JSON.stringify(sortKeys(t));
  const prevMap = new Map<string, string>();
  const currMap = new Map<string, string>();
  for (const t of prev) prevMap.set(t.name, stringify(t));
  for (const t of curr) currMap.set(t.name, stringify(t));
  const changed: string[] = [];
  for (const [name, json] of prevMap) {
    const cur = currMap.get(name);
    if (cur !== undefined && cur !== json) changed.push(name);
  }
  const added: string[] = [];
  for (const name of currMap.keys()) if (!prevMap.has(name)) added.push(name);
  const removed: string[] = [];
  for (const name of prevMap.keys()) if (!currMap.has(name)) removed.push(name);
  changed.sort();
  added.sort();
  removed.sort();
  return {
    toolDefsChanged: changed.length,
    toolDefsTotal: curr.length,
    changedSample: changed.slice(0, 5),
    added: added.slice(0, 5),
    removed: removed.slice(0, 5),
    likelyTtlExpiry: changed.length === 0 && added.length === 0 && removed.length === 0,
  };
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[k] = sortKeys((value as Record<string, unknown>)[k]);
    }
    return sorted;
  }
  return value;
}

/**
 * Walk a session's calls (and their grouping into prompts) and produce per-call
 * and per-prompt analysis. Caller provides a list of (prompt, calls[]) tuples.
 *
 * Returns a parallel structure: for each prompt, the prompt analysis plus
 * a per-call analysis aligned with the input call order.
 */
export function analyzeSessionCalls(
  prompts: { calls: CallInput[]; cacheWriteSum: number }[],
): { prompt: PromptAnalysis; calls: CallAnalysis[] }[] {
  const prevComponentsByModel = new Map<string, ComponentBreakdown>();
  const prevCharsByModel = new Map<string, ComponentBreakdown>();
  const prevPtByModel = new Map<string, number>();
  const prevToolsByModel = new Map<string, ToolDef[]>();
  let prevModelGlobal: string | null = null;
  let prevPtGlobal = 0;

  const out: { prompt: PromptAnalysis; calls: CallAnalysis[] }[] = [];
  for (const p of prompts) {
    const firstModel = p.calls[0]?.model ?? null;
    const modelSwitchedIn = !!(firstModel && prevModelGlobal && firstModel !== prevModelGlobal);
    const contextInitial = modelSwitchedIn ? 0 : prevPtGlobal;
    if (modelSwitchedIn) prevPtGlobal = 0;
    let contextFinal = contextInitial;
    const promptNew = emptyComponents();
    let promptNewTotal = 0;
    let unexpectedMissCount = 0;
    let unexpectedMissTokens = 0;

    const calls: CallAnalysis[] = [];
    for (const call of p.calls) {
      const u = call.usage;
      const fresh = Math.max(0, u.prompt_tokens - u.cached_tokens - u.cache_write);
      const newTotal = fresh + u.cache_write;
      const modelSwitched = !!(prevModelGlobal && call.model !== prevModelGlobal);
      const prevPt = modelSwitched ? 0 : (prevPtByModel.get(call.model) ?? 0);
      const deltaVsPrev = modelSwitched ? u.prompt_tokens : (u.prompt_tokens - prevPt);
      const split = computeCallNewSplit(newTotal, deltaVsPrev, modelSwitched);

      // Unexpected cache miss: cached==0 but prior pt>threshold on same model
      let unexpectedMiss = false;
      let cacheMissDiag: CacheMissDiag | null = null;
      const priorSameModelPt = prevPtByModel.get(call.model) ?? 0;
      if (
        u.cached_tokens === 0 &&
        priorSameModelPt > MIN_PRIOR_PT_FOR_MISS_DIAG &&
        !modelSwitched
      ) {
        unexpectedMiss = true;
        const priorTools = prevToolsByModel.get(call.model) ?? [];
        cacheMissDiag = diffTools(priorTools, call.tools);
        unexpectedMissCount += 1;
        unexpectedMissTokens += u.prompt_tokens;
      }

      // Per-bucket new attribution: diff this call's content against the
      // previous same-model call's content, then scale to actual newTotal.
      // We prefer raw character counts (`componentChars`) because they're
      // stable across calls -- the scaled token `components` jitter as the
      // per-call rescaling factor changes, which made unchanged buckets like
      // `system` falsely appear to "grow" and get billed-as-new.
      const prevComps = prevComponentsByModel.get(call.model);
      const prevChars = prevCharsByModel.get(call.model);
      const useChars = !!(call.componentChars && prevChars);
      const estNew: ComponentBreakdown = emptyComponents();
      for (const k of INPUT_KEYS) {
        if (useChars) {
          const cur = call.componentChars![k] ?? 0;
          const prev = prevChars![k] ?? 0;
          estNew[k] = Math.max(0, cur - prev);
        } else {
          const cur = call.components[k] ?? 0;
          const prev = prevComps ? (prevComps[k] ?? 0) : 0;
          estNew[k] = prevComps ? Math.max(0, cur - prev) : cur;
        }
      }
      const estTotal = INPUT_KEYS.reduce((a, k) => a + estNew[k], 0) || 1;
      const scaled: ComponentBreakdown = emptyComponents();
      for (const k of INPUT_KEYS) {
        scaled[k] = Math.round(estNew[k] * newTotal / estTotal);
      }
      // Fix rounding drift onto the largest bucket
      const drift = newTotal - INPUT_KEYS.reduce((a, k) => a + scaled[k], 0);
      if (drift !== 0) {
        let kmax: keyof ComponentBreakdown = "tool_defs";
        for (const k of INPUT_KEYS) if (scaled[k] > scaled[kmax]) kmax = k;
        scaled[kmax] = Math.max(0, scaled[kmax] + drift);
      }
      for (const k of INPUT_KEYS) promptNew[k] += scaled[k];
      promptNewTotal += newTotal;

      calls.push({
        id: call.id,
        model: call.model,
        modelSwitched,
        prevPt,
        deltaVsPrev,
        newTotal,
        trulyNew: split.trulyNew,
        recommit: split.recommit,
        unexpectedMiss,
        cacheMissDiag,
        newPerBucket: scaled,
      });

      // advance baselines
      prevComponentsByModel.set(call.model, { ...call.components });
      if (call.componentChars) prevCharsByModel.set(call.model, { ...call.componentChars });
      prevPtByModel.set(call.model, u.prompt_tokens);
      prevToolsByModel.set(call.model, call.tools);
      prevModelGlobal = call.model;
      prevPtGlobal = u.prompt_tokens;
      contextFinal = u.prompt_tokens;
    }

    const contextGrowth = contextFinal - contextInitial;
    const cacheRecommit = modelSwitchedIn
      ? 0
      : Math.max(0, p.cacheWriteSum - contextGrowth);

    out.push({
      prompt: {
        modelSwitchedIn,
        contextInitial,
        contextFinal,
        contextGrowth,
        cacheRecommit,
        newPerBucket: promptNew,
        newTotal: promptNewTotal,
        unexpectedMissCount,
        unexpectedMissTokens,
        unexpectedMissCost: 0, // filled in by caller using pricing
      },
      calls,
    });
  }
  return out;
}
