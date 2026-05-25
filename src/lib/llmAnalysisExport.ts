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
  // Custom chat mode active on the first chat call (if any). Auto mode's
  // model picker is assumed (per project convention) to read the chat mode's
  // system prompt in addition to the user message, so a present chat mode
  // gives Auto far more complexity signal than the literal user message
  // alone -- which neutralises the 'short first prompt' drift signal.
  const firstChatMode = firstChat ? firstChat.chatMode : null;
  const driftSignals: string[] = [];
  if (firstPromptChars < 200 && !firstChatMode) driftSignals.push("short first prompt (" + firstPromptChars + " chars) gives Auto very little signal");
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
  lines.push("You are evaluating one VS Code Copilot Chat session for cost efficiency AND developer workflow efficiency. The data below is structured and pre-computed where possible. Your job is to explain where the money went, what caused it (developer behavior vs agent behavior vs unavoidable task complexity), and what the user should change next time.");
  lines.push("");
  lines.push("**Critical framing:** This session may have used a custom chat mode, custom agent, repo instructions, or skills. **Do not treat the visible user prompt as the full task definition** when the structured-facts block declares a custom chat mode or repo instructions were active. Use `effective_prompt_context` and `developer_behavior_signals` to judge prompt quality, model fit, and Auto-mode fit. The single field `developer_behavior_signals.effective_prompt_specificity` is the one to cite -- not `visible_prompt_specificity`.");
  lines.push("");
  lines.push("**Output format:** Start your reply with `# <session title>` as the very first line (the title IS the H1 -- do not write 'Session title' as a separate label). Then use `##` subheadings for the sections below. Keep the whole report under 900 words. Be specific, not narrative. Quote field paths from the JSON facts when citing numbers.");
  lines.push("");
  lines.push("Sections, in this order:");
  lines.push("");
  lines.push("1. **TL;DR** (~5 lines, write LAST but place FIRST): one-line story of what the user was doing, then top 3 cost levers as bullets with $ or % impact pulled from `optimization_opportunities.top_cost_levers`.");
  lines.push("2. **What the user was trying to do** -- 1-2 sentences using `effective_prompt_context.visible_user_prompt` in the user's own framing.");
  lines.push("3. **Effective task definition** -- 2-3 sentences. If `effective_prompt_context.custom_chat_mode_name` is present, describe the combined task shape (visible prompt + chat mode constraints). Cite `effective_prompt_context.effective_task_definition_note`. If no chat mode, say so explicitly.");
  lines.push("4. **How the agent actually executed the work** -- 3-4 bullets. Cite tool usage (`tool_usage.tools_used`, `tool_usage.execution_counts_by_name`) and notable per-call events. Note any backtracking or pivots.");
  lines.push("5. **Where the money went** -- 3-5 bullets. For each cost driver, cite the specific JSON field path and translate it into a savings opportunity. Use `ctx_components_chars.*` (not `ctx_components.*`) when discussing context growth, since the scaled token attributions can mislead. Cross-reference `agent_behavior_signals.largest_thinking_spike` for output spikes.");
  lines.push("6. **Developer-action findings** -- 2-3 bullets. Use `developer_behavior_signals` to attribute cause. **Do NOT blame the visible user prompt for vagueness if `developer_behavior_signals.effective_prompt_specificity == 'high'`** -- in that case the chat mode supplied the task shape and the better fix is to improve the chat mode, not lengthen the prompt. Quote `developer_behavior_signals.recommended_setup_home` verbatim.");
  lines.push("7. **Prompt/setup changes for next time** -- Up to 3 concrete changes. For each: (a) one-line rationale citing a JSON field, (b) qualitative impact (large / moderate / small), (c) **venue tag** in square brackets from the venue guide below, (d) copy-pasteable **snippet** in a fenced code block. Prefer venues from `developer_behavior_signals.recommended_setup_home` when applicable.");
  lines.push("8. **Tool and skill hygiene** -- Two short paragraphs. (a) Tools: cite `tool_usage.unused_tool_definition_pct_of_session` and name 2-3 specific unused tools to disable. (b) Skills: cite `skill_usage.unused_skills_pct_of_session` and name the 2-3 largest unused skills from `skill_usage.skills` (filter by `used: false`).");
  lines.push("9. **Model and Auto-mode fit** -- One paragraph. Cite `auto_mode_data.verdict` verbatim, then `auto_mode_data.drift_signals` and `auto_mode_data.chat_mode_present_for_picker`. Quote the cost from `auto_mode_data.recommended_estimate_to_quote`. Then 1-2 sentences on `model_fit_data` -- whether the chosen tier was right and whether `model_fit_data.alt_model_projections` shows a realistic cheaper alternative.");
  lines.push("10. **What should be automated or scripted** -- 1-2 sentences. If `agent_behavior_signals.avg_tool_args_chars_per_chat_call` is high, or the same tool name dominates `tool_usage.execution_counts_by_name`, the workflow is a candidate for a deterministic script. State it explicitly or say 'no strong script-candidate signal'.");
  lines.push("11. **Missing or uncertain data** -- list `missing_data` verbatim. This protects the user from over-confident conclusions.");
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
  lines.push("**Venue guide for section 5 suggestions (choose the right home for each fix):**");
  lines.push("- `[inline prompt]` -- one-off fix the user types into the next prompt. Good for output-shape constraints (\"reply in <=5 bullets\", \"output only the filename\") and for narrowing scope on this specific task.");
  lines.push("- `[AGENTS.md]` or `[.github/copilot-instructions.md]` -- repo-level instructions auto-attached to every chat in this workspace. Good for project-wide conventions (file naming, tool preferences, output format defaults).");
  lines.push("- `[custom skill: SKILL.md]` -- a packaged capability the agent loads on demand. Good when the same multi-step workflow recurs across sessions (e.g. \"receipt processing\": OCR -> extract -> rename per schema).");
  lines.push("- `[custom chat mode: .chatmode.md]` -- a scoped persona with its own system prompt and tool whitelist. Good when an entire kind of session benefits from a restricted toolset and stricter output rules.");
  lines.push("- `[VS Code setting: Configure Tools]` -- disable individual tools the user does not need for similar tasks. Cheapest fix when the cost-lever block flags unused tools or skills.");
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
  // Project convention: assume Auto's model picker reads the custom chat
  // mode's system prompt in addition to the user message, so a present
  // chat mode gives Auto strong complexity signal even if the user prompt
  // itself is terse. The 'short first prompt' drift signal is suppressed
  // when a chat mode is attached.
  {
    const chatModeNote = firstChatMode
      ? "A custom chat mode (`" + firstChatMode.name + "`, ~" + (firstChatMode.tokensEst || 0).toLocaleString() + " tok) was active on the first chat call. Per project assumption, Auto's model picker reads the chat mode prompt in addition to the user message, so it had explicit task-shape signal even with a terse user prompt."
      : "No custom chat mode was active, so Auto only saw the literal user message (" + firstPromptChars.toLocaleString() + " chars).";
    const fitLine = "- **Auto-mode fit verdict (pre-computed):** **" + autoFitLabel + "**. "
      + chatModeNote + " "
      + "Auto then reuses that pick for every subsequent turn. "
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
  // Top expensive call composition: surface the WHY (dominant output slice
  // + tools called) for the single most expensive call. Lets the analyst
  // explain the cost cause in plain language ("agent wrote a verbose
  // intermediate artifact", "agent deliberated heavily") instead of
  // re-deriving it from raw per-call rows.
  {
    let top: (CostAnalysisCall & { kind: "llm" }) | null = null;
    let topTurn = 0;
    let t = 0;
    chatEvents.forEach((e) => {
      t += 1;
      if (!top || (e.cost || 0) > (top.cost || 0)) { top = e; topTurn = t; }
    });
    if (top !== null) {
      // Re-narrow inside the block so the inferred CostAnalysisCall fields
      // are visible to TypeScript without the outer let-binding nullability.
      const topCall = top as CostAnalysisCall & { kind: "llm" };
      const vis = topCall.visibleResponseChars || 0;
      const think = topCall.thinkingChars || 0;
      const toolArgs = topCall.toolArgsChars || 0;
      const total = vis + think + toolArgs;
      const dominant = total > 0
        ? (think >= vis && think >= toolArgs
          ? { name: "thinking", pct: Math.round(think * 100 / total), interp: "deliberation-heavy: model spent most of its output budget on internal reasoning. Hard to address at the prompt level on most models; on models where reasoning effort is configurable, lower the effort. On models with hidden thinking (Anthropic extended thinking), instruct the model to think briefly or skip extended thinking for routine subtasks." }
          : vis >= toolArgs
          ? { name: "visible_reply", pct: Math.round(vis * 100 / total), interp: "verbose prose response: the model wrote a long human-readable message. Direct prompt-level fix candidate -- add an explicit output-shape constraint (e.g. 'reply in <=5 bullets', 'output only the final filename, no explanation')." }
          : { name: "tool_args", pct: Math.round(toolArgs * 100 / total), interp: "the model constructed very large tool inputs (likely pasting long content into a tool call). Look for a tool with a smaller-input alternative, or have the agent reference files by path instead of inlining their contents." })
        : { name: "(unknown)", pct: 0, interp: "no output breakdown available." };
      // What tools did the call actually invoke next? Helps pinpoint
      // whether the cost was the response itself or downstream work.
      const toolNames = (topCall.producedToolCalls || []).map(tc => tc.name);
      const toolCounts = new Map<string, number>();
      toolNames.forEach(n => toolCounts.set(n, (toolCounts.get(n) || 0) + 1));
      const toolSummary = toolCounts.size > 0
        ? Array.from(toolCounts.entries()).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([n, c]) => "`" + n + "`" + (c > 1 ? " x" + c : "")).join(", ")
        : "no tool calls (response only)";
      const topPct = totals.cost > 0 ? (topCall.cost / totals.cost) * 100 : 0;
      lines.push("- **Top expensive call composition:** Turn " + topTurn + " cost **" + fmtUsd(topCall.cost) + " (" + topPct.toFixed(0) + "% of session)**, output " + topCall.output.toLocaleString() + " tokens. Output dominated by `" + dominant.name + "` (~" + dominant.pct + "% of output chars) -- " + dominant.interp + " Tools called next: " + toolSummary + ".");
    }
  }
  lines.push("");
  lines.push("---");
  lines.push("");
  lines.push("## Structured facts (JSON)");
  lines.push("");
  lines.push("The block below is machine-generated from the session export. The schema follows the project's session-analysis-package contract. Quote field paths (e.g. `effective_prompt_context.custom_agent_name`) when citing numbers. Empty arrays / nulls in `missing_data` declare what the export does not contain.");
  lines.push("");
  // Build the structured facts object.
  const overheadCallCount = Object.values(perModel).reduce((a, v) => a + v.overheadCalls, 0);
  const chatCallCount = totals.llmCalls - overheadCallCount;
  // Effective vs visible prompt distinction. Visible = the user's first
  // chat message. Effective = visible + custom chat mode prompt (when one
  // is attached). The analyst LLM must judge prompt quality on effective,
  // not visible -- otherwise it incorrectly blames the user for a terse
  // prompt when the chat mode already supplied the task shape.
  const visiblePromptLen = firstPromptChars;
  const visibleSpecificity = visiblePromptLen >= 300 ? "high" : visiblePromptLen >= 80 ? "medium" : "low";
  const effectiveSpecificity = firstChatMode ? "high" : visibleSpecificity;
  const specificityReason = firstChatMode
    ? "Visible user prompt was " + visibleSpecificity + " specificity (" + visiblePromptLen + " chars), but the active custom chat mode `" + firstChatMode.name + "` (~" + (firstChatMode.tokensEst || 0).toLocaleString() + " tok) supplied workflow constraints."
    : "No custom chat mode active. Effective prompt specificity equals visible (" + visiblePromptLen + " chars).";
  // Behavior-verbosity averages across chat calls.
  let totalVis = 0, totalThink = 0, totalToolArgs = 0;
  let maxThink = { turn: 0, chars: 0, out: 0, cost: 0 };
  let turnIdx = 0;
  chatEvents.forEach(e => {
    turnIdx += 1;
    const t = e.thinkingChars || 0;
    totalVis += e.visibleResponseChars || 0;
    totalThink += t;
    totalToolArgs += e.toolArgsChars || 0;
    if (t > maxThink.chars) maxThink = { turn: turnIdx, chars: t, out: e.output || 0, cost: e.cost || 0 };
  });
  const callsForAvg = Math.max(chatEvents.length, 1);
  const avgVisible = Math.round(totalVis / callsForAvg);
  const avgThink = Math.round(totalThink / callsForAvg);
  const explanationVerbosity = avgVisible >= 2000 ? "high" : avgVisible >= 500 ? "medium" : "low";
  const deliberationVerbosity = avgThink >= 5000 ? "high" : avgThink >= 1500 ? "medium" : "low";
  // Top cost levers mirrored into structured form so the analyst can quote them.
  const topCostLevers: Record<string, unknown>[] = [];
  if (unusedToolUsd > 0) topCostLevers.push({
    lever: "Disable unused tool definitions",
    evidence: unused.unused.length + " tools / ~" + unused.unusedDefTokensTotal.toLocaleString() + " tokens across calls / ~" + fmtUsd(unusedToolUsd) + " / " + unusedToolPctOfSession.toFixed(1) + "% of session cost",
    estimated_impact: unusedToolPctOfSession >= 10 ? "large" : unusedToolPctOfSession >= 3 ? "moderate" : "small",
    recommended_venue: "VS Code Configure Tools UI or custom chat mode tool whitelist",
    snippet: "(disable in VS Code: Settings -> Chat -> Tools, or restrict in `.chatmode.md` `tools:` frontmatter)",
  });
  if (unusedSkillUsd > 0) topCostLevers.push({
    lever: "Remove unused skills from the active skill source",
    evidence: skillCarry.unusedCount + " unused skills / ~" + skillCarry.unusedTokensPerCall.toLocaleString() + " tok per call / ~" + fmtUsd(unusedSkillUsd) + " / " + unusedSkillPctOfSession.toFixed(1) + "% of session cost",
    estimated_impact: unusedSkillPctOfSession >= 10 ? "large" : unusedSkillPctOfSession >= 3 ? "moderate" : "small",
    recommended_venue: "custom agent skills config / VS Code skill profile (depends on where the skills were attached)",
    snippet: "(prune unused skills from whichever surface attached them; the export does not record skill_attachment_source)",
  });
  if (maxThink.chars >= 5000) topCostLevers.push({
    lever: "Constrain extended deliberation on routine work",
    evidence: "Turn " + maxThink.turn + " emitted " + maxThink.chars.toLocaleString() + " chars of thinking / " + maxThink.out.toLocaleString() + " output tokens / " + fmtUsd(maxThink.cost),
    estimated_impact: "moderate",
    recommended_venue: "custom chat mode or custom agent prompt",
    snippet: "For routine extraction, renaming, and batch file operations, think briefly. Reserve extended deliberation for ambiguous receipts or irreversible operations.",
  });
  const facts = {
    session_metadata: {
      session_label: opts.sessionLabel || null,
      primary_model: chosenModelName || null,
      primary_model_tier: chosenTier || null,
      chat_call_count: chatCallCount,
      overhead_call_count: overheadCallCount,
      tool_execution_count: totals.toolCalls,
      total_cost_usd: Number(totals.cost.toFixed(4)),
      total_billed_input_tokens: totals.promptTokens,
      total_cached_input_tokens: totals.cached,
      total_output_tokens: totals.output,
      custom_chat_mode_used: !!firstChatMode,
      repo_instructions_used: instructions.length > 0,
    },
    cost_summary: {
      total_cost_usd: Number(totals.cost.toFixed(4)),
      total_billed_input_tokens: totals.promptTokens,
      total_cached_input_tokens: totals.cached,
      total_cache_write_tokens: totals.cacheWrite,
      total_output_tokens: totals.output,
      chat_call_cost_usd: Number(Object.values(perModel).reduce((a, v) => a + v.cost, 0).toFixed(4)),
      overhead_call_cost_usd: Number(Object.values(perModel).reduce((a, v) => a + v.overheadCost, 0).toFixed(4)),
    },
    effective_prompt_context: {
      visible_user_prompt: firstUserPromptText,
      visible_user_prompt_chars: visiblePromptLen,
      custom_chat_mode_name: firstChatMode ? firstChatMode.name : null,
      custom_chat_mode_tokens_est: firstChatMode ? (firstChatMode.tokensEst || 0) : 0,
      custom_chat_mode_full_text_available: false,
      effective_task_definition_note: firstChatMode
        ? "Combined task is `visible_user_prompt` interpreted under the constraints set by the `" + firstChatMode.name + "` chat mode. Full chat-mode text is NOT in this export; only the name and token weight."
        : "No chat mode active; effective task definition equals the visible user prompt.",
    },
    instruction_sources: {
      custom_chat_mode_tokens: firstChatMode ? (firstChatMode.tokensEst || 0) : 0,
      skills_attached_count: skillCarry.skillCount,
      skills_attached_tokens_per_call: skillCarry.skillTokensPerCall,
      tool_definitions_tokens_per_call_first: firstChat && firstChat.components ? (firstChat.components.tool_defs || 0) : 0,
      repo_instruction_files: instructions,
    },
    tool_usage: {
      tools_offered_count: unused.offeredAll.size,
      tools_used_count: unused.used.size,
      tools_used: Array.from(unused.used).sort(),
      unused_tools: unused.unused,
      unused_tool_definition_cost_usd: Number(unusedToolUsd.toFixed(4)),
      unused_tool_definition_pct_of_session: Number(unusedToolPctOfSession.toFixed(2)),
      total_executions: totals.toolCalls,
      execution_counts_by_name: toolUsage,
    },
    skill_usage: {
      skills_attached_count: skillCarry.skillCount,
      skills_used_count: skillCarry.usedCount,
      skills_unused_count: skillCarry.unusedCount,
      skill_carry_cost_usd: Number(skillCarryUsd.toFixed(4)),
      skill_carry_pct_of_session: Number(skillCarryPctOfSession.toFixed(2)),
      unused_skills_cost_usd: Number(unusedSkillUsd.toFixed(4)),
      unused_skills_pct_of_session: Number(unusedSkillPctOfSession.toFixed(2)),
      skills: skillCarry.skills.map(s => ({
        name: s.name,
        tokens: s.tokens,
        used: s.used,
        evidence: s.used ? "skill file path appeared in at least one tool call's rawArgs" : "skill file path did not appear in any tool call's args",
      })),
      skill_attachment_source: "unknown (not recorded in export)",
    },
    developer_behavior_signals: {
      visible_prompt_length_chars: visiblePromptLen,
      visible_prompt_specificity: visibleSpecificity,
      effective_prompt_specificity: effectiveSpecificity,
      specificity_reason: specificityReason,
      custom_chat_mode_supplied_task_shape: !!firstChatMode,
      recommended_setup_home: firstChatMode
        ? "improve the active custom chat mode (`" + firstChatMode.name + "`) rather than lengthening the user prompt"
        : "add a custom chat mode or repo-level `.github/copilot-instructions.md` for repeatable workflows of this kind",
    },
    agent_behavior_signals: {
      avg_visible_reply_chars_per_chat_call: avgVisible,
      avg_thinking_chars_per_chat_call: avgThink,
      avg_tool_args_chars_per_chat_call: Math.round(totalToolArgs / callsForAvg),
      explanation_verbosity: explanationVerbosity,
      internal_deliberation_verbosity: deliberationVerbosity,
      largest_thinking_spike: maxThink.chars > 0 ? {
        turn: maxThink.turn,
        thinking_chars: maxThink.chars,
        output_tokens: maxThink.out,
        cost_usd: Number(maxThink.cost.toFixed(4)),
      } : null,
      model_switched_mid_session: autoModelSwitched,
      distinct_chat_models: Array.from(distinctChatModels).map(shortModelName),
    },
    model_fit_data: {
      chosen_model: chosenModelName,
      chosen_model_category: chosenTier,
      chosen_cost_usd: Number(totals.cost.toFixed(4)),
      alt_model_projections: altCostRows.map(r => {
        const delta = r.projected_cost_usd - totals.cost;
        const denom = totals.cost || 1;
        return {
          model: r.model,
          vendor: r.vendor,
          category: r.category,
          projected_cost_usd: r.projected_cost_usd,
          delta_pct_vs_chosen: Math.round(100 * delta / denom),
        };
      }),
      projection_caveat: "Same token shape this session produced, re-priced on each candidate. Behavior may differ on a different model (longer/shorter outputs, more/fewer tool calls).",
    },
    auto_mode_data: {
      verdict: autoFitLabel,
      verdict_bucket: autoFitVerdict,
      drift_signals: driftSignals,
      chat_mode_present_for_picker: !!firstChatMode,
      same_model_floor_cost_usd: Number(autoSameModelCost.toFixed(4)),
      same_model_floor_savings_usd: Number(autoSameModelSavings.toFixed(4)),
      same_model_floor_savings_pct: 10,
      optimistic_cheapest_viable_cost_usd: autoOptimalCost != null ? Number(autoOptimalCost.toFixed(4)) : null,
      optimistic_cheapest_viable_model: cheapestAlt ? cheapestAlt.model : null,
      recommended_estimate_to_quote: autoFitVerdict === "good" ? "optimistic_cheapest_viable" : autoFitVerdict === "borderline" ? "same_model_floor (in-between if a mid-tier alt is realistic)" : "same_model_floor",
    },
    optimization_opportunities: {
      top_cost_levers: topCostLevers,
    },
    missing_data: [
      firstChatMode ? "Full custom chat mode prompt text (only name + token weight available)." : null,
      "Per-call workflow phase classification (no reliable heuristic; analyst can group by hand from per-call breakdown if useful).",
      "File inventory / artifacts produced (export does not enumerate files touched per tool call).",
      "Quality and outcome validation (no post-session correction or user-confirmation data).",
      "Per-call rework / retry detection (would require diff/similarity across calls).",
      "Skill attachment source (which surface attached each skill -- custom agent vs global profile vs workspace).",
      "Tool stdout/stderr byte size per individual command (only aggregate tool_results component chars are available).",
      "Reasoning token counts (Copilot does not report these even when the model emits extended thinking).",
    ].filter(Boolean),
  };
  lines.push("```json");
  lines.push(JSON.stringify(facts, null, 2));
  lines.push("```");
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
  lines.push("End of facts. Produce the 11-section report now. Remember: write the TL;DR last but place it first; the very first line of your reply is `# <session title>`.");
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
