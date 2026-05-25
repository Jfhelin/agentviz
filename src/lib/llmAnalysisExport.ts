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
  unusedDefTokensTotal: number;
  callsWithDefs: number;
} {
  const offered = new Set<string>();
  const used = new Set<string>();
  // Track per-tool char weight from toolGroups so unused estimate uses real
  // sizes instead of a 120-tok-each guess.
  const toolCharsByName = new Map<string, number>();
  let callsWithDefs = 0;
  prompts.forEach(p => {
    p.events.forEach(e => {
      if (e.kind === "llm") {
        callsWithDefs += 1;
        (e.toolGroups || []).forEach(g => (g.tools || []).forEach(t => {
          offered.add(t.name);
          // Take max observed size (defs are stable across calls but be safe).
          const prev = toolCharsByName.get(t.name) || 0;
          if (t.chars > prev) toolCharsByName.set(t.name, t.chars);
        }));
      } else if (e.kind === "tool" && e.name) {
        used.add(e.name);
      }
    });
  });
  const unused = Array.from(offered).filter(t => !used.has(t)).sort();
  // ~4 chars per token.
  const unusedCharsPerCall = unused.reduce((a, n) => a + (toolCharsByName.get(n) || 0), 0);
  const unusedTokensPerCall = Math.round(unusedCharsPerCall / 4);
  return {
    offeredAll: offered,
    used,
    unused,
    unusedDefTokensTotal: unusedTokensPerCall * callsWithDefs,
    callsWithDefs,
  };
}

/**
 * Detect which attached skills were actually picked up during the session.
 *
 * Mechanics: VS Code Copilot ships only `<skill>` metadata (name, short
 * description, file path) in the system prompt. When the agent decides a
 * skill is relevant, it calls a file-reading tool with the skill's `file`
 * path to load the full instructions. So if a skill's `file` path appears
 * in ANY tool call's `rawArgs` anywhere in the session, that skill was
 * used. If not, it was carried but never opened — directly attributable
 * waste the user can remove by disabling the skill.
 *
 * Match strategy: substring on the skill's `file` value. The file path in
 * the system prompt is typically absolute (e.g.
 * `/Users/.../.copilot/installed-plugins/foo/skills/bar/SKILL.md`); tool
 * calls may use the same absolute path, a workspace-relative path, or an
 * expanded variant. Substring is the safest match across these variants
 * because skill file paths are long and unique enough to avoid collisions.
 */
function detectUsedSkills(
  prompts: CostAnalysisPrompt[],
  skills: { name: string; file: string }[]
): Set<string> {
  const used = new Set<string>();
  if (skills.length === 0) return used;
  // Pre-filter skills that have a usable file path.
  const candidates = skills.filter(s => s.file && s.file.length > 4);
  if (candidates.length === 0) return used;
  prompts.forEach(p => p.events.forEach(e => {
    let argsBlobs: string[] = [];
    if (e.kind === "llm") {
      (e.producedToolCalls || []).forEach(tc => {
        if (tc && tc.rawArgs) argsBlobs.push(tc.rawArgs);
      });
    } else if (e.kind === "tool") {
      if (e.rawArgs) argsBlobs.push(e.rawArgs);
    }
    if (argsBlobs.length === 0) return;
    const joined = argsBlobs.join("\n");
    candidates.forEach(s => {
      if (used.has(s.name)) return;
      if (joined.includes(s.file)) used.add(s.name);
    });
  }));
  return used;
}

function aggregateSkillCarry(prompts: CostAnalysisPrompt[]): {
  skillCount: number;
  skillTokensPerCall: number;
  totalSkillTokens: number;
  callsWithSkills: number;
  /** Per-skill char + token estimate, sorted descending by size. Lets the
   * analyst LLM name specific large skills as savings candidates. */
  skills: { name: string; tokens: number; file: string; used: boolean }[];
  usedCount: number;
  unusedCount: number;
  unusedTokensPerCall: number;
} {
  // Sample the skill list from the first CHAT (non-overhead) LLM call.
  // The very first LLM event in the session is usually an overhead call
  // (title generation, prompt categorization) which has its own minimal
  // system prompt without the user's skills attached -- sampling from
  // there returned 0 skills even when 35 were configured.
  let charsPerCall = 0;
  let count = 0;
  let chatCalls = 0;
  let skillRows: { name: string; tokens: number; file: string; used: boolean }[] = [];
  let sampled = false;
  let sampledSkills: { name: string; file: string; chars: number }[] = [];
  prompts.forEach(p => p.events.forEach(e => {
    if (e.kind !== "llm" || e.category === "overhead") return;
    chatCalls += 1;
    if (!sampled) {
      sampled = true;
      (e.skills || []).forEach((s: { name: string; chars: number; file?: string }) => {
        charsPerCall += s.chars || 0;
        count += 1;
        sampledSkills.push({ name: s.name, file: s.file || "", chars: s.chars || 0 });
      });
    }
  }));
  const usedSet = detectUsedSkills(prompts, sampledSkills);
  let unusedChars = 0;
  sampledSkills.forEach(s => {
    const used = usedSet.has(s.name);
    if (!used) unusedChars += s.chars;
    skillRows.push({
      name: s.name,
      tokens: Math.round(s.chars / 4),
      file: s.file,
      used,
    });
  });
  // Sort: unused first (so the cost-driver list pops), then by size desc.
  skillRows.sort((a, b) => {
    if (a.used !== b.used) return a.used ? 1 : -1;
    return b.tokens - a.tokens;
  });
  const tokensPerCall = Math.round(charsPerCall / 4);
  const unusedTokensPerCall = Math.round(unusedChars / 4);
  return {
    skillCount: count,
    skillTokensPerCall: tokensPerCall,
    totalSkillTokens: tokensPerCall * chatCalls,
    callsWithSkills: chatCalls,
    skills: skillRows,
    usedCount: usedSet.size,
    unusedCount: count - usedSet.size,
    unusedTokensPerCall,
  };
}

function aggregateUserMessages(prompts: CostAnalysisPrompt[]): { turn: number; text: string }[] {
  // Skip prompts that are entirely overhead (e.g. internal title generation,
  // conversation categorization). Number turns by chat-prompt sequence so
  // the user sees "Turn 1" for their first real request, not "Turn 3"
  // after a couple of overhead calls slipped into the count.
  const out: { turn: number; text: string }[] = [];
  let turn = 0;
  prompts.forEach(p => {
    const hasChatCall = p.events.some(e => e.kind === "llm" && e.category !== "overhead");
    if (!hasChatCall) return;
    turn += 1;
    if (p.userMessage && p.userMessage.trim()) {
      out.push({ turn, text: truncate(p.userMessage.trim(), USER_MSG_CHAR_CAP) });
    }
  });
  return out;
}

function shortModelName(name: string | undefined): string {
  if (!name) return "(unknown)";
  return name.replace(/-(\d{8})$/, "").replace(/-\d{8}-v\d+$/, "");
}

function buildPerCallTable(prompts: CostAnalysisPrompt[], compact: boolean): unknown[] {
  // Only emit CHAT calls. Overhead (title gen, prompt categorization,
  // telemetry) is summarised separately so it doesn't pollute the
  // user-visible turn numbering. Turn N == the user's Nth real request.
  const rows: unknown[] = [];
  let turn = 0;
  prompts.forEach(p => {
    p.events.forEach(e => {
      if (e.kind !== "llm" || e.category === "overhead") return;
      turn += 1;
      const toolCalls = (e.producedToolCalls || []).length;
      const comp = e.components || { system: 0, tool_defs: 0, history: 0, tool_results: 0, current: 0 };
      // Raw character counts for each ctx component, BEFORE the parser
      // scales them to match the model's reported prompt_tokens. Use these
      // to tell whether real change happened or whether attributed-token
      // growth is just a scaling artifact (see hard rule). tool_defs_chars
      // in particular is byte-identical across calls when no new tools or
      // skills are introduced -- if these chars are constant but the
      // attributed token count grows, the growth is purely from rescaling.
      const compChars = e.componentChars || { system: 0, tool_defs: 0, history: 0, tool_results: 0, current: 0 };
      // Tool count for cross-checking tool_defs growth. Copilot Chat
      // dynamically expands the toolset when skills get invoked or new
      // MCP tools are discovered, so tool_defs IS NOT necessarily
      // constant across a session. Compare this count across rows
      // before concluding tool_defs growth is parser noise.
      let toolsOffered = 0;
      (e.toolGroups || []).forEach(g => { toolsOffered += (g.tools || []).length; });
      const base: Record<string, unknown> = {
        turn,
        model: shortModelName(e.model),
        ctx_in: e.promptTokens,
        ctx_components: {
          system: comp.system || 0,
          tool_defs: comp.tool_defs || 0,
          history: comp.history || 0,
          tool_results: comp.tool_results || 0,
          current: comp.current || 0,
        },
        ctx_components_chars: {
          system: compChars.system || 0,
          tool_defs: compChars.tool_defs || 0,
          history: compChars.history || 0,
          tool_results: compChars.tool_results || 0,
          current: compChars.current || 0,
        },
        tools_offered_count: toolsOffered,
        cached: e.cached,
        cache_write: e.cacheWrite,
        out: e.output,
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

  // Pre-compute cost levers so the LLM doesn't have to do arithmetic.
  // We surface them as concrete numbers in a single block; the LLM
  // references them in TL;DR + sections 5 and 8 instead of generating
  // its own estimates.
  const chosenPriceRow = chosenModelName ? findCatalogModel(chosenModelName) : null;
  const chosenInputRate = chosenPriceRow ? chosenPriceRow.inputPerMTok : 0;
  const chosenCachedRate = chosenPriceRow ? chosenPriceRow.cachedInputPerMTok : 0;
  // Unused-tool defs sit in every call's prompt: first call pays cache-write
  // (or fresh), every subsequent call pays cached-read rate. Approximate as
  // one fresh + (N-1) cached.
  const unusedToolFirstCallUsd = (unused.unusedDefTokensTotal / Math.max(unused.callsWithDefs, 1)) / 1e6 * chosenInputRate;
  const unusedToolLaterCallsUsd = (unused.unusedDefTokensTotal / Math.max(unused.callsWithDefs, 1)) / 1e6 * chosenCachedRate * Math.max(unused.callsWithDefs - 1, 0);
  const unusedToolUsd = unusedToolFirstCallUsd + unusedToolLaterCallsUsd;
  const unusedToolPctOfSession = totals.cost > 0 ? (unusedToolUsd / totals.cost) * 100 : 0;

  const skillCarry = aggregateSkillCarry(prompts);
  const skillCarryFirstCallUsd = skillCarry.skillTokensPerCall / 1e6 * chosenInputRate;
  const skillCarryLaterUsd = skillCarry.skillTokensPerCall / 1e6 * chosenCachedRate * Math.max(skillCarry.callsWithSkills - 1, 0);
  const skillCarryUsd = skillCarryFirstCallUsd + skillCarryLaterUsd;
  const skillCarryPctOfSession = totals.cost > 0 ? (skillCarryUsd / totals.cost) * 100 : 0;
  // Unused skills: same per-call math as carry, but scoped to skills whose
  // file path never appeared in any tool call's args. Directly attributable
  // waste — the user can delete these from VS Code's skill config.
  const unusedSkillFirstUsd = skillCarry.unusedTokensPerCall / 1e6 * chosenInputRate;
  const unusedSkillLaterUsd = skillCarry.unusedTokensPerCall / 1e6 * chosenCachedRate * Math.max(skillCarry.callsWithSkills - 1, 0);
  const unusedSkillUsd = unusedSkillFirstUsd + unusedSkillLaterUsd;
  const unusedSkillPctOfSession = totals.cost > 0 ? (unusedSkillUsd / totals.cost) * 100 : 0;

  // Auto mode: VS Code picks ONE model based on the first prompt and applies
  // a 10% discount. Two scenarios: (a) Auto picks the same model the user
  // picked manually — savings is just the 10% discount; (b) Auto picks the
  // cheapest Versatile-tier alt — savings is the alt cost projection × 0.9
  // minus the actual cost.
  const AUTO_DISCOUNT = 0.10;
  const autoSameModelCost = totals.cost * (1 - AUTO_DISCOUNT);
  const autoSameModelSavings = totals.cost - autoSameModelCost;
  // Cheapest alt across ALL tiers (excluding the chosen model itself) —
  // the "best case" Auto mode could deliver if it picked the cheapest
  // viable model for the first prompt. The analyst LLM judges whether
  // that pick is realistic for the task.
  const cheapestAlt = altCostRows
    .filter(r => r.model !== findCatalogModel(chosenModelName)?.name)
    .sort((a, b) => a.projected_cost_usd - b.projected_cost_usd)[0];
  const autoOptimalCost = cheapestAlt ? cheapestAlt.projected_cost_usd * (1 - AUTO_DISCOUNT) : null;
  const autoOptimalSavings = autoOptimalCost != null ? totals.cost - autoOptimalCost : null;

  // Auto-mode fit: Auto picks ONE model based on the FIRST chat prompt and
  // sticks with it. If session complexity drifts upward (later turns produce
  // much larger outputs, chain more tools, or the user manually switched to
  // a heavier model), Auto's first-prompt pick was wrong for the rest. We
  // compute concrete drift signals from the per-call data so the analyst
  // can cite numbers instead of guessing.
  const chatEvents: (CostAnalysisCall & { kind: "llm" })[] = [];
  prompts.forEach(p => p.events.forEach(e => {
    if (e.kind === "llm" && e.category !== "overhead") chatEvents.push(e);
  }));
  const firstChat = chatEvents[0];
  const firstUserPromptText = (function () {
    const um = aggregateUserMessages(prompts);
    return um[0] ? um[0].text : "";
  })();
  const firstPromptChars = firstUserPromptText.length;
  // Output-size escalation: max output token count vs first call's output.
  const firstOut = firstChat ? (firstChat.output || 0) : 0;
  let maxOut = firstOut;
  let maxOutTurn = 1;
  chatEvents.forEach((e, idx) => {
    if ((e.output || 0) > maxOut) { maxOut = e.output || 0; maxOutTurn = idx + 1; }
  });
  const outputEscalationRatio = firstOut > 0 ? maxOut / firstOut : (maxOut > 0 ? Infinity : 1);
  // Tool-call escalation: did later turns chain many more tools than the first?
  const firstToolCalls = firstChat ? ((firstChat.producedToolCalls || []).length) : 0;
  let maxToolCalls = firstToolCalls;
  chatEvents.forEach(e => {
    const tc = (e.producedToolCalls || []).length;
    if (tc > maxToolCalls) maxToolCalls = tc;
  });
  // Model switching: did the user manually change model mid-session?
  const distinctChatModels = new Set(chatEvents.map(e => e.model).filter(Boolean));
  const autoModelSwitched = distinctChatModels.size > 1;
  // Derive a coarse verdict from these signals.
  const driftSignals: string[] = [];
  if (firstPromptChars < 200) driftSignals.push("short first prompt (" + firstPromptChars + " chars) gives Auto very little signal");
  if (outputEscalationRatio >= 3 && maxOut > 1500) driftSignals.push("output escalated " + outputEscalationRatio.toFixed(1) + "x by turn " + maxOutTurn + " (" + firstOut.toLocaleString() + " -> " + maxOut.toLocaleString() + " tokens)");
  if (maxToolCalls >= 5 && firstToolCalls <= 1) driftSignals.push("tool-chain depth grew from " + firstToolCalls + " to " + maxToolCalls + " calls per turn");
  if (autoModelSwitched) driftSignals.push("user manually switched models mid-session (" + Array.from(distinctChatModels).map(shortModelName).join(", ") + ")");
  let autoFitVerdict: "good" | "borderline" | "poor";
  if (driftSignals.length === 0) autoFitVerdict = "good";
  else if (driftSignals.length === 1) autoFitVerdict = "borderline";
  else autoFitVerdict = "poor";
  const autoFitLabel = autoFitVerdict === "good"
    ? "Good fit"
    : autoFitVerdict === "borderline"
    ? "Borderline fit"
    : "Poor fit";

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
  lines.push("You are evaluating one VS Code Copilot Chat session for cost efficiency. The data below is structured and pre-computed where possible. Your job is to interpret it and tell the user where their money went and what to change next time.");
  lines.push("");
  lines.push("**Output format:** Start your reply with `# <session title>` as the very first line (the title IS the H1 — do not write 'Session title' as a separate label). Then use `##` subheadings for the sections below. Keep the whole report under 800 words. Be specific, not narrative.");
  lines.push("");
  lines.push("Sections, in this order:");
  lines.push("");
  lines.push("1. **TL;DR** (~5 lines, write this LAST but place it FIRST):");
  lines.push("    - one-line story of what the user was doing");
  lines.push("    - top 3 cost levers as a bulleted list, each with the specific $ or % impact pulled from the pre-computed facts below");
  lines.push("2. **What the user wanted** — 1-2 sentences, in the user's own framing.");
  lines.push("3. **How it played out** — 3-4 bullets max. Note any backtracking or pivots.");
  lines.push("4. **Where the money went** — Focus on cost. For each notable cost driver, name the specific data field (e.g. `ctx_components.tool_results grew from 12k to 28k between turns 8 and 10`) and translate it into a savings opportunity. Skip purely narrative observations. 3-5 bullets.");
  lines.push("5. **What the user could change** — Up to 3 concrete prompt or setup changes. For each: one-line rationale + qualitative size (large / moderate / small). Reference the pre-computed cost-lever block when possible.");
  lines.push("6. **Model fit** — Was " + (chosenModelName ? shortModelName(chosenModelName) : "the chosen model") + " (" + (chosenTier || "unknown") + " tier) right for this task? 2-3 sentences. Reference the alt-model table.");
  lines.push("7. **Auto-mode verdict** — One line: cite the pre-computed **Auto-mode fit verdict** (Good / Borderline / Poor fit) and the named drift signals verbatim, then quote the realistic cost figure the verdict points you at (floor for Poor, floor or in-between for Borderline, optimistic for Good).");
  lines.push("8. **Unused capacity** — Two short paragraphs. (a) Unused tools: cite the pre-computed `% of session cost` figure, name 2-3 specific tools the user could safely disable in VS Code's Configure Tools UI for similar tasks. (b) Unused skills: cite the pre-computed **Unused skills** figure (`N skills / $X / Y%`) verbatim — that number is detected from the data, not inferred. Name the 2-3 largest unused skills from the System anatomy list as the top removal candidates.");
  lines.push("");
  lines.push("**Hard rules:**");
  lines.push("- Use ONLY the facts below. Quote numbers verbatim.");
  lines.push("- When attributing context growth or output size, name the specific JSON field. Do not speculate.");
  lines.push("- Per-call rows include CHAT calls only — overhead calls (title generation, prompt categorization, telemetry) are summarised separately and should NOT be referenced as user turns.");
  lines.push("- `ctx_components.*` tokens are SCALED estimates: the parser apportions the model's real `prompt_tokens` across components by char share. If `ctx_components_chars.tool_defs` is constant across rows but the attributed `ctx_components.tool_defs` token count grows, that growth is a SCALING ARTIFACT (some other component was under-estimated, inflating all buckets). Always cite `ctx_components_chars.*` first to determine whether real change happened. Copilot Chat CAN dynamically expand the toolset when skills get invoked or new MCP tools are discovered -- you can verify that by comparing `ctx_components_chars.tool_defs` and `tools_offered_count` across rows.");
  lines.push("- We DO detect which skills were USED during the session by matching each skill's `file` path against tool call args. The pre-computed cost-lever block lists the unused-skill count, token cost, and per-skill ✓/✗ markers in System anatomy. Cite those numbers directly — do not re-infer skill usage from prompt context.");
  lines.push("- Reasoning-token counts are NOT in this data. Do not comment on reasoning effort.");
  lines.push("- When the data does not support a claim, say 'not determinable from the data'.");
  lines.push("");
  lines.push("---");
  lines.push("");
  lines.push("## Pre-computed cost levers (cite these in TL;DR + sections 5, 7, 8)");
  lines.push("");
  lines.push("- **Unused tool definitions:** " + unused.unused.length + " tools / ~" + unused.unusedDefTokensTotal.toLocaleString() + " tokens shipped across all calls / **~" + fmtUsd(unusedToolUsd) + " (" + unusedToolPctOfSession.toFixed(1) + "% of session cost)** at chosen-model rates (1 fresh + " + Math.max(unused.callsWithDefs - 1, 0) + " cached). User can disable per-tool in VS Code's Configure Tools UI.");
  lines.push("- **Skill carry overhead:** " + skillCarry.skillCount + " skills attached (" + skillCarry.usedCount + " used, " + skillCarry.unusedCount + " unused) / ~" + skillCarry.skillTokensPerCall.toLocaleString() + " tokens per call / **~" + fmtUsd(skillCarryUsd) + " (" + skillCarryPctOfSession.toFixed(1) + "% of session cost)** at chosen-model rates.");
  lines.push("- **Unused skills (directly removable):** " + skillCarry.unusedCount + " skills / ~" + skillCarry.unusedTokensPerCall.toLocaleString() + " tokens per call / **~" + fmtUsd(unusedSkillUsd) + " (" + unusedSkillPctOfSession.toFixed(1) + "% of session cost)** at chosen-model rates (1 fresh + " + Math.max(skillCarry.callsWithSkills - 1, 0) + " cached). Detected by checking whether each attached skill's `file` path appears in any tool call's args anywhere in the session — skills marked unused were carried in every system prompt but never opened.");
  lines.push("- **Auto-mode floor (same model):** Auto applies a flat 10% discount on model rates. If Auto picked the same model, session cost would be ~" + fmtUsd(autoSameModelCost) + " (save ~" + fmtUsd(autoSameModelSavings) + ", 10%). This is the conservative lower-bound estimate.");
  if (autoOptimalCost != null && cheapestAlt && autoOptimalSavings != null && autoOptimalSavings > 0) {
    const altPct = totals.cost > 0 ? (autoOptimalSavings / totals.cost) * 100 : 0;
    lines.push("- **Auto-mode optimistic (cheapest viable pick):** Auto picks a model from the first prompt and applies 10% off. If Auto picked the cheapest model in the alt-projection table (" + cheapestAlt.model + ", " + cheapestAlt.category + " tier), projected ~" + fmtUsd(autoOptimalCost) + " (save ~" + fmtUsd(autoOptimalSavings) + ", " + altPct.toFixed(0) + "%). Judge whether " + cheapestAlt.category + "-tier is realistic for this task before quoting this number — if the task needed a Versatile or Powerful model, the realistic Auto cost is between the floor and this figure.");
  }
  // Auto-mode fit verdict: would Auto's first-prompt pick have served the
  // whole session, or did complexity drift make the first guess wrong?
  {
    const fitLine = "- **Auto-mode fit verdict (pre-computed):** **" + autoFitLabel + "**. "
      + "Auto picks a model from the first user prompt only (" + firstPromptChars.toLocaleString() + " chars) and reuses it for every subsequent turn. "
      + (driftSignals.length === 0
        ? "No complexity-drift signals detected (output size, tool-chain depth, and model choice stayed stable across turns), so Auto's first-prompt pick would have served the whole session. Quote this verdict directly in section 7."
        : "Drift signals detected: " + driftSignals.map(s => "(" + s + ")").join("; ") + ". "
          + (autoFitVerdict === "poor"
            ? "Auto's first-prompt pick would likely have under-served the later turns -- the Auto-optimistic cost figure above is unrealistic for this session. Quote this verdict directly in section 7."
            : "Auto's first-prompt pick was probably workable but not optimal -- use the same-model floor figure above as the realistic estimate, not the optimistic one. Quote this verdict directly in section 7."));
    lines.push(fitLine);
  }
  if (totals.unexpectedMissCount > 0) {
    lines.push("- **Unexpected cache misses:** " + totals.unexpectedMissCount + " calls / wasted **~" + fmtUsd(totals.unexpectedMissCost) + " (" + (totals.cost > 0 ? (totals.unexpectedMissCost / totals.cost * 100).toFixed(1) : "0") + "% of session cost)**. See per-call rows with `unexpected_cache_miss: true`.");
  }
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
  lines.push("Same token shape this session produced, re-priced on each candidate. Coarse projection — a different model might produce more or fewer output tokens in practice. Numbers DO NOT include Auto mode's 10% discount; subtract another 10% to model that.");
  lines.push("");
  lines.push("| model | vendor | category | projected cost | delta vs chosen |");
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
  lines.push("Tier reference: https://docs.github.com/en/copilot/reference/copilot-billing/models-and-pricing");
  lines.push("");
  lines.push("## System prompt anatomy");
  lines.push("");
  lines.push("- **Custom chat mode:** " + (chatMode ? chatMode.name + " (~" + (chatMode.tokensEst || 0).toLocaleString() + " tok)" : "(none)"));
  lines.push("- **Attached skills (" + skillCarry.skillCount + " total, " + skillCarry.usedCount + " ✓ used / " + skillCarry.unusedCount + " ✗ unused, ~" + skillCarry.skillTokensPerCall.toLocaleString() + " tok per call):**");
  if (skillCarry.skills.length === 0) {
    lines.push("  - (none attached on the first chat call)");
  } else {
    // Show top 10 by size (unused first thanks to the sort) with a summary line for the rest.
    const top = skillCarry.skills.slice(0, 10);
    const rest = skillCarry.skills.slice(10);
    top.forEach(s => lines.push("  - " + (s.used ? "✓" : "✗") + " `" + s.name + "` — ~" + s.tokens.toLocaleString() + " tok"));
    if (rest.length > 0) {
      const restTok = rest.reduce((a, s) => a + s.tokens, 0);
      const restUnused = rest.filter(s => !s.used).length;
      const restUnusedTok = rest.filter(s => !s.used).reduce((a, s) => a + s.tokens, 0);
      lines.push("  - … " + rest.length + " more skills (~" + restTok.toLocaleString() + " tok combined; of those " + restUnused + " unused / ~" + restUnusedTok.toLocaleString() + " tok)");
    }
  }
  lines.push("- **Attached instructions:** " + instructions.length + (instructions.length > 0 ? " (" + instructions.slice(0, 4).join(", ") + (instructions.length > 4 ? ", …" : "") + ")" : ""));
  lines.push("");
  lines.push("## Tools offered vs used");
  lines.push("");
  lines.push("- **Tools offered to model:** " + unused.offeredAll.size);
  lines.push("- **Tools actually used:** " + unused.used.size + " — `" + Array.from(unused.used).sort().join("`, `") + "`");
  if (unused.unused.length > 0) {
    // Show all unused names but inline (one line) to save space.
    lines.push("- **Unused (" + unused.unused.length + "):** `" + unused.unused.join("`, `") + "`");
  } else {
    lines.push("- **Unused:** (none)");
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
