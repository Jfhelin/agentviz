/**
 * Builds a single-string export payload describing one VS Code Copilot Chat
 * session. The output is markdown-framed (so a human can read it) with
 * embedded JSON blocks for per-call numeric arrays and an embedded pricing
 * reference table.
 *
 * Intended use: user clicks a button in AGENTVIZ, this string lands on the
 * clipboard, user pastes it into an LLM chat to get a session analysis
 * report. The structure deliberately mixes:
 *   - markdown prose & tables for human-readable framing
 *   - JSON arrays for the LLM to quote precise numeric facts back at us
 *   - a pricing reference table so the LLM can project alt-model costs
 *     without needing to look anything up externally
 *
 * Truncation strategy: full text for user messages (capped at 2000 chars
 * each), short summary for assistant replies, no tool result bodies. This
 * keeps a typical 9-call session at <12k output tokens while preserving the
 * signal a model needs to evaluate prompting style and tool fit.
 */

import type { CostAnalysis, CostAnalysisCall, CostAnalysisToolCall, CostAnalysisPrompt } from "./copilotChatExportParser";

const USER_MSG_CHAR_CAP = 2000;
const ASSISTANT_PREVIEW_CHAR_CAP = 350;
const COMPACT_LLM_CALL_THRESHOLD = 20;

interface GitHubModelInfo {
  name: string;
  vendor: "OpenAI" | "Anthropic" | "Google" | "GitHub";
  category: "Lightweight" | "Versatile" | "Powerful";
  inputPerMTok: number;
  cachedInputPerMTok: number;
  cacheWritePerMTok?: number;
  outputPerMTok: number;
}

// Snapshot of the GitHub Copilot pricing/category reference page used so the
// LLM can suggest alternatives without leaving the prompt. Sourced from
// https://docs.github.com/en/copilot/reference/copilot-billing/models-and-pricing
// (verified May 2026). All prices are USD per 1M tokens.
const GITHUB_MODEL_CATALOG: GitHubModelInfo[] = [
  { name: "GPT-4.1",          vendor: "OpenAI",    category: "Versatile",   inputPerMTok: 2.00, cachedInputPerMTok: 0.50,  outputPerMTok: 8.00 },
  { name: "GPT-5 mini",       vendor: "OpenAI",    category: "Lightweight", inputPerMTok: 0.25, cachedInputPerMTok: 0.025, outputPerMTok: 2.00 },
  { name: "GPT-5.2",          vendor: "OpenAI",    category: "Versatile",   inputPerMTok: 1.75, cachedInputPerMTok: 0.175, outputPerMTok: 14.00 },
  { name: "GPT-5.2-Codex",    vendor: "OpenAI",    category: "Powerful",    inputPerMTok: 1.75, cachedInputPerMTok: 0.175, outputPerMTok: 14.00 },
  { name: "GPT-5.3-Codex",    vendor: "OpenAI",    category: "Powerful",    inputPerMTok: 1.75, cachedInputPerMTok: 0.175, outputPerMTok: 14.00 },
  { name: "GPT-5.4",          vendor: "OpenAI",    category: "Versatile",   inputPerMTok: 2.50, cachedInputPerMTok: 0.25,  outputPerMTok: 15.00 },
  { name: "GPT-5.4 mini",     vendor: "OpenAI",    category: "Lightweight", inputPerMTok: 0.75, cachedInputPerMTok: 0.075, outputPerMTok: 4.50 },
  { name: "GPT-5.4 nano",     vendor: "OpenAI",    category: "Lightweight", inputPerMTok: 0.20, cachedInputPerMTok: 0.02,  outputPerMTok: 1.25 },
  { name: "GPT-5.5",          vendor: "OpenAI",    category: "Powerful",    inputPerMTok: 5.00, cachedInputPerMTok: 0.50,  outputPerMTok: 30.00 },
  { name: "Claude Haiku 4.5", vendor: "Anthropic", category: "Versatile",   inputPerMTok: 1.00, cachedInputPerMTok: 0.10, cacheWritePerMTok: 1.25,  outputPerMTok: 5.00 },
  { name: "Claude Sonnet 4.5",vendor: "Anthropic", category: "Versatile",   inputPerMTok: 3.00, cachedInputPerMTok: 0.30, cacheWritePerMTok: 3.75,  outputPerMTok: 15.00 },
  { name: "Claude Sonnet 4.6",vendor: "Anthropic", category: "Versatile",   inputPerMTok: 3.00, cachedInputPerMTok: 0.30, cacheWritePerMTok: 3.75,  outputPerMTok: 15.00 },
  { name: "Claude Opus 4.5",  vendor: "Anthropic", category: "Powerful",    inputPerMTok: 5.00, cachedInputPerMTok: 0.50, cacheWritePerMTok: 6.25,  outputPerMTok: 25.00 },
  { name: "Claude Opus 4.6",  vendor: "Anthropic", category: "Powerful",    inputPerMTok: 5.00, cachedInputPerMTok: 0.50, cacheWritePerMTok: 6.25,  outputPerMTok: 25.00 },
  { name: "Claude Opus 4.7",  vendor: "Anthropic", category: "Powerful",    inputPerMTok: 5.00, cachedInputPerMTok: 0.50, cacheWritePerMTok: 6.25,  outputPerMTok: 25.00 },
  { name: "Gemini 2.5 Pro",   vendor: "Google",    category: "Powerful",    inputPerMTok: 1.25, cachedInputPerMTok: 0.125, outputPerMTok: 10.00 },
  { name: "Gemini 3 Flash",   vendor: "Google",    category: "Lightweight", inputPerMTok: 0.50, cachedInputPerMTok: 0.05,  outputPerMTok: 3.00 },
  { name: "Gemini 3.5 Flash", vendor: "Google",    category: "Lightweight", inputPerMTok: 1.50, cachedInputPerMTok: 0.15,  outputPerMTok: 9.00 },
];

function truncate(s: string, cap: number): string {
  if (!s) return "";
  if (s.length <= cap) return s;
  return s.slice(0, cap) + "… [+" + (s.length - cap) + " more chars]";
}

function projectCallCost(call: CostAnalysisCall, model: GitHubModelInfo): number {
  // Re-price the same token shape on a hypothetical alternative model.
  // Cache behavior is assumed to be the same proportion (cache reads stay
  // cache reads). This is a coarse projection -- the alt model might
  // produce more/fewer output tokens or hit cache differently in practice.
  const input = call.fresh || 0;
  const cached = call.cached || 0;
  const cwrite = call.cacheWrite || 0;
  const output = call.output || 0;
  const cWritePrice = model.cacheWritePerMTok != null ? model.cacheWritePerMTok : model.inputPerMTok;
  return (input / 1e6) * model.inputPerMTok
    + (cached / 1e6) * model.cachedInputPerMTok
    + (cwrite / 1e6) * cWritePrice
    + (output / 1e6) * model.outputPerMTok;
}

function classifyModelTier(modelName: string | undefined): "Lightweight" | "Versatile" | "Powerful" | null {
  if (!modelName) return null;
  const lower = modelName.toLowerCase();
  for (const m of GITHUB_MODEL_CATALOG) {
    if (lower.includes(m.name.toLowerCase().replace(/\s+/g, "-"))
        || lower.includes(m.name.toLowerCase().replace(/\s+/g, ""))) {
      return m.category;
    }
  }
  if (lower.includes("opus")) return "Powerful";
  if (lower.includes("sonnet")) return "Versatile";
  if (lower.includes("haiku")) return "Versatile";
  if (lower.includes("gpt-5") && lower.includes("mini")) return "Lightweight";
  if (lower.includes("gpt-5")) return "Versatile";
  if (lower.includes("gpt-4o-mini") || lower.includes("nano")) return "Lightweight";
  return null;
}

function findCatalogModel(modelName: string | undefined): GitHubModelInfo | null {
  if (!modelName) return null;
  const lower = modelName.toLowerCase();
  for (const m of GITHUB_MODEL_CATALOG) {
    const key = m.name.toLowerCase().replace(/\s+/g, "-");
    if (lower.includes(key)) return m;
  }
  return null;
}

/** Pick 3-4 alternative models for projection: chosen + one tier above (if
 * exists) + one tier below + one from a different vendor in same tier.
 * Deduplicated; chosen always listed first. */
function pickAlternatives(chosenModel: string | undefined): GitHubModelInfo[] {
  const chosen = findCatalogModel(chosenModel);
  const out: GitHubModelInfo[] = [];
  const seen = new Set<string>();
  const add = (m: GitHubModelInfo | null | undefined) => {
    if (!m || seen.has(m.name)) return;
    seen.add(m.name);
    out.push(m);
  };
  if (chosen) add(chosen);
  const tierOrder = ["Lightweight", "Versatile", "Powerful"] as const;
  const chosenTierIdx = chosen ? tierOrder.indexOf(chosen.category) : 1;
  // One tier below.
  if (chosenTierIdx > 0) {
    const below = tierOrder[chosenTierIdx - 1];
    add(GITHUB_MODEL_CATALOG.find(m => m.category === below && (!chosen || m.vendor === chosen.vendor)));
    add(GITHUB_MODEL_CATALOG.find(m => m.category === below));
  }
  // One tier above.
  if (chosenTierIdx < tierOrder.length - 1) {
    const above = tierOrder[chosenTierIdx + 1];
    add(GITHUB_MODEL_CATALOG.find(m => m.category === above && (!chosen || m.vendor === chosen.vendor)));
  }
  // Cross-vendor same tier.
  if (chosen) {
    add(GITHUB_MODEL_CATALOG.find(m => m.category === chosen.category && m.vendor !== chosen.vendor));
  }
  return out.slice(0, 4);
}

function detectUnusedTools(prompts: CostAnalysisPrompt[]): {
  offeredAll: Set<string>;
  used: Set<string>;
  unused: string[];
  estimatedUnusedCostUsd: number;
} {
  const offered = new Set<string>();
  const used = new Set<string>();
  let unusedDefChars = 0;
  let callsWithDefs = 0;
  prompts.forEach(p => {
    p.events.forEach(e => {
      if (e.kind === "llm") {
        callsWithDefs += 1;
        (e.toolGroups || []).forEach(g => (g.tools || []).forEach(t => offered.add(t.name)));
      } else if (e.kind === "tool" && e.name) {
        used.add(e.name);
      }
    });
  });
  const unused = Array.from(offered).filter(t => !used.has(t)).sort();
  // Estimate cost: avg ~120 tokens per tool def, summed across all calls
  // that include the tool defs (which is every chat LLM call). Cost is at
  // input rate of the chosen model.
  const PER_TOOL_DEF_TOKENS = 120;
  const totalToolDefTokens = unused.length * PER_TOOL_DEF_TOKENS * callsWithDefs;
  // We don't price here; the caller has the chosen-model price. Just
  // expose the token figure and let the export include the math.
  return {
    offeredAll: offered,
    used,
    unused,
    estimatedUnusedCostUsd: totalToolDefTokens / 1e6 * 5.0, // ~Opus input rate as a worst case; LLM can recompute
  };
}

function aggregateUserMessages(prompts: CostAnalysisPrompt[]): { turn: number; text: string }[] {
  // Each prompt is one user request -> one or more LLM calls. Use
  // prompt index as the turn number for user-facing chronology.
  const out: { turn: number; text: string }[] = [];
  prompts.forEach((p, i) => {
    if (p.userMessage && p.userMessage.trim()) {
      out.push({ turn: i + 1, text: truncate(p.userMessage.trim(), USER_MSG_CHAR_CAP) });
    }
  });
  return out;
}

function shortModelName(name: string | undefined): string {
  if (!name) return "(unknown)";
  return name.replace(/-(\d{8})$/, "").replace(/-\d{8}-v\d+$/, "");
}

function buildPerCallTable(prompts: CostAnalysisPrompt[], compact: boolean): unknown[] {
  const rows: unknown[] = [];
  let turn = 0;
  prompts.forEach(p => {
    p.events.forEach(e => {
      if (e.kind !== "llm") return;
      turn += 1;
      const toolCalls = (e.producedToolCalls || []).length;
      const comp = e.components || { system: 0, tool_defs: 0, history: 0, tool_results: 0, current: 0 };
      const base: Record<string, unknown> = {
        turn,
        model: shortModelName(e.model),
        category: e.category,
        ctx_in: e.promptTokens,
        // Per-component breakdown of the input context (estimated token
        // attribution from char counts of each section in the prompt).
        // Sum approximates ctx_in. Use this to pinpoint which section
        // grew (history vs tool_results vs tool_defs) instead of guessing.
        ctx_components: {
          system: comp.system || 0,
          tool_defs: comp.tool_defs || 0,
          history: comp.history || 0,
          tool_results: comp.tool_results || 0,
          current: comp.current || 0,
        },
        cached: e.cached,
        cache_write: e.cacheWrite,
        out: e.output,
        // Char counts of the three output components. Use to attribute a
        // large `out` number: visible prose vs extended thinking vs JSON
        // tool-call args. ~4 chars per token rough conversion.
        out_breakdown_chars: {
          visible_reply: e.visibleResponseChars || 0,
          thinking: e.thinkingChars || 0,
          tool_args: e.toolArgsChars || 0,
        },
        cost_usd: Number((e.cost || 0).toFixed(4)),
        tool_calls_produced: toolCalls,
        unexpected_cache_miss: e.unexpectedMiss || false,
      };
      if (!compact) {
        base.assistant_preview = truncate((e.responsePreview || "").trim(), ASSISTANT_PREVIEW_CHAR_CAP);
        base.tool_names_produced = (e.producedToolCalls || []).map(t => t.name);
      }
      rows.push(base);
    });
  });
  return rows;
}

function summarizeToolUsage(prompts: CostAnalysisPrompt[]): { name: string; uses: number }[] {
  const counts: Record<string, number> = {};
  prompts.forEach(p => {
    p.events.forEach(e => {
      if (e.kind !== "tool" || !e.name) return;
      counts[e.name] = (counts[e.name] || 0) + 1;
    });
  });
  return Object.keys(counts).sort((a, b) => counts[b] - counts[a]).map(n => ({ name: n, uses: counts[n] }));
}

function fmtUsd(n: number): string {
  if (n >= 0.01) return "$" + n.toFixed(2);
  return "$" + n.toFixed(4);
}

function pct(n: number, d: number): string {
  return d > 0 ? Math.round(100 * n / d) + "%" : "—";
}

export interface BuildOptions {
  /** Human-readable label for the session (used as a header). */
  sessionLabel?: string;
  /** When true, omit per-call assistant previews and tool-name arrays even
   * for short sessions. */
  forceCompact?: boolean;
}

export function buildLlmAnalysisPrompt(analysis: CostAnalysis, opts: BuildOptions = {}): string {
  const totals = analysis.totals;
  const prompts = analysis.prompts;
  const llmCount = totals.llmCalls;
  const compact = !!opts.forceCompact || llmCount > COMPACT_LLM_CALL_THRESHOLD;

  // Aggregate per-model.
  const perModel: Record<string, { calls: number; cost: number; ctx: number; overheadCalls: number; overheadCost: number }> = {};
  let chosenModelName: string | undefined;
  let chosenModelCalls = 0;
  prompts.forEach(p => {
    p.events.forEach(e => {
      if (e.kind !== "llm") return;
      const k = shortModelName(e.model);
      const slot = perModel[k] || { calls: 0, cost: 0, ctx: 0, overheadCalls: 0, overheadCost: 0 };
      if (e.category === "overhead") {
        slot.overheadCalls += 1;
        slot.overheadCost += e.cost || 0;
      } else {
        slot.calls += 1;
        slot.cost += e.cost || 0;
        slot.ctx += e.promptTokens || 0;
        if (slot.calls > chosenModelCalls) {
          chosenModelCalls = slot.calls;
          chosenModelName = e.model;
        }
      }
      perModel[k] = slot;
    });
  });
  const chosenTier = classifyModelTier(chosenModelName);
  const alternatives = pickAlternatives(chosenModelName);

  // Alt-model cost projection (sum over all chat calls; overhead excluded).
  const altCostRows = alternatives.map(alt => {
    let total = 0;
    prompts.forEach(p => p.events.forEach(e => {
      if (e.kind !== "llm" || e.category === "overhead") return;
      total += projectCallCost(e, alt);
    }));
    return { model: alt.name, vendor: alt.vendor, category: alt.category, projected_cost_usd: Number(total.toFixed(4)) };
  });

  // Tool usage.
  const toolUsage = summarizeToolUsage(prompts);
  const unused = detectUnusedTools(prompts);

  // Complexity drift signals.
  const ctxGrowth: number[] = [];
  const toolsPerCall: number[] = [];
  let modelSwitched = false;
  let lastModel: string | undefined;
  prompts.forEach(p => p.events.forEach(e => {
    if (e.kind !== "llm" || e.category === "overhead") return;
    ctxGrowth.push(e.promptTokens || 0);
    toolsPerCall.push((e.producedToolCalls || []).length);
    if (lastModel && e.model && e.model !== lastModel) modelSwitched = true;
    if (e.model) lastModel = e.model;
  }));

  // System anatomy.
  const firstLlm = prompts.flatMap(p => p.events).find(e => e.kind === "llm");
  const chatMode = firstLlm && firstLlm.kind === "llm" ? firstLlm.chatMode : null;
  const skills: string[] = [];
  const instructions: string[] = [];
  prompts.forEach(p => p.events.forEach(e => {
    if (e.kind !== "llm") return;
    (e.skills || []).forEach((s: { name: string }) => { if (s.name && skills.indexOf(s.name) < 0) skills.push(s.name); });
    (e.instructionAttachments || []).forEach((s: { filePath: string }) => {
      const name = (s.filePath || "").split("/").pop() || s.filePath;
      if (name && instructions.indexOf(name) < 0) instructions.push(name);
    });
  }));

  // Build the markdown.
  const lines: string[] = [];
  lines.push("# Copilot session analysis request");
  lines.push("");
  if (opts.sessionLabel) {
    lines.push("> Session: " + opts.sessionLabel);
    lines.push("");
  }
  lines.push("## Instructions for the analyst LLM");
  lines.push("");
  lines.push("You are an expert evaluator of AI coding agent sessions. Below is a structured summary of one VS Code Copilot Chat session. Produce a report following the format below.");
  lines.push("");
  lines.push("**Output format:** Start your reply with `# <session title>` as the very first line — the title IS the heading, do not write 'Session title' as a separate label. Then write sections 2 through 8 using `##` subheadings.");
  lines.push("");
  lines.push("1. **Session title** (the H1): one short line, ≤8 words, describing the actual work done.");
  lines.push("2. **The user's goal** — one paragraph in the user's own framing. Reconstruct from the user messages, not the assistant's interpretation.");
  lines.push("3. **How the agent got there** — 3-5 bullet narrative of the trajectory. Note any backtracking, re-reading, or dead ends.");
  lines.push("4. **Efficiency analysis** — Was anything redundant? Did the model thrash or converge? Cite specific turn numbers. When context jumps or output sizes spike, attribute the cause using `ctx_components` and `out_breakdown_chars` from the per-call JSON — name the specific component (history, tool_results, visible_reply, tool_args, thinking) that grew, do NOT guess.");
  lines.push("5. **What the user could have done differently** — Up to 4 actionable suggestions. For each: rationale, and a *qualitative* savings estimate (large / moderate / small) tied to a specific signal from the facts. Do not invent dollar figures.");
  lines.push("6. **Model fit** — Was the chosen model (" + (chosenModelName ? shortModelName(chosenModelName) : "n/a") + ", category: " + (chosenTier || "unknown") + ") justified? Review the alt-model projections table and judge whether a Lightweight or Versatile model would have produced acceptable results for this task. Use the conversation difficulty as your evidence.");
  lines.push("7. **Auto-mode suitability** — VS Code's Auto mode picks one model based on the first prompt and sticks with it for the session. Score 1-5 (5 = would have worked perfectly, 1 = would have failed) based on whether complexity stayed steady or drifted. Cite the complexity drift signals.");
  lines.push("8. **Unused capacity** — Tools and skills attached but never used. The unused-tools list is pre-computed below. The user CAN selectively disable tools via VS Code's tool picker (the 'Configure Tools' UI in chat), and CAN remove unused skills/instructions from their workspace config. Treat this as actionable. Identify which specific unused tools / skill groups the user could safely turn off for similar future sessions, and what the rough constant overhead cost is.");
  lines.push("");
  lines.push("**Important constraints:**");
  lines.push("- Use ONLY the facts below. Do not invent token counts, dollar figures, or technical details that are not present in the data.");
  lines.push("- When you cite a number, quote it exactly from the facts.");
  lines.push("- When attributing context growth or large outputs, name the specific JSON field (e.g. `ctx_components.tool_results grew from 12,000 to 28,000`) instead of speculating.");
  lines.push("- When something is not determinable from the facts, say so explicitly. Do not guess.");
  lines.push("- Note: reasoning-token counts are NOT included in this data — do not comment on reasoning effort.");
  lines.push("- Keep the report under 1500 words.");
  lines.push("");
  lines.push("---");
  lines.push("");
  lines.push("## Session at a glance");
  lines.push("");
  lines.push("| metric | value |");
  lines.push("|---|---|");
  lines.push("| primary model | " + (chosenModelName ? shortModelName(chosenModelName) : "n/a") + " (" + (chosenTier || "unknown") + " tier) |");
  lines.push("| chat LLM calls | " + (totals.llmCalls - Object.values(perModel).reduce((a, v) => a + v.overheadCalls, 0)) + " |");
  lines.push("| overhead LLM calls | " + Object.values(perModel).reduce((a, v) => a + v.overheadCalls, 0) + " (title gen, categorization, telemetry) |");
  lines.push("| tool executions | " + totals.toolCalls + " |");
  lines.push("| total cost | " + fmtUsd(totals.cost) + " |");
  lines.push("| billed input tokens | " + totals.promptTokens.toLocaleString() + " (" + pct(totals.cached, totals.promptTokens) + " cached) |");
  lines.push("| output tokens | " + totals.output.toLocaleString() + " |");
  if (totals.unexpectedMissCount > 0) {
    lines.push("| unexpected cache misses | " + totals.unexpectedMissCount + " (wasted ~" + fmtUsd(totals.unexpectedMissCost) + ") |");
  }
  lines.push("");
  lines.push("## Models used (with cost share)");
  lines.push("");
  lines.push("| model | role | calls | cost | % chat cost |");
  lines.push("|---|---|---|---|---|");
  const chatCostTotal = Object.values(perModel).reduce((a, v) => a + v.cost, 0);
  Object.keys(perModel).sort((a, b) => (perModel[b].cost + perModel[b].overheadCost) - (perModel[a].cost + perModel[a].overheadCost)).forEach(name => {
    const v = perModel[name];
    if (v.calls > 0) {
      lines.push("| " + name + " | chat | " + v.calls + " | " + fmtUsd(v.cost) + " | " + pct(v.cost, chatCostTotal) + " |");
    }
    if (v.overheadCalls > 0) {
      lines.push("| " + name + " | overhead | " + v.overheadCalls + " | " + fmtUsd(v.overheadCost) + " | — |");
    }
  });
  lines.push("");
  lines.push("## Alt-model cost projection");
  lines.push("");
  lines.push("Same token shape this session produced, re-priced on each candidate model. Cache reads, cache writes, and output assumed to follow the same proportions (a coarse projection — a different model might produce more or fewer output tokens in practice).");
  lines.push("");
  lines.push("| model | vendor | category | projected total cost | delta vs chosen |");
  lines.push("|---|---|---|---|---|");
  const chosenProjection = altCostRows.find(r => r.model === findCatalogModel(chosenModelName)?.name);
  const chosenCost = chosenProjection ? chosenProjection.projected_cost_usd : totals.cost;
  altCostRows.forEach(r => {
    const delta = r.projected_cost_usd - chosenCost;
    const deltaPct = chosenCost > 0 ? Math.round(100 * delta / chosenCost) : 0;
    const tag = r.model === findCatalogModel(chosenModelName)?.name ? " **(chosen)**" : "";
    lines.push("| " + r.model + tag + " | " + r.vendor + " | " + r.category + " | " + fmtUsd(r.projected_cost_usd) + " | " + (delta >= 0 ? "+" : "") + fmtUsd(delta) + " (" + (deltaPct >= 0 ? "+" : "") + deltaPct + "%) |");
  });
  lines.push("");
  lines.push("## GitHub Copilot model pricing reference");
  lines.push("");
  lines.push("For category tiers (Lightweight / Versatile / Powerful) and current per-token rates of any model not in the alt-projection table above, consult: https://docs.github.com/en/copilot/reference/copilot-billing/models-and-pricing");
  lines.push("");
  lines.push("## System prompt anatomy");
  lines.push("");
  lines.push("- **Custom chat mode:** " + (chatMode ? chatMode.name + " (~" + (chatMode.tokensEst || 0).toLocaleString() + " tok)" : "(none)"));
  lines.push("- **Attached skills:** " + (skills.length > 0 ? skills.join(", ") : "(none)"));
  lines.push("- **Attached instructions:** " + (instructions.length > 0 ? instructions.join(", ") : "(none)"));
  lines.push("");
  lines.push("## Tools offered vs used");
  lines.push("");
  lines.push("- **Tools offered to model:** " + unused.offeredAll.size);
  lines.push("- **Tools actually used:** " + unused.used.size);
  lines.push("- **Unused tools (definitions in every prompt, never called):**");
  if (unused.unused.length === 0) {
    lines.push("  - (none — every offered tool was used at least once)");
  } else {
    unused.unused.forEach(t => lines.push("  - `" + t + "`"));
    lines.push("");
    lines.push("Rough estimate: ~120 tokens per tool definition × " + unused.unused.length + " unused × " + llmCount + " calls = ~" + Math.round(unused.unused.length * 120 * llmCount / 1000) + "k tokens of definition shipped but never invoked. The user can selectively disable these via VS Code's 'Configure Tools' chat UI, which removes them from every future call's prompt.");
  }
  lines.push("");
  lines.push("### Tools actually called (with frequency)");
  lines.push("");
  if (toolUsage.length === 0) {
    lines.push("(none)");
  } else {
    lines.push("| tool | uses |");
    lines.push("|---|---|");
    toolUsage.forEach(t => lines.push("| `" + t.name + "` | " + t.uses + " |"));
  }
  lines.push("");
  lines.push("## Complexity drift signals (for auto-mode judgement)");
  lines.push("");
  lines.push("```json");
  lines.push(JSON.stringify({
    chat_call_count: ctxGrowth.length,
    model_switched_mid_session: modelSwitched,
    context_growth_tokens_per_call: ctxGrowth,
    tool_calls_per_turn: toolsPerCall,
  }, null, 2));
  lines.push("```");
  lines.push("");
  lines.push("## User messages (chronological, full text)");
  lines.push("");
  const userMsgs = aggregateUserMessages(prompts);
  userMsgs.forEach(m => {
    lines.push("### Turn " + m.turn);
    lines.push("");
    lines.push("```");
    lines.push(m.text);
    lines.push("```");
    lines.push("");
  });
  lines.push("## Per-call breakdown");
  lines.push("");
  if (compact) {
    lines.push("_Session has " + llmCount + " LLM calls; using compact mode (no assistant previews)._");
    lines.push("");
  }
  lines.push("```json");
  lines.push(JSON.stringify(buildPerCallTable(prompts, compact), null, 2));
  lines.push("```");
  lines.push("");
  lines.push("---");
  lines.push("");
  lines.push("End of facts. Produce the 8-section report now.");
  lines.push("");
  return lines.join("\n");
}

// Helper for tests / debugging: returns a brief summary of what would be in
// the export without producing the full string. Useful for asserting the
// shape without coupling tests to exact prose.
export function describeExportShape(analysis: CostAnalysis): {
  userMessageCount: number;
  llmCallCount: number;
  toolCallCount: number;
  unusedToolCount: number;
  altModelCount: number;
} {
  const u = detectUnusedTools(analysis.prompts);
  return {
    userMessageCount: aggregateUserMessages(analysis.prompts).length,
    llmCallCount: analysis.totals.llmCalls,
    toolCallCount: analysis.totals.toolCalls,
    unusedToolCount: u.unused.length,
    altModelCount: pickAlternatives(undefined).length,
  };
}
