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

// -----------------------------------------------------------------------------
// Experiment intent inference (§3 of the developer-facing spec).
//
// Given the drift signals + run names, guess what the user was probably
// A/B testing. The analyst LLM uses this to anchor "what should have
// changed" against "what actually changed". We are deliberately weak and
// label confidence so the LLM doesn't over-trust the guess.
// -----------------------------------------------------------------------------

type InferredVariable =
  | "model"
  | "system_prompt"
  | "tool_config"
  | "prompt_strategy"
  | "none_detected"
  | "unknown";

interface ExperimentIntent {
  variable: InferredVariable;
  confidence: "high" | "medium" | "low";
  basis: string[];
  sharedScenarioLabel: string | null;
  differentialLabelA: string | null;
  differentialLabelB: string | null;
}

/** Strip common file extensions and the trailing-number iteration suffix
 *  (e.g. "_v2", "2", "-3") so we can compare the "stem" of run names. */
function stripIterSuffix(s: string): { stem: string; suffix: string } {
  let stem = s.replace(/\.(?:json|md|log)$/i, "");
  const m = stem.match(/^(.*?)(?:[_-]?v?\d+)?$/);
  if (m && m[1] && m[1].length >= 3 && m[1].length < stem.length) {
    return { stem: m[1], suffix: stem.slice(m[1].length) };
  }
  return { stem, suffix: "" };
}

/** Longest common prefix between two strings (case-insensitive). */
function longestCommonPrefix(a: string, b: string): string {
  const la = a.toLowerCase(); const lb = b.toLowerCase();
  let i = 0;
  while (i < la.length && i < lb.length && la[i] === lb[i]) i++;
  return a.slice(0, i);
}

function inferExperimentIntent(cmp: CostComparison, nameA: string, nameB: string): ExperimentIntent {
  const basis: string[] = [];
  const fa = cmp.fingerprintA;
  const fb = cmp.fingerprintB;

  // Name parsing: shared prefix + differential suffix.
  // Handle the common "iteration" case where one name is a strict prefix of
  // the other (e.g. "ExpRun_agentupdate" vs "ExpRun_agentupdate2"). The naive
  // LCP would leave diffA empty; instead, back off to the longer shared stem
  // by stripping a trailing iteration suffix (digits or v\d+) from the
  // longer name before computing the shared scenario label.
  let prefix = longestCommonPrefix(nameA, nameB).replace(/[_\-\s.]+$/, "");
  if (prefix.length === nameA.length || prefix.length === nameB.length) {
    const longer = nameA.length >= nameB.length ? nameA : nameB;
    const shorter = nameA.length < nameB.length ? nameA : nameB;
    const m = longer.slice(shorter.length).match(/^([_\-\s.]*v?\d+)/);
    if (m) {
      // Shared scenario = shorter (minus any trailing separator), iteration
      // marker is the digits/v\d+ on the longer side, base is "(base)".
      prefix = shorter.replace(/[_\-\s.]+$/, "");
    }
  }
  let diffA: string | null = nameA.length > prefix.length
    ? nameA.slice(prefix.length).replace(/^[_\-\s.]+/, "")
    : null;
  let diffB: string | null = nameB.length > prefix.length
    ? nameB.slice(prefix.length).replace(/^[_\-\s.]+/, "")
    : null;
  // If one side ended up empty (strict-prefix iteration case), surface it
  // as "(base)" so the export still records the comparison.
  if (diffA === null && diffB) diffA = "(base)";
  if (diffB === null && diffA) diffB = "(base)";
  const sharedScenarioLabel = prefix.length >= 3 ? prefix : null;

  // Precedence-ordered detection.
  let variable: InferredVariable = "unknown";
  let confidence: "high" | "medium" | "low" = "low";

  const modelsDiffer = fa.primaryModel !== fb.primaryModel && !!fa.primaryModel && !!fb.primaryModel;
  const sysCharDelta = Math.abs((fa.systemPromptChars || 0) - (fb.systemPromptChars || 0));
  const sysHashDiffer = !!fa.systemPromptHash && !!fb.systemPromptHash && fa.systemPromptHash !== fb.systemPromptHash;
  const promptDiffer = (fa.firstUserPromptHash || "") !== (fb.firstUserPromptHash || "") && !!fa.firstUserPromptHash && !!fb.firstUserPromptHash;
  const toolSetDelta = Math.abs(fa.toolsInvoked.length - fb.toolsInvoked.length);
  const toolSetSame = fa.toolsInvoked.length === fb.toolsInvoked.length &&
    fa.toolsInvoked.every((t, i) => t === fb.toolsInvoked[i]);

  if (modelsDiffer) {
    variable = "model";
    confidence = "high";
    basis.push(`primary_model differs: A=${fa.primaryModel}, B=${fb.primaryModel}`);
  } else if (sysHashDiffer && sysCharDelta >= 20) {
    variable = "system_prompt";
    confidence = sysCharDelta >= 200 ? "high" : "medium";
    basis.push(`system_prompt hashes differ (char delta ${sysCharDelta})`);
    if (!toolSetSame) basis.push("invoked tool sets also differ — could be a side-effect of the prompt change");
  } else if (!toolSetSame && toolSetDelta >= 2) {
    variable = "tool_config";
    confidence = "low";
    basis.push(`invoked-tool sets differ by ${toolSetDelta} (note: tools INVOKED is a behavioral signal, not a config signal — tools AVAILABLE may have been identical)`);
  } else if (promptDiffer) {
    variable = "prompt_strategy";
    confidence = "medium";
    basis.push("first user prompts differ between runs");
  } else if (
    !modelsDiffer && !sysHashDiffer && !promptDiffer && toolSetSame &&
    Math.abs(cmp.b.totalCost - cmp.a.totalCost) / Math.max(cmp.a.totalCost, 1e-9) < 0.02
  ) {
    variable = "none_detected";
    confidence = "high";
    basis.push("no drift detected on model, system prompt, prompt, or invoked tools; cost within 2%");
  } else {
    basis.push("no single variable dominates the observable drift");
  }

  // Boost confidence when the run-name suffix (e.g. "_agentupdate" vs
  // "_agentupdate2") looks like a deliberate iteration on the inferred axis.
  if (variable !== "unknown" && variable !== "none_detected" && diffA && diffB) {
    const stemA = stripIterSuffix(diffA).stem;
    const stemB = stripIterSuffix(diffB).stem;
    if (stemA === stemB && stemA.length >= 3) {
      basis.push(`run-name suffixes look like iterations on the same axis ("${diffA}" vs "${diffB}")`);
      if (confidence === "low") confidence = "medium";
    }
  }

  return {
    variable,
    confidence,
    basis,
    sharedScenarioLabel,
    differentialLabelA: diffA,
    differentialLabelB: diffB,
  };
}

interface TheoryEntry {
  costMechanism: string;
  qualityMechanism: string;
  whatToCheckFirst: string;
}

const THEORY_MAP: Record<InferredVariable, TheoryEntry> = {
  model: {
    costMechanism: "Different rate cards. Per-token input AND output prices change; cache discount ratios may also change. Cost delta scales with the volume of tokens at each rate, not the number of calls.",
    qualityMechanism: "Capability, reasoning style, tool-use behavior, and latency may all shift. Cheaper models often need more turns; stronger models often produce more concise answers.",
    whatToCheckFirst: "Look at $/input-token and $/output-token deltas, not just total cost. A 'cheaper' model that took 50% more turns may have cost more overall.",
  },
  system_prompt: {
    costMechanism: "Fixed per-call input overhead. Every LLM call carries the system prompt, so cost delta ≈ (system_prompt_token_delta × LLM_call_count × input_rate). If call shape is identical, the delta is almost purely this fixed tax.",
    qualityMechanism: "Better instructions may reduce wrong turns, tool calls, or clarifications. Over-specified instructions may add noise without improving outcomes. Compare call shape + final-response quality.",
    whatToCheckFirst: "Did the bigger prompt actually change behavior (fewer LLM calls, fewer tool calls, better answer), or did it just pay more for the same call shape?",
  },
  tool_config: {
    costMechanism: "Tool registration overhead is paid every call (tool_defs bucket). Tools INVOKED is a downstream behavior signal — the model may have had the same tools available but chose different ones. Without 'tools available' data, attribution is weak.",
    qualityMechanism: "More tools = more capability but also more decision overhead and prompt bloat. Fewer tools may force workarounds.",
    whatToCheckFirst: "Look at the tool_defs bucket delta and the distinct-tools count. Note that available != invoked.",
  },
  prompt_strategy: {
    costMechanism: "Changes the 'current' bucket (user message) and may amplify through history/tool_results if the new phrasing triggers different agent paths.",
    qualityMechanism: "Better-framed prompts often reduce clarification turns and produce more directly usable output. Compare first-call output vs total work done.",
    whatToCheckFirst: "Did rephrasing change the call shape (fewer turns, fewer tool calls) or just the wording of the final answer?",
  },
  none_detected: {
    costMechanism: "No structural change detected. Any cost delta within ±2% is statistical noise (token-counter quantization, cache state, model side variance).",
    qualityMechanism: "Without a tested variable, treat the runs as a noise floor measurement — useful to know your A/B baseline variance.",
    whatToCheckFirst: "Confirm with the user what they actually intended to change. The runs look effectively identical from the export's perspective.",
  },
  unknown: {
    costMechanism: "Multiple drift axes — cannot isolate a single cost mechanism without user input on the intended variable.",
    qualityMechanism: "Mixed drift makes quality attribution unsafe. Any verdict will mix multiple effects.",
    whatToCheckFirst: "Ask the user what they intended to test, then re-run with all other axes held constant.",
  },
};

// -----------------------------------------------------------------------------
// Developer levers affected (§16 of the spec).
//
// Translates the drift signals into the optimization levers the developer
// can actually pull. Each lever is "implicated" when the underlying drift
// signal fired — meaning this run pair provides evidence about that lever.
// -----------------------------------------------------------------------------

interface LeverRow {
  lever: string;
  implicated: boolean;
  evidence: string;
  implication: string;
}

function buildDeveloperLevers(cmp: CostComparison, intent: ExperimentIntent): LeverRow[] {
  const fa = cmp.fingerprintA;
  const fb = cmp.fingerprintB;
  const modelsDiffer = fa.primaryModel !== fb.primaryModel && !!fa.primaryModel && !!fb.primaryModel;
  const sysHashDiffer = !!fa.systemPromptHash && !!fb.systemPromptHash && fa.systemPromptHash !== fb.systemPromptHash;
  const promptDiffer = (fa.firstUserPromptHash || "") !== (fb.firstUserPromptHash || "");
  const toolSetSame = fa.toolsInvoked.length === fb.toolsInvoked.length &&
    fa.toolsInvoked.every((t, i) => t === fb.toolsInvoked[i]);
  const callShapeDiffer = !cmp.sameShape;
  const filesEditedSame = fa.filesEdited.length === fb.filesEdited.length &&
    fa.filesEdited.every((f, i) => f === fb.filesEdited[i]);

  const rows: LeverRow[] = [
    {
      lever: "Custom instructions / system prompt",
      implicated: sysHashDiffer,
      evidence: sysHashDiffer
        ? `System-prompt hashes differ (chars A=${fa.systemPromptChars}, B=${fb.systemPromptChars})`
        : "System-prompt hashes match",
      implication: sysHashDiffer
        ? "Fixed per-call overhead changed. Cost delta scales with LLM call count."
        : "This run pair does not support conclusions about instructions.",
    },
    {
      lever: "Model choice",
      implicated: modelsDiffer,
      evidence: modelsDiffer
        ? `Different primary model: A=${fa.primaryModel}, B=${fb.primaryModel}`
        : `Same primary model on both sides (${fa.primaryModel || "n/a"})`,
      implication: modelsDiffer
        ? "Rate-card and capability change. Compare $/token at input AND output, not just totals."
        : "This run pair does not support conclusions about model selection.",
    },
    {
      lever: "Tool availability vs tool usage",
      implicated: !toolSetSame,
      evidence: toolSetSame
        ? `Same ${fa.toolsInvoked.length} distinct tools invoked on both sides`
        : `Distinct invoked tools differ (A=${fa.toolsInvoked.length}, B=${fb.toolsInvoked.length})`,
      implication: toolSetSame
        ? "This run pair does not support conclusions about IDE tool configuration."
        : "Tools INVOKED differ — but available tools may have been identical. Treat as behavioral, not config.",
    },
    {
      lever: "Prompt strategy",
      implicated: promptDiffer,
      evidence: promptDiffer
        ? "First user prompts differ between runs"
        : "Same first user prompt on both sides",
      implication: promptDiffer
        ? "The runs were not asked the same question — any verdict mixes prompt and config effects."
        : "Both runs received the same prompt — fair config-only comparison on this axis.",
    },
    {
      lever: "Workflow shape (LLM/tool call count)",
      implicated: callShapeDiffer,
      evidence: callShapeDiffer
        ? "Call shape differs (different LLM or tool call counts)"
        : "Same call shape on both sides",
      implication: callShapeDiffer
        ? "Configuration change altered how much work the agent did — the variable affected behavior, not just overhead."
        : "Configuration change was pure overhead — same work, different cost.",
    },
    {
      lever: "Artifact / output format",
      implicated: !filesEditedSame,
      evidence: filesEditedSame
        ? `Same ${fa.filesEdited.length} files edited on both sides`
        : `Different files edited (A=${fa.filesEdited.length}, B=${fb.filesEdited.length})`,
      implication: filesEditedSame
        ? "Both runs targeted the same artifacts — quality is judgeable by content."
        : "Runs touched different files — artifact-quality comparison is bounded.",
    },
  ];
  // Always pull the inferred variable to the top by re-sorting implicated-first
  return rows.sort((a, b) => {
    if (a.implicated !== b.implicated) return a.implicated ? -1 : 1;
    // Stable: keep insertion order otherwise
    return 0;
  });
}

function fmtSet(items: string[]): string {
  if (items.length === 0) return "(none)";
  // Cap at 6 items for table readability
  if (items.length <= 6) return "{" + items.join(", ") + "}";
  return "{" + items.slice(0, 6).join(", ") + ", …+" + (items.length - 6) + "}";
}

function intersect(a: string[], b: string[]): string[] {
  const sb = new Set(b);
  return a.filter((x) => sb.has(x));
}

interface FinalResponseSignals {
  chars: number;
  lines: number;
  numbers: string[];   // distinct numeric tokens (deduped, preserved as strings)
  paths: string[];     // distinct file-path-looking tokens
  tables: number;      // count of markdown table blocks
  bullets: number;     // count of bullet/list lines
  codeBlocks: number;  // count of ``` fences (full blocks)
  headings: number;    // count of markdown # heading lines
}

function extractFinalResponseSignals(text: string | null | undefined): FinalResponseSignals {
  const s = text || "";
  const lines = s.split("\n");
  // Numbers: integers and decimals, ignoring trivial 0/1 if they're noise.
  // Keep all numbers; let the analyst decide which matter.
  const numMatches = s.match(/-?\b\d+(?:\.\d+)?\b/g) || [];
  const numbers = Array.from(new Set(numMatches));
  // File paths: a slash-containing token with at least one path segment.
  // Matches absolute paths (/foo/bar), relative (foo/bar.ext), and
  // backtick-wrapped paths. Strips surrounding backticks/quotes.
  const pathMatches = s.match(/(?:`[^`\s]+`|\b[A-Za-z0-9_.\-]+\/[A-Za-z0-9_./\-]+|\/[A-Za-z0-9_./\-]+)/g) || [];
  const paths = Array.from(new Set(
    pathMatches
      .map((p) => p.replace(/^[`'"]|[`'".,;:)]$/g, "").trim())
      .filter((p) => p.includes("/") && p.length >= 3 && p.length <= 200)
  )).sort();
  // Format counts
  const tableLines = lines.filter((l) => /^\s*\|.*\|\s*$/.test(l)).length;
  // A markdown table requires header + separator + at least one body row,
  // so count blocks by collapsing consecutive table lines. Simpler proxy:
  // ceil(tableLines / 3) capped sensibly.
  const tables = tableLines >= 2 ? Math.max(1, Math.floor(tableLines / 3)) : 0;
  const bullets = lines.filter((l) => /^\s*[-*+]\s+\S/.test(l)).length;
  const codeFences = (s.match(/```/g) || []).length;
  const codeBlocks = Math.floor(codeFences / 2);
  const headings = lines.filter((l) => /^#{1,6}\s+\S/.test(l)).length;
  return {
    chars: s.length,
    lines: lines.length,
    numbers,
    paths,
    tables,
    bullets,
    codeBlocks,
    headings,
  };
}

interface ArtifactDiffRow {
  path: string;
  hashA: string;
  hashB: string;
  /** "identical" | "differ" | "A-only" | "B-only" | "unknown" (no content extractable) */
  status: string;
  /** Combined kind label, e.g. "full-write" / "partial-replace" / "patch" / "mixed".
   *  Tells the analyst whether "identical" means end-state-bytes-match or
   *  same-change-request-text. */
  editKind: string;
  /** Number of edit-tool calls that touched this path on A / B. Highlights
   *  depth-of-change differences (e.g. "A made 12 edits here, B made 8"). */
  editCountA: number;
  editCountB: number;
  /** Total bytes of new content written to this path on A / B (sum of
   *  contentChars across all calls). Highlights bytes-of-change differences
   *  even when the final-state hashes happen to match. */
  bytesWrittenA: number;
  bytesWrittenB: number;
}

interface ArtifactDiff {
  rows: ArtifactDiffRow[];
  allIdentical: boolean;
  extractable: number;
  total: number;
  /** Count by edit kind across both runs, for the LLM to reason about
   *  whether "identical" rows prove end-state equality or just same patch. */
  fullWriteCount: number;
  partialReplaceCount: number;
  patchCount: number;
  /** Files where edit COUNT differs between A and B (e.g. "12 edits vs 8"). */
  countMismatchPaths: string[];
}

function compareEditArtifacts(
  artA: { path: string; contentHash: string; editKind?: string; contentChars?: number }[],
  artB: { path: string; contentHash: string; editKind?: string; contentChars?: number }[],
): ArtifactDiff {
  // Per-path aggregation: keep the LAST hash (final byte state for
  // full-write; last change-request for partial-replace) but also track
  // call count and total bytes written so the analyst can see depth-of-
  // change differences even when the final hashes happen to match.
  type AggEntry = { hash: string; kind: string; count: number; bytes: number };
  const aggA = new Map<string, AggEntry>();
  const aggB = new Map<string, AggEntry>();
  const accumulate = (m: Map<string, AggEntry>, items: typeof artA): void => {
    for (const it of items) {
      const cur = m.get(it.path);
      if (cur) {
        cur.hash = it.contentHash;
        cur.kind = it.editKind || cur.kind || "unknown";
        cur.count += 1;
        cur.bytes += it.contentChars || 0;
      } else {
        m.set(it.path, {
          hash: it.contentHash,
          kind: it.editKind || "unknown",
          count: 1,
          bytes: it.contentChars || 0,
        });
      }
    }
  };
  accumulate(aggA, artA);
  accumulate(aggB, artB);

  const allPaths = Array.from(new Set([...aggA.keys(), ...aggB.keys()])).sort();
  const rows: ArtifactDiffRow[] = [];
  let allIdentical = allPaths.length > 0;
  let extractable = 0;
  let fullWriteCount = 0;
  let partialReplaceCount = 0;
  let patchCount = 0;
  const countMismatchPaths: string[] = [];

  for (const path of allPaths) {
    const a = aggA.get(path);
    const b = aggB.get(path);
    const hashA = a?.hash || "(absent)";
    const hashB = b?.hash || "(absent)";
    let status = "unknown";
    if (hashA === "(absent)") {
      status = "B-only";
      allIdentical = false;
    } else if (hashB === "(absent)") {
      status = "A-only";
      allIdentical = false;
    } else if (hashA === "00000000" || hashB === "00000000") {
      status = "unknown (content not in args)";
      allIdentical = false;
    } else if (hashA === hashB) {
      status = "identical";
      extractable += 1;
    } else {
      status = "differ";
      extractable += 1;
      allIdentical = false;
    }
    const kinds = new Set<string>();
    if (a) kinds.add(a.kind);
    if (b) kinds.add(b.kind);
    let editKind = "unknown";
    if (kinds.size === 1) editKind = Array.from(kinds)[0];
    else if (kinds.size > 1) editKind = "mixed (" + Array.from(kinds).sort().join("/") + ")";

    const editCountA = a?.count || 0;
    const editCountB = b?.count || 0;
    const bytesWrittenA = a?.bytes || 0;
    const bytesWrittenB = b?.bytes || 0;
    if (editCountA > 0 && editCountB > 0 && editCountA !== editCountB) {
      countMismatchPaths.push(path);
    }

    rows.push({ path, hashA, hashB, status, editKind, editCountA, editCountB, bytesWrittenA, bytesWrittenB });

    if (editKind.startsWith("full-write")) fullWriteCount += 1;
    else if (editKind.startsWith("partial-replace")) partialReplaceCount += 1;
    else if (editKind.startsWith("patch")) patchCount += 1;
  }
  return {
    rows,
    allIdentical,
    extractable,
    total: allPaths.length,
    fullWriteCount,
    partialReplaceCount,
    patchCount,
    countMismatchPaths,
  };
}

function trimAnswer(s: string, max = 200): string {
  if (!s) return "(empty)";
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : flat.slice(0, max) + "…";
}

function trimGoal(s: string): string {
  return trimAnswer(s, 600);
}

interface DivergencePoint {
  index: number;
  axis: "name" | "model" | "absent_in_a" | "absent_in_b";
  detail?: string;
}

function findFirstDivergencePoint(cmp: CostComparison): DivergencePoint | null {
  for (let i = 0; i < cmp.callPairs.length; i++) {
    const p = cmp.callPairs[i];
    if (!p.a && !p.b) continue;
    if (!p.a) return { index: i, axis: "absent_in_a", detail: `${p.name} only in B` };
    if (!p.b) return { index: i, axis: "absent_in_b", detail: `${p.name} only in A` };
    if (p.a.name !== p.b.name) {
      return { index: i, axis: "name", detail: `A called \"${p.a.name}\", B called \"${p.b.name}\"` };
    }
    if (!p.sameModel) {
      return { index: i, axis: "model", detail: `A used ${p.a.model || "?"}, B used ${p.b.model || "?"}` };
    }
  }
  return null;
}

interface DecisionSupport {
  cheaperRun: string;
  moreExpensiveRun: string;
  costDeltaMeaningful: boolean;
  attributionConfidence: "high" | "medium" | "low";
  safeToClaimCostSavings: boolean;
  safeToClaimQualityEquivalence: boolean;
  safeToRecommendCheaperRun: boolean;
  reason: string;
}

function buildDecisionSupport(cmp: CostComparison, nameA: string, nameB: string): DecisionSupport {
  const costA = cmp.a.totalCost;
  const costB = cmp.b.totalCost;
  const cheaper = costA <= costB ? nameA : nameB;
  const moreExp = costA <= costB ? nameB : nameA;
  const denom = Math.max(Math.abs(costA), Math.abs(costB), 1e-9);
  const pct = Math.abs(costB - costA) / denom;
  const costDeltaMeaningful = pct >= 0.02;

  const blocking = cmp.drift.hasBlockingDrift;
  const pollution = cmp.cachePollution.suspect;
  let attribution: "high" | "medium" | "low";
  if (blocking || pollution) attribution = "low";
  else if (!cmp.sameShape || !cmp.answersEquivalent) attribution = "medium";
  else attribution = "high";

  const safeCost = costDeltaMeaningful && !pollution && !blocking;
  const safeQuality = cmp.answersEquivalent && cmp.sameShape && !blocking;
  const safeRecommend = safeCost && safeQuality;

  const reasons: string[] = [];
  if (!costDeltaMeaningful) reasons.push("cost delta is within noise (<2%)");
  if (pollution) reasons.push("cache pollution suspected");
  if (blocking) reasons.push("blocking drift on an axis that should be identical");
  if (!cmp.sameShape) reasons.push("call shape differs (runs took different paths)");
  if (!cmp.answersEquivalent) reasons.push("final answers differ — quality cannot be assumed equivalent");
  const reason = reasons.length === 0
    ? `Comparison is clean; ${cheaper} is cheaper and the two runs are shape- and answer-equivalent.`
    : reasons.join("; ");

  return {
    cheaperRun: cheaper,
    moreExpensiveRun: moreExp,
    costDeltaMeaningful,
    attributionConfidence: attribution,
    safeToClaimCostSavings: safeCost,
    safeToClaimQualityEquivalence: safeQuality,
    safeToRecommendCheaperRun: safeRecommend,
    reason,
  };
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

  // User goal — needed for the analyst to judge whether outputs satisfied the request.
  const goalA = (cmp.userTextA || "").trim();
  const goalB = (cmp.userTextB || "").trim();
  if (goalA || goalB) {
    lines.push("## User goal (from the first user prompt)");
    lines.push("Use this to judge whether each run's final output actually satisfied the request.");
    lines.push("");
    if (goalA && goalB && goalA === goalB) {
      lines.push("Both runs started from the same prompt:");
      lines.push("```");
      lines.push(trimGoal(goalA));
      lines.push("```");
    } else {
      lines.push(`### A · ${nameA}`);
      lines.push("```");
      lines.push(trimGoal(goalA || "(no first user prompt captured)"));
      lines.push("```");
      lines.push("");
      lines.push(`### B · ${nameB}`);
      lines.push("```");
      lines.push(trimGoal(goalB || "(no first user prompt captured)"));
      lines.push("```");
      if (goalA && goalB && goalA !== goalB) {
        lines.push("");
        lines.push("> ⚠ The first user prompt differs between runs. Output-quality judgments must account for this — the runs were not asked the same question.");
      }
    }
    lines.push("");
  }

  // Experiment intent + Theoretical expectation + Developer levers —
  // interpretation scaffolding that anchors "what should have changed"
  // against "what actually changed". Inferred deterministically from
  // drift + run-name pattern; confidence is labeled so the analyst LLM
  // does not over-trust the guess.
  const intent = inferExperimentIntent(cmp, nameA, nameB);
  lines.push("## Experiment intent (inferred)");
  lines.push("Deterministic guess at what the user was probably A/B-testing.");
  lines.push("Confidence is labeled — the analyst should NOT treat this as ground");
  lines.push("truth, but as a hypothesis to compare against the observed result.");
  lines.push("");
  if (intent.sharedScenarioLabel) {
    lines.push(`- **shared_scenario_label:** \`${intent.sharedScenarioLabel}\``);
  }
  if (intent.differentialLabelA && intent.differentialLabelB) {
    lines.push(`- **differential_label_a:** \`${intent.differentialLabelA}\``);
    lines.push(`- **differential_label_b:** \`${intent.differentialLabelB}\``);
  }
  lines.push(`- **inferred_variable_under_test:** \`${intent.variable}\``);
  lines.push(`- **inference_confidence:** ${intent.confidence}`);
  lines.push("- **inference_basis:**");
  for (const b of intent.basis) {
    lines.push(`  - ${b}`);
  }
  lines.push("");

  const theory = THEORY_MAP[intent.variable];
  lines.push("## Theoretical expectation");
  lines.push(`Rule-based "what should have changed" for tested variable = \`${intent.variable}\`.`);
  lines.push("Use this to write the Hypothesis-vs-observed framing in the report.");
  lines.push("");
  lines.push(`- **expected_cost_mechanism:** ${theory.costMechanism}`);
  lines.push(`- **expected_quality_mechanism:** ${theory.qualityMechanism}`);
  lines.push(`- **what_to_check_first:** ${theory.whatToCheckFirst}`);
  lines.push("");

  lines.push("## Developer levers affected");
  lines.push("Which optimization levers this run pair provides evidence about.");
  lines.push("\"Implicated\" means the corresponding configuration axis drifted");
  lines.push("between A and B; non-implicated levers were held constant and");
  lines.push("cannot be evaluated from this comparison.");
  lines.push("");
  const levers = buildDeveloperLevers(cmp, intent);
  lines.push("| Lever | Implicated? | Evidence | Developer implication |");
  lines.push("|---|---|---|---|");
  for (const r of levers) {
    lines.push(`| ${r.lever} | ${r.implicated ? "✓ yes" : "—"} | ${r.evidence} | ${r.implication} |`);
  }
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

  // System prompt per-section diff — emitted whenever the parser surfaced
  // top-level block data on both sides AND at least one block differs.
  // Lets the analyst see *which* <tag> blocks moved the system-prompt
  // hash, instead of just "hashes differ".
  const spd = cmp.drift.systemPromptDiff;
  if (spd && spd.hasBlockDrift) {
    lines.push("## System prompt block diff");
    lines.push("Per-section breakdown of top-level `<tag>...</tag>` blocks in the system prompt. Char counts are exact; rows sorted by `|delta|` descending. `only-A` / `only-B` rows mark blocks present on one side only (often an MCP server or skill that was active in one run and not the other).");
    lines.push("");
    const plaintextA = Math.max(0, (cmp.fingerprintA.systemPromptChars || 0) - spd.taggedCharsA);
    const plaintextB = Math.max(0, (cmp.fingerprintB.systemPromptChars || 0) - spd.taggedCharsB);
    lines.push(`- **Tagged chars:** A ${fmtNum(spd.taggedCharsA)} · B ${fmtNum(spd.taggedCharsB)} · Δ ${fmtSignedTok(spd.totalBlockDelta)}`);
    lines.push(`- **Untagged plaintext between blocks (preamble + interstitial text):** A ${fmtNum(plaintextA)} · B ${fmtNum(plaintextB)} · Δ ${fmtSignedTok(plaintextB - plaintextA)}`);
    lines.push("");
    lines.push("| Status | Block | chars A | chars B | Δ chars |");
    lines.push("|---|---|---:|---:|---:|");
    for (const r of spd.rows) {
      const icon = r.status === "identical" ? "✓" : r.status === "chars-differ" ? "≠" : r.status === "only-A" ? "🅰" : "🅱";
      const sign = r.delta > 0 ? "+" : "";
      lines.push(`| ${icon} ${r.status} | \`<${r.key}>\` | ${r.charsA ? fmtNum(r.charsA) : "—"} | ${r.charsB ? fmtNum(r.charsB) : "—"} | ${r.charsA && r.charsB ? sign + fmtNum(r.delta) : (r.status === "only-A" ? "−" + fmtNum(r.charsA) : "+" + fmtNum(r.charsB))} |`);
    }
    lines.push("");
    lines.push("> Per-section token counts shown in the UI are pro-rata estimates (`chars / sysChars × sysTok`) and shift between runs even when a section's chars are identical. Use the chars columns above as ground truth when reasoning about content drift.");
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

  // First divergence point (where call sequence first differs in name or model)
  const divPoint = findFirstDivergencePoint(cmp);
  if (divPoint) {
    lines.push("## First divergence point");
    lines.push(`- **First differing primary call index:** ${divPoint.index}`);
    lines.push(`- **First differing axis:** ${divPoint.axis}`);
    if (divPoint.detail) lines.push(`- **Detail:** ${divPoint.detail}`);
    lines.push("");
  }

  // Configuration diff (synthesized from existing fingerprints)
  const fa = cmp.fingerprintA;
  const fb = cmp.fingerprintB;
  lines.push("## Configuration diff");
  lines.push("Deterministic. Compares the inputs to the agent, not the agent's behavior.");
  lines.push("");
  lines.push(`- **primary_model_same:** ${fa.primaryModel === fb.primaryModel} (A=${fa.primaryModel || "?"}, B=${fb.primaryModel || "?"})`);
  lines.push(`- **system_prompt_same:** ${fa.systemPromptHash === fb.systemPromptHash}`);
  lines.push(`- **system_prompt_chars:** A=${fa.systemPromptChars} · B=${fb.systemPromptChars} · Δ=${fb.systemPromptChars - fa.systemPromptChars}`);
  lines.push(`- **system_prompt_hash:** A=${fa.systemPromptHash || "(n/a)"} · B=${fb.systemPromptHash || "(n/a)"}`);
  if (!fa.systemPromptHashTrusted || !fb.systemPromptHashTrusted) {
    lines.push("  > Hashes computed from preview only; treat \"same\" cautiously.");
  }
  const toolSetSame =
    fa.toolsInvoked.length === fb.toolsInvoked.length &&
    fa.toolsInvoked.every((t, i) => t === fb.toolsInvoked[i]);
  lines.push(`- **tool_set_same (tools actually invoked):** ${toolSetSame}`);
  lines.push("");

  // Behavior diff (synthesized from existing fingerprints + KPIs)
  const bkSrc = cmp.behavioralKpis;
  const filesEditedSame =
    fa.filesEdited.length === fb.filesEdited.length &&
    fa.filesEdited.every((f, i) => f === fb.filesEdited[i]);
  const filesReferencedSame =
    fa.filesTouched.length === fb.filesTouched.length &&
    fa.filesTouched.every((f, i) => f === fb.filesTouched[i]);
  const outputDeltaPct = bkSrc.totalOutputTokens.deltaPct;
  lines.push("## Behavior diff");
  lines.push("Deterministic. How the runs actually behaved.");
  lines.push("");
  lines.push(`- **same_user_turns:** ${bkSrc.userTurns.a === bkSrc.userTurns.b} (A=${bkSrc.userTurns.a}, B=${bkSrc.userTurns.b})`);
  lines.push(`- **same_primary_llm_call_count:** ${bkSrc.primaryLlmCalls.a === bkSrc.primaryLlmCalls.b} (A=${bkSrc.primaryLlmCalls.a}, B=${bkSrc.primaryLlmCalls.b})`);
  lines.push(`- **same_tool_call_count:** ${bkSrc.toolCalls.a === bkSrc.toolCalls.b} (A=${bkSrc.toolCalls.a}, B=${bkSrc.toolCalls.b})`);
  lines.push(`- **same_distinct_tools:** ${bkSrc.distinctTools.a === bkSrc.distinctTools.b} (A=${bkSrc.distinctTools.a}, B=${bkSrc.distinctTools.b})`);
  lines.push(`- **same_tool_sequence:** ${toolSetSame}`);
  lines.push(`- **same_files_edited:** ${filesEditedSame}`);
  lines.push(`- **same_files_referenced:** ${filesReferencedSame}`);
  lines.push(`- **same_call_shape:** ${cmp.sameShape}`);
  lines.push(`- **same_final_answer:** ${cmp.answersEquivalent}`);
  lines.push(`- **output_verbosity_delta_pct:** ${fmtPctSigned(outputDeltaPct)}`);
  // Reasoning vs visible split — answers "is the +N% verbosity hidden
  // thinking tokens or text the user actually sees?"
  const reasonA = bkSrc.reasoningOutputTokens.a;
  const reasonB = bkSrc.reasoningOutputTokens.b;
  const visA = bkSrc.visibleOutputTokens.a;
  const visB = bkSrc.visibleOutputTokens.b;
  const anyReasoning = reasonA > 0 || reasonB > 0;
  lines.push(`- **reasoning_tokens:** A=${reasonA}, B=${reasonB} (hidden from end user; billed as output)`);
  lines.push(`- **visible_output_tokens:** A=${visA}, B=${visB} (what the user actually saw)`);
  if (anyReasoning) {
    const visDeltaPct = visA > 0 ? ((visB - visA) / visA) * 100 : 0;
    const reasonDeltaPct = reasonA > 0 ? ((reasonB - reasonA) / reasonA) * 100 : 0;
    lines.push(`- **visible_output_delta_pct:** ${fmtPctSigned(visDeltaPct)} (verbosity the user felt)`);
    lines.push(`- **reasoning_delta_pct:** ${fmtPctSigned(reasonDeltaPct)} (extended-thinking spend)`);
  } else {
    lines.push("- **reasoning_used:** false — neither run used an extended-thinking model; the verbosity delta is 100% visible response text.");
  }
  lines.push("");

  // Fixed vs variable cost (synthesized from bucket deltas)
  const fixedBuckets = new Set(["system", "tool_defs"]);
  const variableBuckets = new Set(["history", "tool_results", "current", "output"]);
  let fixedA = 0, fixedB = 0, varA = 0, varB = 0;
  let systemDelta = 0, toolDefsDelta = 0;
  for (const d of cmp.bucketDeltas) {
    if (fixedBuckets.has(d.bucket as string)) {
      fixedA += d.aCost;
      fixedB += d.bCost;
      if (d.bucket === "system") systemDelta = d.delta;
      if (d.bucket === "tool_defs") toolDefsDelta = d.delta;
    } else if (variableBuckets.has(d.bucket as string)) {
      varA += d.aCost;
      varB += d.bCost;
    }
  }
  const totalA = fixedA + varA;
  const totalB = fixedB + varB;
  const fixedShareA = totalA > 0 ? fixedA / totalA : 0;
  const fixedShareB = totalB > 0 ? fixedB / totalB : 0;
  lines.push("## Fixed vs variable cost");
  lines.push("Fixed overhead = system + tool_defs (paid on every call). Variable = history + tool_results + current + output (scales with the work).");
  lines.push("");
  lines.push(`- **fixed_overhead_share_a:** ${(fixedShareA * 100).toFixed(1)}%`);
  lines.push(`- **fixed_overhead_share_b:** ${(fixedShareB * 100).toFixed(1)}%`);
  lines.push(`- **system_delta_cr:** ${systemDelta >= 0 ? "+" : ""}${fmtCr(systemDelta)}`);
  lines.push(`- **tool_defs_delta_cr:** ${toolDefsDelta >= 0 ? "+" : ""}${fmtCr(toolDefsDelta)}`);
  const overheadInterp =
    fixedShareB > fixedShareA + 0.02
      ? `${nameB} carries more fixed overhead per call than ${nameA}; cost will scale worse on longer multi-call tasks.`
      : fixedShareA > fixedShareB + 0.02
        ? `${nameA} carries more fixed overhead per call than ${nameB}; the cheaper-prefix run will compound savings on longer tasks.`
        : "Fixed overhead share is roughly equal between the two runs.";
  lines.push(`- **interpretation:** ${overheadInterp}`);
  lines.push("");

  // Decision support (deterministic synthesis)
  const ds2 = buildDecisionSupport(cmp, nameA, nameB);
  lines.push("## Decision support");
  lines.push("Deterministic synthesis of the safety of the obvious recommendations. The analyst must respect these flags.");
  lines.push("");
  lines.push(`- **cheaper_run:** ${ds2.cheaperRun}`);
  lines.push(`- **more_expensive_run:** ${ds2.moreExpensiveRun}`);
  lines.push(`- **cost_delta_meaningful:** ${ds2.costDeltaMeaningful} (abs(Δ%) ≥ 2%)`);
  lines.push(`- **answers_equivalent:** ${cmp.answersEquivalent}`);
  lines.push(`- **same_call_shape:** ${cmp.sameShape}`);
  lines.push(`- **has_blocking_drift:** ${cmp.drift.hasBlockingDrift}`);
  lines.push(`- **cache_pollution_suspect:** ${cmp.cachePollution.suspect}`);
  lines.push(`- **attribution_confidence:** ${ds2.attributionConfidence}`);
  lines.push(`- **safe_to_claim_cost_savings:** ${ds2.safeToClaimCostSavings}`);
  lines.push(`- **safe_to_claim_quality_equivalence:** ${ds2.safeToClaimQualityEquivalence}`);
  lines.push(`- **safe_to_recommend_cheaper_run:** ${ds2.safeToRecommendCheaperRun}`);
  lines.push(`- **reason:** ${ds2.reason}`);
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
  lines.push(kpiRow("  ↳ Reasoning (hidden from user)", bk.reasoningOutputTokens));
  lines.push(kpiRow("  ↳ Visible response tokens", bk.visibleOutputTokens));
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

  // Final-response signals (Layer 2): deterministic semantic + format
  // extraction from both finals so the analyst can judge substantive
  // agreement without re-parsing strings.
  const signalsA = extractFinalResponseSignals(cmp.finalAnswerA);
  const signalsB = extractFinalResponseSignals(cmp.finalAnswerB);
  lines.push("## Final-response signals");
  lines.push("Deterministic. Extracted from each run's full final response so");
  lines.push("the analyst can judge substantive agreement, not string equality.");
  lines.push("");
  lines.push("| Signal | A | B | Overlap / Notes |");
  lines.push("|---|---|---|---|");
  lines.push(`| Char length | ${signalsA.chars} | ${signalsB.chars} | Δ ${signalsB.chars - signalsA.chars} |`);
  lines.push(`| Line count | ${signalsA.lines} | ${signalsB.lines} | Δ ${signalsB.lines - signalsA.lines} |`);
  lines.push(`| Numbers mentioned | ${fmtSet(signalsA.numbers)} | ${fmtSet(signalsB.numbers)} | overlap: ${fmtSet(intersect(signalsA.numbers, signalsB.numbers))} |`);
  lines.push(`| File paths mentioned | ${fmtSet(signalsA.paths)} | ${fmtSet(signalsB.paths)} | overlap: ${fmtSet(intersect(signalsA.paths, signalsB.paths))} |`);
  lines.push(`| Markdown tables | ${signalsA.tables} | ${signalsB.tables} | |`);
  lines.push(`| Bullet/list items | ${signalsA.bullets} | ${signalsB.bullets} | |`);
  lines.push(`| Code blocks | ${signalsA.codeBlocks} | ${signalsB.codeBlocks} | |`);
  lines.push(`| Headings | ${signalsA.headings} | ${signalsB.headings} | |`);
  const numOverlap = intersect(signalsA.numbers, signalsB.numbers);
  const pathOverlap = intersect(signalsA.paths, signalsB.paths);
  const numAgree = signalsA.numbers.length > 0 && signalsB.numbers.length > 0 &&
    numOverlap.length === signalsA.numbers.length && numOverlap.length === signalsB.numbers.length;
  const pathAgree = signalsA.paths.length > 0 && signalsB.paths.length > 0 &&
    pathOverlap.length === signalsA.paths.length && pathOverlap.length === signalsB.paths.length;
  lines.push("");
  lines.push(`- **substantive_numbers_agree:** ${numAgree ? "true" : "false"} (use as a strong hint for quality equivalence on quantitative answers)`);
  lines.push(`- **referenced_paths_agree:** ${pathAgree ? "true" : "false"} (same artifacts named in both finals)`);
  lines.push("");

  // Edit artifacts diff (Layer 3): byte-level identity of file-write
  // contents extracted from edit-tool args. Closest-to-ground-truth
  // quality signal available without filesystem snapshots.
  lines.push("## Edit artifacts diff");
  lines.push("Per file written by edit/create/replace tools, with the kind of");
  lines.push("edit so you know what an \"identical\" hash actually proves:");
  lines.push("");
  lines.push("- **full-write** (`create_file`, `write_file`, `edit_file` with a");
  lines.push("  full `code` body): hash covers the END-STATE file bytes.");
  lines.push("  Identical ⇒ both runs produced the same final file. Strong");
  lines.push("  ground truth.");
  lines.push("- **partial-replace** (`str_replace`, `replace_string_in_file`,");
  lines.push("  `insert_edit`): hash covers `oldString → newString`. Identical");
  lines.push("  ⇒ both runs proposed the same change at the same location, but");
  lines.push("  the resulting file is byte-identical ONLY IF the pre-edit file");
  lines.push("  state was the same. Treat this as strong evidence, not proof.");
  lines.push("- **patch** (`apply_patch`): hash covers the full diff including");
  lines.push("  context lines. Identical ⇒ identical patch applied.");
  lines.push("- **unknown / hash `00000000`:** tool args didn't carry");
  lines.push("  recognizable content; identity can't be judged from the export.");
  lines.push("");
  const artifactDiff = compareEditArtifacts(cmp.fingerprintA.editArtifacts, cmp.fingerprintB.editArtifacts);
  if (artifactDiff.rows.length === 0) {
    lines.push("(no edit-tool calls recorded on either side)");
  } else {
    lines.push("| Path | Kind | A edits | B edits | A bytes | B bytes | A hash | B hash | Status |");
    lines.push("|---|---|---:|---:|---:|---:|---|---|---|");
    for (const r of artifactDiff.rows) {
      const fmtCount = (n: number): string => n === 0 ? "—" : String(n);
      const fmtBytes = (n: number): string => n === 0 ? "—" : String(n);
      lines.push(`| \`${r.path}\` | ${r.editKind} | ${fmtCount(r.editCountA)} | ${fmtCount(r.editCountB)} | ${fmtBytes(r.bytesWrittenA)} | ${fmtBytes(r.bytesWrittenB)} | ${r.hashA} | ${r.hashB} | ${r.status} |`);
    }
    lines.push("");
    lines.push(`- **artifacts_identical:** ${artifactDiff.allIdentical ? "true" : "false"} (every edit on both sides has matching content hashes)`);
    lines.push(`- **artifacts_with_extractable_content:** ${artifactDiff.extractable} / ${artifactDiff.total}`);
    lines.push(`- **edit_kind_counts:** full-write ${artifactDiff.fullWriteCount}, partial-replace ${artifactDiff.partialReplaceCount}, patch ${artifactDiff.patchCount}`);

    // Depth-of-change signal — distinct from end-state equality.
    // Catches the case "Run A made 12 edits to README.md, Run B made 8"
    // which can indicate one run did a more thorough job even when the
    // final hashes happen to match.
    const totalEditsA = artifactDiff.rows.reduce((s, r) => s + r.editCountA, 0);
    const totalEditsB = artifactDiff.rows.reduce((s, r) => s + r.editCountB, 0);
    const totalBytesA = artifactDiff.rows.reduce((s, r) => s + r.bytesWrittenA, 0);
    const totalBytesB = artifactDiff.rows.reduce((s, r) => s + r.bytesWrittenB, 0);
    lines.push(`- **total_edit_calls:** A=${totalEditsA}, B=${totalEditsB}` + (totalEditsA !== totalEditsB ? ` (Δ ${totalEditsB - totalEditsA >= 0 ? "+" : ""}${totalEditsB - totalEditsA})` : ""));
    lines.push(`- **total_bytes_written:** A=${totalBytesA}, B=${totalBytesB}` + (totalBytesA !== totalBytesB ? ` (Δ ${totalBytesB - totalBytesA >= 0 ? "+" : ""}${totalBytesB - totalBytesA})` : ""));
    if (artifactDiff.countMismatchPaths.length > 0) {
      const sample = artifactDiff.countMismatchPaths.slice(0, 5).map((p) => "`" + p + "`").join(", ");
      const more = artifactDiff.countMismatchPaths.length > 5 ? ` (and ${artifactDiff.countMismatchPaths.length - 5} more)` : "";
      lines.push(`- **paths_with_edit_count_mismatch:** ${artifactDiff.countMismatchPaths.length} (${sample}${more}) — one run made more edits to the same file. Often a coverage/thoroughness signal: more edits to the same documentation file usually means more locations updated.`);
    }
    if (artifactDiff.partialReplaceCount > 0 || artifactDiff.patchCount > 0) {
      lines.push("- ⚠ Some rows are partial-replace or patch — \"identical\" there means same change-request, not guaranteed-identical end-state.");
    }
  }
  lines.push("");

  // Final answer hashes + previews -- Layer 1: ship the FULL final response
  // (parser caps at 4000 chars) instead of a 200-char preview, so the
  // analyst LLM can judge quality from real content.
  lines.push("## Final responses");
  lines.push("");
  lines.push(`### A · ${nameA}`);
  lines.push("```");
  lines.push(cmp.finalAnswerA || "(empty)");
  lines.push("```");
  lines.push("");
  lines.push(`### B · ${nameB}`);
  lines.push("```");
  lines.push(cmp.finalAnswerB || "(empty)");
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
  lines.push("Write a decision-quality A/B test report in TWO LAYERS:");
  lines.push("");
  lines.push("1. **Top of report — an executive panel that fits on one screen.**");
  lines.push("   This is what the reader sees first and may be all they read.");
  lines.push("   Three short blocks: `Bottom line`, `TL;DR`, `Why this matters`.");
  lines.push("2. **Below a horizontal rule — `## Evidence (dive deeper)`** with");
  lines.push("   the detailed sections (Experiment summary through What to");
  lines.push("   validate next). This is the audit trail for a reader who wants");
  lines.push("   to verify the top panel's claims.");
  lines.push("");
  lines.push("Use the run labels from \"Runs under comparison\" throughout the");
  lines.push("prose; do not say \"A\" or \"B\" except when referring to a table");
  lines.push("column. The deterministic blocks in the facts (Configuration diff,");
  lines.push("Behavior diff, Fixed vs variable cost, Decision support) are the");
  lines.push("source of truth — quote their values, do not re-derive them.");
  lines.push("");
  lines.push("**Lede-picking rule.** The Bottom line and TL;DR should lead with");
  lines.push("the MOST IMPORTANT finding, which is not always cost:");
  lines.push("- If the Edit artifacts diff shows divergent bytes on a file the");
  lines.push("  user cares about, OR the Final-response signals show a concrete");
  lines.push("  correctness gap (different numbers, missing paths, wrong");
  lines.push("  metadata), that quality finding is the lede.");
  lines.push("- Cost is the lede only when artifacts and final-response signals");
  lines.push("  agree (`artifacts_identical: true` AND `substantive_numbers_");
  lines.push("  agree: true` AND `referenced_paths_agree: true`).");
  lines.push("- If both quality and cost matter, state the quality finding");
  lines.push("  first in one sentence, then the cost finding in the second.");
  lines.push("");
  lines.push("**One-sentence-action rule.** The third bullet of TL;DR must be");
  lines.push("a single imperative sentence the reader can act on today.");
  lines.push("Examples: \"Revert the system-prompt changes in <runLabel>.\"");
  lines.push("\"Ship <runLabel> as the default.\" \"Re-run with caches warmed");
  lines.push("before generalizing.\" Do NOT hedge (\"consider\", \"you may want");
  lines.push("to\", \"it depends\"). If the deterministic facts genuinely don't");
  lines.push("support an action, the action is \"Re-run with <specific");
  lines.push("variable> held constant to clarify the result.\"");
  lines.push("");
  lines.push("**Consistency rule.** The Bottom line, TL;DR action, the");
  lines.push("Evidence-layer A/B verdict, and the Was-the-extra-cost-worth-it");
  lines.push("section must all agree. If the deterministic Decision support");
  lines.push("block says `safe_to_recommend_cheaper_run: false`, the action");
  lines.push("cannot be \"ship the cheaper run\". If `cost_delta_meaningful:");
  lines.push("false`, the lede cannot be the cost number.");
  lines.push("");

  lines.push("## Bottom line");
  lines.push("One bold sentence. Action-oriented. Names the winner OR says");
  lines.push("\"don't roll out the change\" OR \"runs are equivalent — ship the");
  lines.push("cheaper one\" OR \"unproven — re-run with X held constant\". Names");
  lines.push("the concrete reason in 10 words or fewer (the quality finding,");
  lines.push("the cost finding, or the contamination).");
  lines.push("");
  lines.push("Example shape (do not copy verbatim):");
  lines.push("> **Don't roll out `<runLabel>` — bigger system prompt costs +8%");
  lines.push("> and introduced wrong day-numbering in renamed files.**");
  lines.push("");

  lines.push("## TL;DR");
  lines.push("Exactly three bullets, in this order:");
  lines.push("");
  lines.push("- **Cost:** `<cheaper-run>` is `<Δ%>` cheaper (`<Δ cr>`). State");
  lines.push("  whether that delta is structural (prefix-driven) or behavioral.");
  lines.push("- **Quality:** One sentence with the ONE concrete finding from");
  lines.push("  Final-response signals or Edit artifacts diff. If finals agree");
  lines.push("  substantively, say so. If they don't, name the gap (different");
  lines.push("  numbers / missing paths / wrong metadata / divergent bytes).");
  lines.push("- **Action:** One imperative sentence — see one-sentence-action");
  lines.push("  rule above.");
  lines.push("");

  lines.push("## Why this matters");
  lines.push("2–3 sentences. The real human story behind the numbers. Reference");
  lines.push("exact values but not field names. This is where you tell the");
  lines.push("reader what the experiment actually proved (or didn't prove) in");
  lines.push("plain English — what the more expensive prompt bought, what the");
  lines.push("cheaper one missed, what a future run should look like. End with");
  lines.push("the practical implication for a developer's day-to-day workflow.");
  lines.push("");
  lines.push("After this section, insert a horizontal rule (`---`) and start the");
  lines.push("Evidence layer.");
  lines.push("");

  lines.push("---");
  lines.push("");
  lines.push("# Evidence (dive deeper)");
  lines.push("");
  lines.push("Audit trail for the top panel. Reader can skim or skip these.");
  lines.push("Every claim in Bottom line / TL;DR / Why this matters must trace");
  lines.push("back to a number quoted here.");
  lines.push("");

  lines.push("### Experiment summary");
  lines.push("2–4 sentences. Name the two runs, the apparent hypothesis (use the");
  lines.push("provided plan or inferred-from-names hypothesis), the configuration");
  lines.push("axes that were expected to stay equivalent, and whether the");
  lines.push("comparison shape (drift, cache pollution, answer equivalence) looks");
  lines.push("clean or contaminated. If the comparison is contaminated, say so");
  lines.push("here so the reader holds the rest of the report at the right");
  lines.push("confidence level. Mention contamination/uncertainty ONCE here — do");
  lines.push("not repeat the same caveat in every later section.");
  lines.push("");
  lines.push("**Hypothesis-vs-observed framing.** Use the two new deterministic");
  lines.push("blocks in the facts:");
  lines.push("- **Experiment intent (inferred)** gives you `inferred_variable_");
  lines.push("  under_test` (model / system_prompt / tool_config / prompt_strategy /");
  lines.push("  none_detected / unknown) with confidence + basis. Quote the");
  lines.push("  variable and confidence in this section.");
  lines.push("- **Theoretical expectation** gives you the rule-based \"what should");
  lines.push("  have changed if this variable was the cause\" — `expected_cost_");
  lines.push("  mechanism` and `expected_quality_mechanism`. Lead the summary");
  lines.push("  with one sentence on what we expected to see.");
  lines.push("Then later sections (Cost outcome, Behavior comparison) can frame");
  lines.push("themselves as \"observed matches/contradicts expectation\".");
  lines.push("If `inferred_variable_under_test = none_detected`, lead with that —");
  lines.push("the runs look effectively identical and the test is a noise-floor");
  lines.push("measurement, not a meaningful A/B. If `unknown`, say so and");
  lines.push("recommend the user clarify the tested axis.");
  lines.push("");

  lines.push("### What changed");
  lines.push("Compact markdown table summarizing the comparison axes in plain");
  lines.push("developer language. Use only deterministic flags from the");
  lines.push("Configuration diff and Behavior diff blocks. This is the");
  lines.push("scannable \"30-second summary\" — a reader should understand the");
  lines.push("main story from this table alone.");
  lines.push("");
  lines.push("Use exactly this shape (fill in real values, drop rows that don't");
  lines.push("apply, mark suspicious rows like truncated-looking path deltas as");
  lines.push("\"Maybe noise\" rather than \"Yes\"):");
  lines.push("");
  lines.push("| Area | Changed? | Meaning |");
  lines.push("|---|---:|---|");
  lines.push("| User request | No/Yes | Same/different first prompt |");
  lines.push("| Primary model | No/Yes | <model> both sides, or A=X vs B=Y |");
  lines.push("| System prompt | No/Yes | If yes, quote char delta and % |");
  lines.push("| Tools registered | No/Yes | Same N distinct tools, or list diff |");
  lines.push("| Call shape | No/Yes | LLM/tool call counts and sequence |");
  lines.push("| Files edited | No/Yes | Count or list |");
  lines.push("| Files referenced | No/Yes/Maybe noise | Flag truncation-looking deltas |");
  lines.push("| Output verbosity | No/Yes | Quote `output_verbosity_delta_pct` AND split into reasoning vs visible (see below) |");
  lines.push("| Final answer text | No/Yes | From `same_final_answer` |");
  lines.push("| Cost | No/Yes | Quote headline delta in cr and % |");
  lines.push("");

  lines.push("### A/B verdict");
  lines.push("One short paragraph plus a one-line headline. Use the Decision");
  lines.push("support block verbatim:");
  lines.push("- Name `cheaper_run` and `more_expensive_run`.");
  lines.push("- Quote `attribution_confidence` (high / medium / low).");
  lines.push("- State whether the cheaper run is the recommended winner, an");
  lines.push("  unproven candidate, or unsafe to recommend, based on");
  lines.push("  `safe_to_recommend_cheaper_run` and the reason field.");
  lines.push("- If both runs are within noise, say \"no winner — runs are");
  lines.push("  effectively equivalent\".");
  lines.push("");

  lines.push("### Core story");
  lines.push("2–4 sentence plain-English narrative that makes the comparison");
  lines.push("memorable. Use the actual run labels and numbers. This is where");
  lines.push("the **hello-world framing** lives:");
  lines.push("");
  lines.push("- Quote the pre-divergence delta (\"if both agents had just said");
  lines.push("  'hi' once, the delta would have been +X cr / +Y%\").");
  lines.push("- Then quote the full-session delta and explain the amplification");
  lines.push("  factor (\"that same per-call prefix tax × N calls becomes +Z cr\").");
  lines.push("- State whether the delta is overwhelmingly structural (prefix-");
  lines.push("  driven), overwhelmingly behavioral (path-driven), or mixed.");
  lines.push("- Close with the practical implication: is this a different");
  lines.push("  amount of work, a different output style, or pure structural");
  lines.push("  overhead?");
  lines.push("");
  lines.push("Example of the tone (do not copy verbatim — use real numbers):");
  lines.push("> Both agents did the same work in the same shape and reached the");
  lines.push("> same substantive answer. The newer system prompt is bigger and");
  lines.push("> trains the agent to write a more conversational final response.");
  lines.push("> That's the entire delta: a bigger per-call prefix paid 15 times,");
  lines.push("> plus a chattier final answer.");
  lines.push("");

  lines.push("### Behavior comparison");
  lines.push("3–5 bullets. Translate the Behavior diff block into developer");
  lines.push("language: did the runs use the same model, take the same call");
  lines.push("shape, touch the same files, run the same tool sequence? Lead");
  lines.push("with what stayed the same, then call out what diverged and by");
  lines.push("how much (output verbosity delta, distinct tools, file sets).");
  lines.push("Save cost interpretation for the Cost outcome section.");
  lines.push("");
  lines.push("**REQUIRED — output-token attribution.** Whenever you report an");
  lines.push("`output_verbosity_delta_pct`, you MUST also state how the delta");
  lines.push("splits between visible response tokens (what the end user sees)");
  lines.push("and reasoning tokens (internal extended thinking, billed as");
  lines.push("output but hidden from the user). The facts block ships:");
  lines.push("");
  lines.push("- `reasoning_tokens: A=N, B=M` — internal thinking, end user");
  lines.push("  never sees these.");
  lines.push("- `visible_output_tokens: A=N, B=M` — what the user actually saw");
  lines.push("  in the response stream.");
  lines.push("- `visible_output_delta_pct` and `reasoning_delta_pct` when");
  lines.push("  reasoning is present in either run.");
  lines.push("- `reasoning_used: false` when neither run used an extended-");
  lines.push("  thinking model — in that case say so plainly: \"the verbosity");
  lines.push("  delta is 100% visible response text\".");
  lines.push("");
  lines.push("Frame it for the developer:");
  lines.push("");
  lines.push("- If reasoning_tokens > 0 on both sides and the verbosity delta");
  lines.push("  is mostly in reasoning, say so: \"The +N% verbosity is hidden");
  lines.push("  reasoning, not user-visible text — the response the user saw");
  lines.push("  was nearly identical in length.\"");
  lines.push("- If the visible delta dominates, say so: \"The +N% verbosity is");
  lines.push("  in user-visible response text — the user felt the chattier");
  lines.push("  reply.\"");
  lines.push("- If only one run used reasoning, flag the asymmetry: \"Run B");
  lines.push("  spent K tokens on internal reasoning that Run A did not. Even");
  lines.push("  if visible text is similar, B paid for extra thinking.\"");
  lines.push("");

  lines.push("### Output quality comparison");
  lines.push("Judge each run's final response against the \"User goal\" block.");
  lines.push("Lead with one of these verdict prefixes, then 2–4 sentences:");
  lines.push("");
  lines.push("- ✅ **<runLabel> answered better** — name which run more directly");
  lines.push("  served the request (correctness, completeness, format,");
  lines.push("  actionability). Quote a short fragment from each.");
  lines.push("- ≈ **Equivalent for the user's goal** — both final responses");
  lines.push("  satisfied the request to the same useful level. Default to this");
  lines.push("  when the substantive outcome agrees, even if wording differs.");
  lines.push("- ⚠ **Different usefulness profile, not enough evidence to pick a");
  lines.push("  quality winner** — use this when both finals agree on the");
  lines.push("  substantive outcome but differ in format/style (e.g. one is");
  lines.push("  terse with artifact paths, the other is conversational with");
  lines.push("  inline tables). Describe each profile in user-facing terms and");
  lines.push("  say who each profile suits.");
  lines.push("- ⚠ **One run is materially worse** — flag missing steps, wrong");
  lines.push("  answer, truncated output, or refusal. Name the run and the gap.");
  lines.push("- ❓ **Cannot judge from this comparison** — use ONLY when the");
  lines.push("  user goal is missing, both finals are empty, or there is");
  lines.push("  literally no comparable content. Do not use this just because");
  lines.push("  `same_final_answer: false` — that is a string check, not a");
  lines.push("  quality verdict.");
  lines.push("");
  lines.push("When picking the verdict, use these deterministic blocks from");
  lines.push("the facts:");
  lines.push("");
  lines.push("1. **Final-response signals block** (REQUIRED — leads the verdict).");
  lines.push("   Quote `substantive_numbers_agree` and `referenced_paths_agree`.");
  lines.push("   If both are true, default to ≈ or ⚠ usability-profile — NOT");
  lines.push("   ❓ Cannot judge. The runs agree on the substantive content;");
  lines.push("   any wording difference is format, not correctness.");
  lines.push("2. **Edit artifacts diff block** (when present).");
  lines.push("   `artifacts_identical: true` is the strongest non-LLM quality");
  lines.push("   equivalence signal we can produce. Quote it. If true, the");
  lines.push("   verdict should be ≈ or ⚠ usability-profile.");
  lines.push("   `artifacts_identical: false` with `status: differ` rows means");
  lines.push("   the runs wrote different bytes — flag which files differ.");
  lines.push("3. **Depth-of-change signals** in the Edit artifacts diff:");
  lines.push("   `total_edit_calls`, `total_bytes_written`, and especially");
  lines.push("   `paths_with_edit_count_mismatch`. If one run made significantly");
  lines.push("   more edits to the same file (e.g. 12 vs 8 partial-replace");
  lines.push("   calls to one doc), that is a **coverage/thoroughness signal**:");
  lines.push("   the higher-count run likely updated more locations. When the");
  lines.push("   user's goal was \"add documentation\", \"update all callers\",");
  lines.push("   \"fix every occurrence\" or similar coverage-shaped tasks, lean");
  lines.push("   toward ✅ for the run with more edits and call out the gap");
  lines.push("   explicitly (e.g. \"A made 12 edits across foo.md; B made 8 —");
  lines.push("   B likely missed 4 locations\"). Do NOT use this rule when the");
  lines.push("   task is shaped like \"add ONE function\" or \"fix THIS bug\" —");
  lines.push("   there, more edits to the same file is churn, not coverage.");
  lines.push("4. **Final responses block** — the full text of both finals is");
  lines.push("   shipped (up to 4000 chars each). Read it. Quote specific");
  lines.push("   fragments to support each verdict.");
  lines.push("5. **Format counts** (tables, bullets, code blocks, headings) —");
  lines.push("   use to describe usability profile divergence concretely.");
  lines.push("");
  lines.push("Hard rules:");
  lines.push("- Do not infer quality from cost.");
  lines.push("- If the first user prompts differ between runs, lead with that");
  lines.push("  fact — the runs were not asked the same question.");
  lines.push("- Never claim a cheaper model is \"safe\" based on output");
  lines.push("  equivalence in a single comparison; frame as a hypothesis.");
  lines.push("- \"Final answer text differs\" is not a quality verdict — almost");
  lines.push("  no two runs produce byte-identical output. Judge meaning, not");
  lines.push("  string equality.");
  lines.push("");

  lines.push("### Artifact outcome");
  lines.push("This section is required.");
  lines.push("Compare the actual task outputs, not only the final chat text.");
  lines.push("");
  lines.push("**Lead with the Edit artifacts diff block** (when present). It");
  lines.push("ships per-file content hashes for every edit-tool call on both");
  lines.push("sides. The flags to quote verbatim:");
  lines.push("");
  lines.push("- `artifacts_identical: true` — every file written has matching");
  lines.push("  content hashes on both sides. This is the strongest available");
  lines.push("  ground-truth signal: the runs produced byte-identical");
  lines.push("  artifacts (or, for partial-replace rows, identical change");
  lines.push("  requests — see kind caveat below). Say so plainly and stop");
  lines.push("  hedging on artifact equivalence.");
  lines.push("- `artifacts_identical: false` — at least one file differs, is");
  lines.push("  one-sided, or has unextractable content. List the divergent");
  lines.push("  files with their status (differ / A-only / B-only / unknown).");
  lines.push("- `artifacts_with_extractable_content: N / M` — when N < M,");
  lines.push("  some edits used tools whose args don't carry recognizable");
  lines.push("  content; flag those rows as un-judgeable here.");
  lines.push("- **Read the `Kind` column.** `full-write` ⇒ hash = end-state");
  lines.push("  file bytes, so identical means the runs produced the same");
  lines.push("  file. `partial-replace` ⇒ hash = `oldString → newString`,");
  lines.push("  so identical means both runs proposed the same change at the");
  lines.push("  same location; the resulting file is only byte-identical if");
  lines.push("  the pre-edit state matched. Quote `edit_kind_counts` when");
  lines.push("  framing how strong the equivalence claim is.");
  lines.push("- If the diff block carries the ⚠ partial-replace/patch caveat,");
  lines.push("  repeat it once when stating the verdict — do not promote a");
  lines.push("  partial-replace match to \"byte-identical end state\".");
  lines.push("");
  lines.push("Then use the Behavior diff `same_files_edited` and");
  lines.push("`same_files_referenced` flags. When those agree, say \"both runs");
  lines.push("touched the same files\". When they don't, list which files were");
  lines.push("only in one run.");
  lines.push("");
  lines.push("**Path-anomaly check.** If files-referenced differ, inspect the");
  lines.push("path strings before treating the difference as real:");
  lines.push("");
  lines.push("- If one path looks like a prefix/substring of the other (e.g.");
  lines.push("  `Users/jfhelin/Downloads/Munich3/` vs `Users/jfhelin/Downloads/Munic`),");
  lines.push("  that is almost certainly **telemetry string truncation, not a");
  lines.push("  real different folder**. Flag the row as \"Maybe noise\" in the");
  lines.push("  What changed table and note it here in one line.");
  lines.push("- If the parent directories genuinely differ, say so and");
  lines.push("  recommend inspecting whether one run looked at or wrote to the");
  lines.push("  wrong directory.");
  lines.push("");
  lines.push("Add one plain-English implication, e.g.:");
  lines.push("> Both runs wrote byte-identical artifacts to the same files;");
  lines.push("> the only material difference is what the agent said in chat.");
  lines.push("");
  lines.push("If the Edit artifacts diff block had no rows (no edits");
  lines.push("recorded), or every row was \"unknown (content not in args)\",");
  lines.push("add this caveat verbatim:");
  lines.push("");
  lines.push("> Artifact equivalence cannot be fully verified from this comparison.");
  lines.push("> Files-touched lists are derived from tool arguments, not filesystem");
  lines.push("> snapshots. To strengthen this next time, capture file create/edit/");
  lines.push("> rename/delete lists, content hashes, and any validation output.");
  lines.push("");

  lines.push("### Cost breakdown");
  lines.push("ONE consolidated section covering all cost-related findings.");
  lines.push("Structure as a short paragraph followed by 3–5 bullets — do NOT");
  lines.push("split into Cost outcome / Cost drivers / Fixed overhead / Divergence");
  lines.push("subsections; they overlap and triple-count the same delta.");
  lines.push("");
  lines.push("**Paragraph (2–4 sentences):**");
  lines.push("- Quote the headline delta in cr and (if shown) USD ONCE.");
  lines.push("- State whether the delta is structural (prefix-driven), behavioral");
  lines.push("  (path-driven), or mixed, using the pre-vs-post-divergence split");
  lines.push("  and the prefix-tax projection (\"projection over N calls is +X cr,");
  lines.push("  matching the actual +Y cr within Z cr\").");
  lines.push("- Quote `fixed_overhead_share_a` vs `fixed_overhead_share_b` in one");
  lines.push("  sentence and what it implies for longer multi-call sessions.");
  lines.push("  Quote the interpretation field verbatim if it is conclusive.");
  lines.push("- If a first-divergence point exists, say which primary call index");
  lines.push("  diverged and on what axis. If none, note it and recommend");
  lines.push("  capturing per-call hashes next time.");
  lines.push("");
  lines.push("**Bullets (3–5 bullets, the bucket waterfall):**");
  lines.push("Translate the per-bucket cost delta into developer meaning, e.g.");
  lines.push("\"`<runLabel>` carried a larger system prompt on every call, adding");
  lines.push("+X cr in `system` (+Y%).\" Avoid raw field names. End each bullet");
  lines.push("with the supporting number. Use the bucket vocabulary defined in");
  lines.push("the appendix.");
  lines.push("");
  lines.push("Do not claim the cheaper run is \"better\" here — Output quality and");
  lines.push("Artifact outcome answered that. Do not re-state the headline number");
  lines.push("more than twice in the whole report.");
  lines.push("");

  if (planMode) {
    lines.push("### Did the planned change land?");
    lines.push("Required because the developer provided an experiment plan from");
    lines.push("the prior single-session analysis. For each plan item, give one");
    lines.push("bullet with a verdict prefix:");
    lines.push("");
    lines.push("- ✅ **Landed, effect as expected** — change visible in diff,");
    lines.push("  numbers match predicted direction and magnitude.");
    lines.push("- ✅ **Landed, smaller/larger than expected** — change visible,");
    lines.push("  effect materially different. Quote expected vs observed.");
    lines.push("- ⚠ **Landed with side effect** — change visible but caused an");
    lines.push("  unintended shift (answer divergence, drift, cache pollution).");
    lines.push("- ❌ **Not detectable in the diff** — diff shows no evidence the");
    lines.push("  change was made. Ask the developer to confirm.");
    lines.push("- ❓ **Not measurable from this comparison** — plan asks about");
    lines.push("  something the comparison cannot show (e.g. answer quality");
    lines.push("  without validation data).");
    lines.push("");
    lines.push("Cite the supporting metric in parentheses for each bullet.");
    lines.push("");
  }

  lines.push("### Was the extra cost worth it?");
  lines.push("One short paragraph. Combine the Cost outcome with the Output");
  lines.push("quality and Artifact outcome verdicts. Lead with one of these");
  lines.push("openings, then add a one-sentence **practical decision rule**");
  lines.push("the reader can act on:");
  lines.push("");
  lines.push("- \"Yes, likely.\" — the more expensive run produced a clearly");
  lines.push("  better output or the only working artifact.");
  lines.push("- \"No.\" — the more expensive run produced equivalent output and");
  lines.push("  artifacts; the extra overhead is unjustified.");
  lines.push("- \"Unproven.\" — outputs or artifacts differ but quality was not");
  lines.push("  validated; cannot judge the tradeoff yet.");
  lines.push("- \"Not applicable.\" — cost delta is within noise.");
  lines.push("");
  lines.push("**Cross-reference the Developer levers affected table** when");
  lines.push("writing the decision rule. Concrete actions should target");
  lines.push("levers marked \"✓ yes\" (implicated) — those are the only axes");
  lines.push("this run pair gives evidence about. Do NOT recommend changes to");
  lines.push("levers marked \"—\" (not implicated); call that out as \"this");
  lines.push("comparison does not provide evidence about <lever>\".");
  lines.push("");
  lines.push("Decision-rule example (do not copy verbatim — use real labels):");
  lines.push("> **Unproven.** Treat the more expensive run as a candidate only");
  lines.push("> if its richer final response is intentional and valuable for");
  lines.push("> the downstream consumer. If the goal is just to produce the");
  lines.push("> artifact, the cheaper run is functionally equivalent — but you");
  lines.push("> can't lock that in until the artifacts are diffed.");
  lines.push("");

  lines.push("### Warnings and caveats");
  lines.push("Consolidate ALL blocking and non-blocking caveats here. Do not");
  lines.push("repeat the same caveat (\"final answers differ\", \"quality cannot");
  lines.push("be assumed equivalent\", \"artifact equivalence cannot be verified\")");
  lines.push("in earlier sections — Experiment summary mentions it once, A/B");
  lines.push("verdict reflects it in the recommendation, and this section is");
  lines.push("the full list.");
  lines.push("");
  lines.push("Blocking includes: final answers not equivalent when they were");
  lines.push("expected to be, run drift on identical-by-construction axes,");
  lines.push("different first user prompts, different models when same model was");
  lines.push("expected, cache pollution, missing tools on one side.");
  lines.push("");
  lines.push("Non-blocking includes: telemetry truncation on path strings,");
  lines.push("small output-verbosity deltas, intentional contamination on the");
  lines.push("variable under test (e.g. system prompt changed when system");
  lines.push("prompt is the experiment).");
  lines.push("");
  lines.push("If the inferred hypothesis from file names contradicts what the");
  lines.push("numbers show (e.g. names suggest \"tool defs disabled\" but");
  lines.push("`tool_defs` cost is unchanged), call that out explicitly.");
  lines.push("");
  lines.push("If no caveats apply, say: \"No blocking caveats. The comparison");
  lines.push("is attributable to the technique under test.\"");
  lines.push("");

  lines.push("### What to validate next");
  lines.push("2–4 specific follow-up experiments or measurements. Examples:");
  lines.push("re-run with both caches warmed, re-run with identical first");
  lines.push("prompt, capture artifact hashes and validation output, compare");
  lines.push("generated files against expected output, run the same A/B pair");
  lines.push("across 3–5 similar tasks before generalizing.");
  if (planMode) {
    lines.push("If any plan item came back as ❌ or ❓, the first validation");
    lines.push("step should be re-running with that item explicitly addressed.");
  }
  lines.push("");

  lines.push("## Hard rules (apply to every section)");
  lines.push("");
  lines.push("1. Never treat lower cost as better by itself.");
  lines.push("2. Never treat higher cost as worse if the more expensive run");
  lines.push("   produced better validated output.");
  lines.push("3. If final answers differ and the test was supposed to preserve");
  lines.push("   the answer, that is a blocking caveat — flag it before any");
  lines.push("   recommendation.");
  lines.push("4. If artifacts differ or are unavailable, do not claim output");
  lines.push("   equivalence.");
  lines.push("5. If quality validation is missing, use \"unknown\" rather than");
  lines.push("   guessing.");
  lines.push("6. If the system prompt changed and that was not the intended");
  lines.push("   variable, call the experiment contaminated.");
  lines.push("7. If the system prompt changed and that was the intended");
  lines.push("   variable, explain the cost impact as every-call overhead.");
  lines.push("8. Prefer developer meaning over raw telemetry names.");
  lines.push("9. Always include \"Was the extra cost worth it?\" — even if the");
  lines.push("   answer is \"Not applicable\".");
  lines.push("10. Always include \"Artifact outcome\" — even if the answer is");
  lines.push("    \"not captured\".");
  lines.push("11. Do not invent metrics. If a number is not in the facts");
  lines.push("    block, say it is missing.");
  lines.push("12. \"Final answer text differs\" is not a quality verdict. Almost");
  lines.push("    no two LLM runs produce byte-identical output. Judge");
  lines.push("    substantive meaning (agreement on counts, paths, named");
  lines.push("    entities), not string equality.");
  lines.push("13. Mention each caveat at most twice: once in Experiment summary");
  lines.push("    (or A/B verdict) and once in Warnings and caveats. Do not");
  lines.push("    repeat \"answers differ / quality unproven\" in every section.");
  lines.push("14. The Bottom line, TL;DR action, Evidence-layer A/B verdict, and");
  lines.push("    Was-the-extra-cost-worth-it conclusion MUST agree. If they");
  lines.push("    contradict each other, rewrite until they line up with the");
  lines.push("    Decision support block (the deterministic flags win).");
  lines.push("15. The Bottom line must be one sentence. The TL;DR must be exactly");
  lines.push("    three bullets (cost, quality, action). The action bullet must");
  lines.push("    be one imperative sentence with no hedging.");
  lines.push("16. The lede follows the Lede-picking rule: quality finding wins");
  lines.push("    over cost when artifacts or final-response signals show a");
  lines.push("    concrete correctness gap.");
  if (planMode) {
    lines.push("12. The plan-verification section is required. Do not skip it,");
    lines.push("    even if the plan looks incomplete; mark unmeasurable items");
    lines.push("    as ❓.");
  }
  lines.push("");
  lines.push("Target length: " + (planMode ? "750–1100" : "650–950") + " words. Use bullets and small tables.");
  lines.push("Cite numbers inline; do not duplicate the comparison block.");
  lines.push("");
  lines.push("The comparison block is the source of truth. If your prose seems");
  lines.push("to contradict it, the block wins — rewrite the prose.");
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
  lines.push("- **Attribution confidence** — `high` = comparison is clean (no blocking drift, no cache pollution, same shape and answers); `medium` = some divergence in shape or answers; `low` = blocking drift or cache pollution makes cost deltas unattributable.");
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
