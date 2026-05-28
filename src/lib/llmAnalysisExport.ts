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
import type { ToolDefinitionShapeAnalysis, ToolDefinitionClassification } from "./toolDefinitionShape";
import type { McpReachabilityAnalysis } from "./mcpServerReachability";

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
// (verified May 2025). All prices are USD per 1M tokens.
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

export function detectUnusedTools(prompts: CostAnalysisPrompt[]): {
  offeredAll: Set<string>;
  used: Set<string>;
  unused: string[];
  unusedTokensPerCall: number;
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
    unusedTokensPerCall,
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

export function aggregateSkillCarry(prompts: CostAnalysisPrompt[]): {
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
  // Sample the skill list from the LLM call that carries the MOST skills.
  // Originally we sampled from the first non-overhead LLM event, but that
  // is fragile: the first chat call can be a lightweight session-start
  // request that ships an empty skills array, even when every later call
  // in the same session attaches the user's full skill set. Skill lists
  // don't shrink across a session, so the per-call maximum is the steady
  // state and survives both kinds of false-empty early calls (overhead
  // title-gen and lightweight kickoff requests).
  let charsPerCall = 0;
  let count = 0;
  let chatCalls = 0;
  let skillRows: { name: string; tokens: number; file: string; used: boolean }[] = [];
  let sampledSkills: { name: string; file: string; chars: number }[] = [];
  prompts.forEach(p => p.events.forEach(e => {
    if (e.kind !== "llm" || e.category === "overhead") return;
    chatCalls += 1;
    const skills = (e.skills || []) as { name: string; chars: number; file?: string }[];
    if (skills.length > sampledSkills.length) {
      sampledSkills = skills.map(s => ({ name: s.name, file: s.file || "", chars: s.chars || 0 }));
    }
  }));
  charsPerCall = sampledSkills.reduce((a, s) => a + (s.chars || 0), 0);
  count = sampledSkills.length;
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
  /** Reserved for baseline comparison wiring (Compare-view integration).
   * Currently only the truthy/falsy flag is consumed. */
  baseline?: { sessionLabel?: string } | null;
  /** Intended experiment setup, used to detect run-vs-intent mismatches.
   * Each field is optional; only provided fields are checked. */
  expected?: {
    chatModeName?: string;
    customAgentName?: string;
    modelName?: string;
    toolWhitelist?: string[];
  };
  /** Surfaces the developer cannot modify (e.g. ["model_selector", "ide_tools"]).
   * Recommendations on these surfaces are demoted to external/fixed overhead. */
  outOfScopeSurfaces?: string[];
  /** Default `developer_action_report` produces a lighter ~600-word
   * developer-focused report. `detailed_audit` keeps the heavier
   * 12-section schema-shaped report for in-depth audits. */
  reportMode?: "developer_action_report" | "detailed_audit";
}

/** Build the `tool_definition_shape_analysis` JSON block that ships inside
 *  the structured facts. `ide_selected_tools_count` is null because the
 *  Copilot Chat export does not carry the IDE-side selection count -- only
 *  the model-visible tool definitions actually sent in the request. */
export function buildToolDefinitionShapeFacts(shape: ToolDefinitionShapeAnalysis): Record<string, unknown> {
  if (!shape || !shape.available) {
    return {
      available: false,
      note: "No model-visible tool definitions were found in any chat request for this session.",
    };
  }
  const toRouterRecord = (c: ToolDefinitionClassification) => {
    const usage = shape.routerUsage.find((u) => u.name === c.name);
    return {
      name: c.name,
      kind: c.kind,
      confidence: c.confidence,
      signals: c.signals,
      used: !!usage?.used,
      call_count: usage?.callCount ?? 0,
      learn_true_called: !!usage?.learnTrueCalled,
      commands_called: usage?.commandsCalled ?? [],
    };
  };
  return {
    available: true,
    ide_selected_tools_count: null,
    model_visible_tool_definitions_count: shape.modelVisibleToolDefinitionsCount,
    direct_tool_count: shape.directToolCount,
    router_or_grouped_tool_count: shape.routerOrGroupedToolCount,
    possible_router_tool_count: shape.possibleRouterToolCount,
    unknown_tool_count: shape.unknownToolCount,
    router_or_grouped_tools: shape.routerOrGroupedTools.map(toRouterRecord),
    possible_router_tools: shape.possibleRouterTools.map((c) => ({
      name: c.name, kind: c.kind, confidence: c.confidence, signals: c.signals,
    })),
    direct_tools: shape.directTools.map((c) => c.name),
    interpretation: "Only model-visible tool definitions are known from the request payload. IDE-selected tools may be larger. Router/grouped tools represent deferred or hidden subcommands behind one schema; unless invoked with discovery arguments such as `learn=true`, this export does not prove those subcommands were expanded during the run.",
  };
}

/** Render the human-readable "Tool definition shape" markdown section. Used
 *  in the legacy human-readable view appended after the structured facts. */
export function renderToolDefinitionShapeMarkdown(shape: ToolDefinitionShapeAnalysis, usedToolNames: string[]): string[] {
  const out: string[] = [];
  out.push("### Tool definition shape");
  out.push("");
  if (!shape || !shape.available) {
    out.push("_No model-visible tool definitions were found in any chat request for this session._");
    return out;
  }
  out.push("- Selected/enabled tools in IDE: _unknown (not carried in the Copilot Chat export)_");
  out.push("- Model-visible tool definitions sent to main chat calls: **" + shape.modelVisibleToolDefinitionsCount + "**");
  out.push("- Direct tools: " + shape.directToolCount);
  out.push("- Router/grouped tools: " + shape.routerOrGroupedToolCount);
  out.push("- Possible router tools: " + shape.possibleRouterToolCount);
  out.push("- Unknown tool definitions: " + shape.unknownToolCount);
  out.push("- Tools actually invoked: " + new Set(usedToolNames).size);
  out.push("");
  out.push("> " + shape.note);
  out.push("");
  if (shape.routerOrGroupedTools.length > 0) {
    out.push("**Router/grouped tools**");
    out.push("");
    out.push("| Tool | Used? | Confidence | Signals |");
    out.push("|---|---:|---:|---|");
    for (const c of shape.routerOrGroupedTools) {
      const usage = shape.routerUsage.find((u) => u.name === c.name);
      const used = usage?.used
        ? "yes (" + usage.callCount + (usage.learnTrueCalled ? ", learn=true" : "") + ")"
        : "no";
      out.push("| `" + c.name + "` | " + used + " | " + c.confidence + " | " + c.signals.join("; ") + " |");
    }
    out.push("");
  }
  if (shape.possibleRouterTools.length > 0) {
    out.push("**Possible router tools (lower-confidence routing shape)**");
    out.push("");
    for (const c of shape.possibleRouterTools) {
      out.push("- `" + c.name + "` (" + c.confidence + "): " + c.signals.join("; "));
    }
    out.push("");
  }
  return out;
}

/** Build the `mcp_server_reachability_analysis` JSON block. Surfaces the
 *  discrepancy between MCP servers the IDE declared and MCP servers whose
 *  tools the model actually saw on the wire. Heuristic matcher; see
 *  mcpServerReachability.ts for the rules. */
export function buildMcpReachabilityFacts(reach: McpReachabilityAnalysis): Record<string, unknown> {
  if (!reach || !reach.available) {
    return {
      available: false,
      note: reach?.note ?? "No `mcpServers` block was present in the export.",
    };
  }
  return {
    available: true,
    confidence: reach.confidence,
    declared_count: reach.declaredCount,
    visible_count: reach.visibleCount,
    unused_count: reach.unusedCount,
    mcp_tool_count_on_wire: reach.mcpToolCount,
    visible_servers: reach.matches.map((m) => ({
      label: m.server.label,
      type: m.server.type ?? null,
      command: m.server.command ?? null,
      matched_slug: m.slug,
      tool_count: m.toolCount,
    })),
    unused_servers: reach.unused.map((s) => ({
      label: s.label,
      type: s.type ?? null,
      command: s.command ?? null,
      reason: "no `mcp_<label-slug>_*` tools from this server appeared in any chat request; cause not determined from the export (could be disabled, failed to start, or simply had no tools the IDE chose to send)",
    })),
    extra_on_wire_prefixes: reach.extraInWire,
    interpretation: "The `mcpServers` array lists servers the IDE knew about at export time. Servers with no matching on-the-wire tool produced no model-visible capabilities in this session, but the export does not record whether they were enabled, disabled, crashed, or filtered. Treat as a signal to investigate, not a proven misconfiguration.",
    note: reach.note,
  };
}

/** Render the human-readable "MCP server reachability" markdown section. */
export function renderMcpReachabilityMarkdown(reach: McpReachabilityAnalysis): string[] {
  const out: string[] = [];
  out.push("### MCP server reachability");
  out.push("");
  if (!reach || !reach.available) {
    out.push("_" + (reach?.note ?? "No `mcpServers` block was present in the export.") + "_");
    out.push("");
    return out;
  }
  out.push("- MCP servers listed in the export: **" + reach.declaredCount + "**");
  out.push("- Servers whose `mcp_*` tools appeared in any chat request: **" + reach.visibleCount + "**");
  out.push("- Listed but contributed no tool definitions: **" + reach.unusedCount + "**");
  out.push("- Total distinct `mcp_*` tool definitions sent on the wire: **" + reach.mcpToolCount + "**");
  out.push("- Match confidence: " + reach.confidence + " (label-slug to `mcp_<slug>_*` prefix)");
  out.push("");
  out.push("> " + reach.note);
  out.push("");
  if (reach.matches.length > 0) {
    out.push("**Visible MCP servers**");
    out.push("");
    out.push("| Server | Type | Matched slug | Tools visible |");
    out.push("|---|---|---|---:|");
    for (const m of reach.matches) {
      out.push("| `" + m.server.label + "` | " + (m.server.type ?? "_unknown_") + " | `mcp_" + m.slug + "_*` | " + m.toolCount + " |");
    }
    out.push("");
  }
  if (reach.unused.length > 0) {
    out.push("**Listed but unused (cause not determined from the export)**");
    out.push("");
    out.push("| Server | Type | Command |");
    out.push("|---|---|---|");
    for (const s of reach.unused) {
      out.push("| `" + s.label + "` | " + (s.type ?? "_unknown_") + " | " + (s.command ? "`" + s.command + "`" : "_n/a_") + " |");
    }
    out.push("");
  }
  if (reach.extraInWire.length > 0) {
    out.push("**Extra on-wire `mcp_` prefixes (no matching declared server)**");
    out.push("");
    for (const e of reach.extraInWire) {
      out.push("- `mcp_" + e.slug + "_*` -- " + e.toolCount + " tool(s). May indicate a server added/renamed after the export was captured, or a label-to-slug mismatch worth investigating.");
    }
    out.push("");
  }
  return out;
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
  lines.push("## Role");
  lines.push("");
  lines.push("You are evaluating one VS Code Copilot Chat session for **developer efficiency and cost efficiency**. Your goal is to help the developer decide what to change next time. Help them improve their way of working, their custom chat mode / agent, IDE Configure Tools setup, skills profile, repo instructions, inline prompts, model selection, Auto-mode usage, and the boundary between agent work and scripts.");
  lines.push("");
  lines.push("## Report style");
  lines.push("");
  lines.push("Prioritize **developer actionability** over token accounting. Do not present raw telemetry as the finding. Use telemetry only as supporting evidence. For every important point, translate the data into:");
  lines.push("");
  lines.push("1. what happened in developer terms,");
  lines.push("2. why it matters,");
  lines.push("3. which lever the developer controls,");
  lines.push("4. what exact change to make.");
  lines.push("");
  lines.push("**Bad:** \"`tool_usage.execution_counts_by_name` shows `run_in_terminal` used 5 times.\"");
  lines.push("**Good:** \"The workflow was terminal-heavy -- the agent was orchestrating a small pipeline. If this recurs, move the deterministic steps into a script. Evidence: `run_in_terminal` used 5 times.\"");
  lines.push("");
  lines.push("**Bad:** \"`ctx_components_chars.history` grew from 1008 to 12895.\"");
  lines.push("**Good:** \"Intermediate state accumulated in the conversation. For repeat workflows, write detailed intermediate output to files and pass compact summaries back to the model. Evidence: history grew from 1008 to 12895 chars.\"");
  lines.push("");
  lines.push("## Critical framing");
  lines.push("");
  lines.push("If a custom chat mode, custom agent, repo instruction, or skill was active, **do not judge the session from the visible user prompt alone**. Treat the visible prompt as only the trigger when the structured facts indicate another configuration shaped the task. Focus recommendations on the actual control surface (chat mode / agent / repo instructions / skill) rather than telling the user to write a longer inline prompt.");
  lines.push("");
  lines.push("## Source-of-truth precedence");
  lines.push("");
  lines.push("The developer-facing JSON keys (`developer_action_summary`, `session_narrative`, `cache_health`, `every_call_overhead`, `cost_projection`, `workflow_classification`, `developer_efficiency_findings`, `developer_levers_detected`, `developer_cost_categories`, `recommended_changes`, `custom_mode_or_agent_analysis`, `ide_tool_configuration_analysis`, `tool_definition_shape_analysis`, `mcp_server_reachability_analysis`, `skills_profile_analysis`, `automation_boundary_recommendation`, `model_strategy_recommendation`, `prompt_strategy_recommendation`, `quality_and_validation`, `workflow_phase_analysis`, `agent_loop_efficiency`, `tool_result_size_analysis`, `baseline_comparison`, `experiment_validity`, `control_surface_analysis`, `missing_data`) are the source of truth. The `raw_supporting_telemetry` block is evidence only. If a human-readable supporting section later in this prompt appears to contradict the developer-facing JSON, the JSON wins.");
  lines.push("");
  lines.push("## Output format");
  lines.push("");
  const reportMode = opts.reportMode || "developer_action_report";
  if (reportMode === "developer_action_report") {
    lines.push("Mode: **developer_action_report** (default). Aim for 700-900 words. Organize around developer actionability, not the JSON schema. The final report should feel like: *what happened, why it cost money, what's already working, what to change next time, what not to waste time on, and what to validate.*");
    lines.push("");
    lines.push("Start your reply with `# <Workflow name>: Optimization Review` as the very first line (the title IS the H1 -- do not write a separate label). Then use `##` subheadings for the sections below, in this exact order.");
    lines.push("");
    lines.push("1. **What happened** -- This comes FIRST, before Bottom line. 2-4 sentences that ground the reader in the story of the session. Use `session_narrative`:");
    lines.push("   - Paraphrase `user_objective.first_user_message` in clean developer language. Quote it verbatim ONLY if it is both concise AND explanatory. Do NOT preserve typos unless the quote itself matters.");
    lines.push("   - Summarize `agent_path_compressed` as a short workflow narrative (e.g. \"inspected the folder, gathered data, accumulated state across several silent turns, then made a large execution step\"). Do NOT list every turn or every phase group.");
    lines.push("   - Mention `artifacts_created` only when non-empty. When `artifacts_caveat` indicates heuristic extraction, frame as \"appears to have produced\" rather than asserted truth. If artifact paths in `artifacts_created` conflict with the visible final response shown in `raw_supporting_telemetry`, prefer the visible final response but keep cautious wording.");
    lines.push("   - End with the `outcome_signal`, especially whether validation was captured.");
    lines.push("   - If `session_narrative` is missing or empty, degrade gracefully: infer a one-sentence objective from the visible user messages in `raw_supporting_telemetry` and skip detailed path reconstruction.");
    lines.push("2. **Bottom line** -- Diagnosis, not the story. One short paragraph (3-5 sentences). Explain: (a) what workflow class this was, (b) what cost pattern mattered most, (c) the ONE main fix. **Add one plain-English spend-pattern sentence** that names what was actually being paid for. For repeatable workflows, say something like: \"The expensive part was not the single user request -- it was repeatedly re-entering the workflow loop: carrying chat-mode instructions, skills, tool definitions, and accumulated history into every call, then doing a large reasoning-heavy batch step before execution.\" Cite `workflow_classification.type`, `workflow_classification.confidence`, `agent_loop_efficiency.call_shape_assessment`, and `every_call_overhead.estimated_stable_prefix_tokens_per_call` when material.");
    lines.push("3. **Fix before next run** -- Prefer **3 fixes** by default. Use 4-5 only if the extra fixes are materially different and medium/high impact. Split into two subgroups when useful:");
    lines.push("   - `### Workflow fixes` first (unless setup overhead is dominant): script deterministic steps; update custom chat mode / agent to use the script and ask only on ambiguity; keep intermediate output compact; **add validation output** (this unblocks every downstream optimization).");
    lines.push("   - `### Setup cleanup` after: prune unused skills if material; restrict tools if useful (demote tool cleanup under 5% to *What not to over-optimize*); try Auto or cheaper model only after validation exists.");
    lines.push("   For each fix include: bold title / one-line why / fenced ```text snippet the developer can copy / expected impact / confidence. Do not let low-impact tool cleanup crowd out workflow-shape fixes.");
    lines.push("   **When `workflow_classification.type` indicates repeatable work, immediately after the fix list add a compact `### Current vs better shape` block** rendered as two single-line arrow diagrams:");
    lines.push("   ```");
    lines.push("   Current: user -> custom chat mode -> inspect -> carry state across N silent turns -> batch reason -> execute -> summarize");
    lines.push("   Better:  user -> custom chat mode -> run script -> review compact JSON -> ask only on ambiguity -> write summary + validation");
    lines.push("   ```");
    lines.push("   Keep arrows short. Do not invent steps not supported by `session_narrative.agent_path_compressed` and `recommended_changes`.");
    lines.push("   **When tools OR skills overhead is material (>=5% of session, or composition_hints shows broad surfaces), add a compact `### IDE / workspace configuration` table** with columns `Surface | Keep / use | Disable / prune | Why`. Rows: custom chat mode, Configure Tools, Skills, Repo script. Skip this table if both tool AND skill overhead are under 5%.");
    lines.push("4. **Cost drivers in plain English** -- 3-5 short bullets. Translate telemetry into developer meaning; do NOT lead with field names. Cite supporting numbers in parentheses at the END of each bullet. Prioritize: (1) agent loop shape, (2) large hidden deliberation / output spike, (3) every-call overhead from stable prefix (use `every_call_overhead.estimated_stable_prefix_tokens_per_call` and explain that this is paid on EVERY call), (4) context accumulation / tool-result bloat, (5) material setup overhead, (6) model choice only if relevant. **When `cache_health.verdict` is `excellent` or `healthy`, add one short bullet that names the cache hit rate and notes that caching reduces unit cost but does NOT make a long stable prefix free.** When the verdict is `partial` or `poor`, lead one bullet with cache instability as a real problem.");
    lines.push("5. **What's working** -- 2-3 short bullets of positive reinforcement so the developer does not optimize things that are not broken. Pull from: `cache_health.verdict` if healthy or excellent, `model_strategy_recommendation` if model tier is a good fit, `session_narrative.artifacts_created` if non-empty and the outcome line is positive, `agent_loop_efficiency.call_shape_assessment` if `efficient_single_pass` or `tool_heavy_but_expected`. If nothing material is working well, write one honest sentence explaining that (no fabricated positives).");
    lines.push("6. **What not to over-optimize** -- 1-3 short bullets. This section is important; keep it. Any lever contributing <5% of session cost is cleanup, not the main optimization. Explicitly tell the developer not to overfocus on low-impact but visible levers. When a custom chat mode or custom agent was active, mention the inline prompt only as session-specific scope -- not as the primary fix. Phrase as \"X was real overhead, but only ~Y% of this session -- clean up when convenient, but it is not the main optimization.\"");
    lines.push("7. **Model guidance** -- 2-4 sentences. **Open with: \"Do not optimize model choice before optimizing workflow shape. First reduce the amount of work the model has to do; then test whether a cheaper model can handle the smaller, validated task.\"** Then quote the conservative Auto-same-model estimate. Mention the Auto verdict if present. Mention optimistic cheaper-model projections only as hypotheses. If `quality_and_validation.available == false`, explicitly say cheaper models are not yet proven safe and that **validation is the unlock that makes any model downgrade defensible**. Do NOT claim GPT-5 mini or any cheaper model is sufficient unless quality validation supports it. Cite `model_strategy_recommendation.summary`.");
    lines.push("8. **Suggested next experiment** -- A **numbered, ordered sequence** (not a flat list). Use this default order, adjusted only if structured facts clearly indicate a different dominant issue:");
    lines.push("   1. Add validation output (the unlock for everything below).");
    lines.push("   2. Script the deterministic workflow steps.");
    lines.push("   3. Update the custom chat mode / agent to call the script and keep intermediate summaries compact.");
    lines.push("   4. Prune unused skills if material (>=5%).");
    lines.push("   5. Restrict tools to the whitelist (note: low priority if <5%).");
    lines.push("   6. Try Auto or a cheaper model -- only after validation captures correctness.");
    lines.push("   Each step should be one short sentence with a concrete artifact (script name, chat-mode file, validation file) when known. Tie back to `recommended_changes` items. Optionally close with a one-line `cost_projection` reference (e.g. \"At unchanged shape, 10 runs cost ~$X; after fix the projection drops to ~$Y per run -- still a hypothesis until validation lands.\").");
    lines.push("   **End section 8 with a fenced ```text block titled `A/B test handoff` that the developer can copy directly into the Compare LLM analysis input on the next run.** Use exactly this shape (one line per field, fill in concrete values from the analysis):");
    lines.push("   ```text");
    lines.push("   A/B test handoff");
    lines.push("   Hypothesis: <one sentence naming the single biggest change to try>");
    lines.push("   Expected effect: <which buckets/components shift, in which direction, rough magnitude in cr or %>");
    lines.push("   Setup A (baseline): <model, chat mode, tool profile, scenario>");
    lines.push("   Setup B (experiment): <what differs from A -- one change per run is best>");
    lines.push("   Validation: <how the developer will confirm the answer is still acceptable>");
    lines.push("   Risk: <what could regress; side-effects to watch for>");
    lines.push("   ```");
    lines.push("   The handoff block must be self-contained (no field paths, no jargon a developer would not understand). Only emit one A/B test handoff block; pick the single highest-leverage experiment.");
    lines.push("9. **Evidence** -- Default **max 6 bullets** (was 5; the projection and prefix lines justify one more). Cite only the numbers that support the recommendations above. Use field paths sparingly. Close with a **2-line `Capture next time:` checklist** of the highest-leverage missing fields from `missing_data` (e.g. `validation result`, `per-command tool output size`, `skill attachment source`, `before/after file inventory`). Do NOT dump every available metric, and do NOT dump the entire `missing_data` array.");
    lines.push("");
    lines.push("### Decision logic for the default report");
    lines.push("");
    lines.push("- If `workflow_classification.type` indicates repeatable work, lead Bottom line with **workflow shape** and put **scripting / automation boundary** as the first Workflow fix -- not tools or skills.");
    lines.push("- If `session_metadata.custom_chat_mode_used` or `custom_agent_used` is true, treat the chat mode / agent as the **main instruction surface**. Do NOT make the inline prompt the primary fix in that case; mention inline prompt only as session-specific scope in *What not to over-optimize*.");
    lines.push("- If `agent_loop_efficiency.call_shape_assessment` is `many_model_turns_for_repeatable_workflow`, `terminal_heavy_orchestration`, or `hidden_deliberation_spike`, name that specific shape in Bottom line and target fewer model calls via scripting in Workflow fixes.");
    lines.push("- If `tool_result_size_analysis.bloat_assessment` is `moderate` or `high`, include a Workflow fix about keeping intermediate output compact.");
    lines.push("- For tool / skill cleanup: if the lever's percent-of-session is <5%, demote it to **What not to over-optimize**; if >=5%, include it in **Setup cleanup** AFTER Workflow fixes.");
    lines.push("- If `quality_and_validation.available == false`, all cheaper-model and aggressive-automation suggestions are framed as experiments. Never as conclusions.");
    lines.push("- If `experiment_validity.available == true` and any `valid_for_*` is false, lead Bottom line with the validity warning before any optimization claim.");
    lines.push("- If `baseline_comparison.available == true`, replace Bottom line's tone with current-vs-baseline framing (improved / regressed / unchanged / external).");
    lines.push("- If `session_narrative.artifacts_caveat` is present (it always is when heuristic extraction was used), never assert exact artifact creation with full confidence -- use \"appears to have produced\" or similar.");
    lines.push("");
    lines.push("### Required section names (for downstream parsers)");
    lines.push("");
    lines.push("Use these exact `##` headings verbatim, **in this order**: `What happened`, `Bottom line`, `Fix before next run`, `Cost drivers in plain English`, `What's working`, `What not to over-optimize`, `Model guidance`, `Suggested next experiment`, `Evidence`.");
  } else {
    // detailed_audit -- the original 12-section heavy report.
    lines.push("Mode: **detailed_audit**. Aim for under 900 words. Mirror the full JSON schema for an in-depth audit.");
    lines.push("");
    lines.push("Start your reply with `# <session title>` as the very first line (the title IS the H1 -- do not write 'Session title' as a separate label). Then use `##` subheadings for the sections below.");
    lines.push("");
    lines.push("Sections, in this order:");
    lines.push("");
    lines.push("1. **TL;DR** (~5 lines, write LAST but place FIRST). Use `developer_action_summary.primary_message` plus the top 3 of `developer_action_summary.top_developer_levers` as bullets. Include $ or % where the lever evidence has it.");
    lines.push("2. **Developer takeaway** -- 2-3 sentences in plain developer language. Explain the lesson, not the metrics. Cite `workflow_classification.type` and `workflow_classification.confidence`.");
    lines.push("3. **Main efficiency levers** -- Iterate `developer_levers_detected` entries where `available == true` and `priority != \"low\"`, ordered by `developer_action_summary.top_developer_levers`. For each: bold lever name / one-line `recommended_action` / 1-2 evidence bullets / priority. Stop at 5 levers.");
    lines.push("4. **What made this session expensive** -- Group cost by developer-facing cause using only the `developer_cost_categories` keys that are present. Each bullet: one-line summary + 1-2 supporting numbers in parentheses + the relevant developer lever.");
    lines.push("5. **What was probably unavoidable** -- 1-2 sentences. Separate avoidable waste from real task complexity.");
    lines.push("6. **Recommended changes** -- Iterate `recommended_changes`. Group by `surface`. For each: bold `title` + 1-line `why` + fenced ```text block with `snippet` + impact + confidence. Skip `confidence == \"low\"` unless it is the only signal for that surface.");
    lines.push("7. **Automation boundary** -- Use `automation_boundary_recommendation`. Two short lists: `should_script`, `should_remain_model_driven`. Skip if null or `confidence == \"low\"`.");
    lines.push("8. **Tool and skill profile cleanup** -- Use `ide_tool_configuration_analysis` and `skills_profile_analysis`. List families to disable + top 3-5 skills to remove. Note the `skill_attachment_source` caveat.");
    lines.push("9. **Model and Auto-mode guidance** -- Use `model_strategy_recommendation` + `raw_supporting_telemetry.auto_mode_data`. **Do not claim a cheaper model is definitely sufficient** if `quality_and_validation.available == false` or any `realistic_for_full_task == \"not_determinable_from_data\"`.");
    lines.push("10. **Inline prompt guidance** -- Use `prompt_strategy_recommendation` + `developer_levers_detected.inline_prompt`. Quote `example_inline_prompt`.");
    lines.push("11. **Data confidence and missing data** -- List `missing_data` entries with `why_it_matters_for_developer_report`.");
    lines.push("12. **Suggestions for improving future telemetry** -- Up to 5 bullets summarizing `future_instrumentation`.");
  }
  lines.push("");
  lines.push("## Cross-cutting analyst guidance");
  lines.push("");
  lines.push("- **Iteration-aware analysis.** If `baseline_comparison.available == true`, compare current vs baseline: what improved, what regressed, what stayed the same, what is attributable to user-controlled changes, what is external or fixed. If `baseline_comparison.available == false`, do not invent a comparison.");
  lines.push("- **Experiment validity check.** Before judging whether an optimization worked, inspect `experiment_validity`. If `valid_for_agent_prompt_evaluation`, `valid_for_model_evaluation`, or `valid_for_tool_profile_evaluation` is `false`, lead with that mismatch and warn that conclusions about the affected surface are unsafe. If `experiment_validity.available == false`, note that no intended setup was declared and skip this check.");
  lines.push("- **Control-surface discipline.** Use `control_surface_analysis.surfaces` to find which surfaces have recommendations. De-emphasize any surface whose `controllable == false`, and any surface listed in `control_surface_analysis.external_or_not_controllable` -- mention them as fixed/external overhead instead of as primary actions.");
  lines.push("- **Phase-aware diagnosis.** Use `workflow_phase_analysis.largest_cost_phase` and `largest_context_growth_phase` to target the expensive phase. Do not recommend generic token reductions when one phase clearly dominates.");
  lines.push("- **Loop-shape diagnosis.** Use `agent_loop_efficiency.call_shape_assessment`. If the shape is `many_model_turns_for_repeatable_workflow` or `hidden_deliberation_spike`, name the specific waste pattern; do not recommend more turns.");
  lines.push("- **Quality-aware model guidance.** If `quality_and_validation.available == false`, frame cheaper-model and more-automation recommendations as hypotheses to test, never as safe defaults.");
  lines.push("- **Automation-boundary diagnosis.** If `automation_boundary_recommendation` lists deterministic steps and `tool_result_size_analysis.bloat_assessment` is `moderate` or `high`, recommend moving deterministic work into scripts / linters / data processors and consuming compact intermediate artifacts; keep model-driven work focused on ambiguity, judgment, synthesis, and exception handling.");
  lines.push("- **Tool-output bloat.** Use `tool_result_size_analysis.largest_turns` to point at specific turns whose combined tool results bloated context. Respect `granularity_caveat`: never attribute bloat to one specific tool invocation -- it is per-chat-call aggregate.");
  lines.push("- **Generality.** Frame findings in reusable patterns (excessive setup overhead, overly broad tool profile, large prompt/config context, repeated deterministic work, large tool outputs, context accumulation, hidden deliberation spikes, missing quality validation, model choice not validated) rather than workflow-specific narratives.");
  lines.push("");
  lines.push("## Hard rules");
  lines.push("");
  lines.push("- Use ONLY the facts below.");
  lines.push("- Do not infer correctness if `quality_and_validation.available == false`.");
  lines.push("- Do not overfit recommendations to one workflow type (this analysis package supports many session kinds).");
  lines.push("- Do not blame the inline prompt alone when a custom chat mode or custom agent was active.");
  lines.push("- Do not claim a cheaper model is sufficient unless quality data supports it.");
  lines.push("- Use the `raw_supporting_telemetry` block only as evidence. Cite field paths in parentheses, not as the main prose.");
  lines.push("- Per-call rows in `raw_supporting_telemetry` cover CHAT calls only; overhead calls (title generation, prompt categorization, telemetry) are summarised separately and must NOT be referenced as user turns.");
  lines.push("- `ctx_components.*` tokens are SCALED estimates -- always cite `ctx_components_chars.*` first to determine whether real change happened.");
  lines.push("- Reasoning-token counts are NOT in this data. `raw_supporting_telemetry.agent_behavior_signals.avg_thinking_chars_per_chat_call` is a character count, not a billed token count.");
  lines.push("- If something is not determinable from the data, say so. Do not speculate.");
  lines.push("");
  lines.push("## Venue guide (where each fix belongs)");
  lines.push("");
  lines.push("- `[inline prompt]` -- one-off fix the user types into the next prompt. Good for output-shape constraints (\"reply in <=5 bullets\", \"output only the filename\") and for narrowing scope on this specific task.");
  lines.push("- `[AGENTS.md]` or `[.github/copilot-instructions.md]` -- repo-level instructions auto-attached to every chat in this workspace. Good for project-wide conventions (file naming, tool preferences, output format defaults).");
  lines.push("- `[custom skill: SKILL.md]` -- a packaged capability the agent loads on demand. Good when the same multi-step workflow recurs across sessions.");
  lines.push("- `[custom chat mode: .chatmode.md]` -- a scoped persona with its own system prompt and tool whitelist. Good when an entire kind of session benefits from a restricted toolset and stricter output rules.");
  lines.push("- `[VS Code setting: Configure Tools]` -- disable individual tools the user does not need for similar tasks. Cheapest fix when the cost-lever block flags unused tools or skills.");
  lines.push("");
  lines.push("## Shared vocabulary (use these terms; they match the Compare LLM analysis)");
  lines.push("");
  lines.push("- **Bucket / cost category** -- where tokens are spent in a single call. Names match Compare:");
  lines.push("  - `system` = system prompt + custom chat mode instructions.");
  lines.push("  - `tool_defs` = tool/skill registration overhead (shipped on every call).");
  lines.push("  - `history` = accumulated conversation history.");
  lines.push("  - `tool_results` = output of tool calls carried back into context.");
  lines.push("  - `current` = the user's prompt for this turn.");
  lines.push("  - `output` = the model's response.");
  lines.push("- **Workflow shape** -- how the agent loop is structured. Labels: `efficient_single_pass`, `tool_heavy_but_expected`, `many_model_turns_for_repeatable_workflow`, `terminal_heavy_orchestration`, `hidden_deliberation_spike`.");
  lines.push("- **Control surface** -- where a fix belongs. Labels: `inline_prompt`, `custom_chat_mode`, `custom_agent`, `repo_instructions`, `tool_configuration`, `model_selection`, `scripts_automation`, `validation_pipeline`, `external_not_controllable`.");
  lines.push("- **Cache health** -- `excellent`, `healthy`, `partial`, `poor`. Compare uses `cache pollution` to flag fresh-vs-warm cache asymmetry; the two views are consistent (a `poor` single-run will usually be flagged as pollution in any A/B).");
  lines.push("- **Every-call overhead** -- tokens paid on every chat call regardless of what the user asked (system + tool_defs + skill carry). Compare splits the same idea into `fixed_vs_variable`.");
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
  const visibleSpecValue = visiblePromptLen >= 300 ? "high" : visiblePromptLen >= 80 ? "medium" : "low";
  const effectiveSpecValue = firstChatMode ? "higher_than_visible_prompt" : visibleSpecValue;
  const visibleSpecRule = "Specificity bucket derived from prompt length: <80 chars = low, 80-299 = medium, >=300 = high. Short prompts with broad verbs and no explicit output format default to low.";
  const effectiveSpecRule = firstChatMode
    ? "A custom chat mode (`" + firstChatMode.name + "`, ~" + (firstChatMode.tokensEst || 0).toLocaleString() + " tok) was active. Effective specificity is treated as higher than visible because the chat mode contributed additional instruction text. Full chat mode text is not in this export, so the exact additional specificity is not measurable."
    : "No custom chat mode active. Effective specificity equals visible.";
  // Per-call walk: collect output/thinking spikes and ctx component growth.
  let totalVis = 0, totalThink = 0, totalToolArgs = 0;
  let maxThink = { turn: 0, chars: 0, out: 0, cost: 0 };
  const perTurnOutputs: { turn: number; output: number; cost: number; visibleReplyChars: number; thinkingChars: number }[] = [];
  const ctxComponentSeries: Record<string, number[]> = {};
  let turnIdx = 0;
  chatEvents.forEach(e => {
    turnIdx += 1;
    const t = e.thinkingChars || 0;
    totalVis += e.visibleResponseChars || 0;
    totalThink += t;
    totalToolArgs += e.toolArgsChars || 0;
    if (t > maxThink.chars) maxThink = { turn: turnIdx, chars: t, out: e.output || 0, cost: e.cost || 0 };
    perTurnOutputs.push({ turn: turnIdx, output: e.output || 0, cost: e.cost || 0, visibleReplyChars: e.visibleResponseChars || 0, thinkingChars: t });
    if (e.componentChars) {
      Object.entries(e.componentChars).forEach(([k, v]) => {
        if (!ctxComponentSeries[k]) ctxComponentSeries[k] = [];
        ctxComponentSeries[k].push(v as number);
      });
    }
  });
  const callsForAvg = Math.max(chatEvents.length, 1);
  const avgVisible = Math.round(totalVis / callsForAvg);
  const avgThink = Math.round(totalThink / callsForAvg);
  const avgOutput = perTurnOutputs.reduce((a, p) => a + p.output, 0) / Math.max(perTurnOutputs.length, 1);
  const explanationVerbosity = avgVisible >= 2000 ? "high" : avgVisible >= 500 ? "medium" : "low";
  const deliberationVerbosity = avgThink >= 5000 ? "high" : avgThink >= 1500 ? "medium" : "low";
  // Output spikes: turns where output is >= 3x the session average AND >= 1500 tokens.
  const largeOutputSpikes = perTurnOutputs
    .filter(p => avgOutput > 0 && p.output >= 3 * avgOutput && p.output >= 1500)
    .map(p => ({
      turn: p.turn,
      output_tokens: p.output,
      cost_usd: Number(p.cost.toFixed(4)),
      reason: "Output >= 3x session average and >= 1500 tokens.",
      confidence: "measured",
    }));
  // Thinking spikes: turns where thinkingChars >= 3x average thinking AND >= 3000 chars.
  const thinkingSpikes = perTurnOutputs
    .filter(p => avgThink > 0 && p.thinkingChars >= 3 * avgThink && p.thinkingChars >= 3000)
    .map(p => ({
      turn: p.turn,
      thinking_chars: p.thinkingChars,
      visible_reply_chars: p.visibleReplyChars,
      confidence: "measured",
    }));
  // Context growth top sources: top-2 components by absolute char delta first->last.
  const ctxGrowthSources = Object.entries(ctxComponentSeries)
    .map(([source, series]) => {
      const start = series[0] || 0;
      const end = series[series.length - 1] || 0;
      return { source, chars_start: start, chars_end: end, delta: end - start };
    })
    .filter(s => s.delta > 0)
    .sort((a, b) => b.delta - a.delta)
    .slice(0, 3)
    .map(s => ({ source: s.source, chars_start: s.chars_start, chars_end: s.chars_end, confidence: "measured" }));
  // Developer-supplied signals: detected from presence of scaffolding.
  const devSuppliedScope = !!firstChatMode || instructions.length > 0;
  // Top cost levers mirrored into structured form so the analyst can quote them.
  const topCostLevers: Record<string, unknown>[] = [];
  if (unusedToolUsd > 0) topCostLevers.push({
    lever: "Disable unused tool definitions",
    evidence: unused.unused.length + " tools / ~" + unused.unusedDefTokensTotal.toLocaleString() + " tokens across calls / ~" + fmtUsd(unusedToolUsd) + " / " + unusedToolPctOfSession.toFixed(1) + "% of session cost",
    estimated_impact: unusedToolPctOfSession >= 10 ? "large" : unusedToolPctOfSession >= 3 ? "moderate" : "small",
    recommended_venue: "VS Code Configure Tools UI or custom chat mode tool whitelist",
    confidence: "measured",
    snippet: "(disable in VS Code: Settings -> Chat -> Tools, or restrict in `.chatmode.md` `tools:` frontmatter)",
  });
  if (unusedSkillUsd > 0) topCostLevers.push({
    lever: "Remove unused skills from the active skill source",
    evidence: skillCarry.unusedCount + " unused skills / ~" + skillCarry.unusedTokensPerCall.toLocaleString() + " tok per call / ~" + fmtUsd(unusedSkillUsd) + " / " + unusedSkillPctOfSession.toFixed(1) + "% of session cost",
    estimated_impact: unusedSkillPctOfSession >= 10 ? "large" : unusedSkillPctOfSession >= 3 ? "moderate" : "small",
    recommended_venue: "custom agent skills config / VS Code skill profile (depends on where the skills were attached)",
    confidence: "measured",
    snippet: "(prune unused skills from whichever surface attached them; the export does not record skill_attachment_source)",
  });
  if (maxThink.chars >= 5000) topCostLevers.push({
    lever: "Constrain extended deliberation on routine work",
    evidence: "Turn " + maxThink.turn + " emitted " + maxThink.chars.toLocaleString() + " chars of thinking / " + maxThink.out.toLocaleString() + " output tokens / " + fmtUsd(maxThink.cost),
    estimated_impact: "moderate",
    recommended_venue: "custom chat mode or custom agent prompt",
    confidence: "derived",
    snippet: "For routine extraction, renaming, and batch file operations, think briefly. Reserve extended deliberation for ambiguous receipts or irreversible operations.",
  });
  const largestUnusedSkills = skillCarry.skills
    .filter(s => !s.used)
    .sort((a, b) => b.tokens - a.tokens)
    .slice(0, 5)
    .map(s => ({ name: s.name, tokens: s.tokens }));

  // ---- Developer-facing abstraction layer ------------------------------
  // Translates raw telemetry into developer-controllable levers so the
  // analyst LLM produces a developer-action-friendly report rather than
  // a field-by-field telemetry summary.

  // Workflow classification heuristic.
  const toolUsageCounts: Record<string, number> = {};
  toolUsage.forEach(t => { toolUsageCounts[t.name] = (t as { uses?: number; count?: number }).uses ?? (t as { count?: number }).count ?? 0; });
  const terminalCount = toolUsageCounts["run_in_terminal"] || 0;
  const imageCount = (toolUsageCounts["view_image"] || 0) + (toolUsageCounts["view"] || 0);
  const createFileCount = (toolUsageCounts["create_file"] || 0) + (toolUsageCounts["create"] || 0);
  const editFileCount = (toolUsageCounts["edit_file"] || 0) + (toolUsageCounts["edit"] || 0) + (toolUsageCounts["replace_string_in_file"] || 0);
  const searchReadCount = (toolUsageCounts["semantic_search"] || 0) + (toolUsageCounts["grep_search"] || 0) + (toolUsageCounts["grep"] || 0) + (toolUsageCounts["read_file"] || 0) + (toolUsageCounts["view_file"] || 0);
  const fileMutationCount = createFileCount + editFileCount;
  const totalToolExec = totals.toolCalls;
  const promptLower = (firstUserPromptText || "").toLowerCase();
  const mentionsFiles = /\b(folder|file|files|recipt|receipt|receipts|image|images|pdf|pdfs|directory|batch)\b/.test(promptLower);
  const mentionsDebug = /\b(bug|error|failing|failure|test|tests|broken|fix|crash|stack)\b/.test(promptLower);
  let workflowType = "unknown";
  let workflowConfidence = "low";
  let workflowReason = "Tool mix does not match a known workflow pattern.";
  const alternativeWorkflowTypes: string[] = [];
  if ((terminalCount + imageCount + createFileCount) >= 3 && mentionsFiles && fileMutationCount > 0) {
    workflowType = "repeatable_file_processing";
    workflowConfidence = "medium";
    workflowReason = "Multiple terminal/image/file-creation tool executions with a file-oriented prompt suggest a small file-processing pipeline.";
    if (fileMutationCount >= 2) alternativeWorkflowTypes.push("agentic_batch_operation");
  } else if (mentionsDebug && (terminalCount > 0 || editFileCount > 0)) {
    workflowType = "debugging";
    workflowConfidence = "medium";
    workflowReason = "Prompt references errors/tests/fixes and the session ran terminal and/or file-edit tools.";
  } else if (searchReadCount >= 3 && fileMutationCount === 0) {
    workflowType = "research_and_summarization";
    workflowConfidence = "medium";
    workflowReason = "Search/read tools dominated with no file mutation; output is mostly visible explanation.";
  } else if (editFileCount >= 2 && totalToolExec >= 4) {
    workflowType = "code_generation";
    workflowConfidence = "low";
    workflowReason = "Multiple file edits without strong debugging signals.";
  }

  // Developer-levers detection.
  const unusedToolPctOffered = unused.offeredAll.size > 0 ? (unused.unused.length / unused.offeredAll.size) * 100 : 0;
  const configureToolsPriority = (unusedToolPctOffered > 30 || unusedToolPctOfSession > 3) ? (unusedToolPctOfSession > 10 ? "high" : "medium") : "low";
  const skillsPriority = (skillCarry.skillCount > 0 && skillCarry.unusedCount > 0 && (skillCarry.usedCount === 0 || unusedSkillPctOfSession > 3)) ? (unusedSkillPctOfSession > 10 ? "high" : "medium") : "low";
  const scriptPriority = (workflowType === "repeatable_file_processing" || terminalCount >= 3 || fileMutationCount >= 3) ? "high_for_repeat_use" : "low";
  const modelLeverPriority = (cheapestAlt && autoOptimalSavings != null && autoOptimalSavings > 0.05) ? "medium" : "low";
  const inlinePromptPriority = firstChatMode ? "low" : (visibleSpecValue === "low" ? "high" : "medium");

  const leversDetected: Record<string, unknown> = {};
  if (firstChatMode) {
    leversDetected.custom_chat_mode = {
      available: true,
      priority: "high",
      recommended_action: "Improve the custom chat mode `" + firstChatMode.name + "` rather than telling the user to write a longer inline prompt.",
      evidence: ["custom_chat_mode_used: true", "custom_chat_mode_name: " + firstChatMode.name],
    };
  } else {
    leversDetected.custom_chat_mode = {
      available: false,
      priority: "low",
      recommended_action: "No custom chat mode active. Consider adding one if this kind of session recurs.",
      evidence: ["custom_chat_mode_used: false"],
    };
  }
  leversDetected.configure_tools = {
    available: unused.unused.length > 0,
    priority: configureToolsPriority,
    recommended_action: unused.unused.length > 0 ? "Disable unused tool families in VS Code Configure Tools or restrict the chat mode tool whitelist." : "Tool profile already narrow.",
    evidence: [unused.unused.length + " unused tools", unused.used.size + " tools used", unusedToolPctOfSession.toFixed(1) + "% of session cost on unused tool defs"],
  };
  leversDetected.skills = {
    available: skillCarry.skillCount > 0,
    priority: skillsPriority,
    recommended_action: skillCarry.unusedCount > 0 ? "Prune unused skills from whichever surface attached them (chat mode, profile, workspace -- not recorded)." : "Skill profile already narrow.",
    evidence: [skillCarry.skillCount + " skills attached", skillCarry.usedCount + " used", skillCarry.unusedCount + " unused"],
  };
  leversDetected.script_or_cli = {
    available: true,
    priority: scriptPriority,
    recommended_action: scriptPriority === "high_for_repeat_use" ? "Move deterministic steps (inventory, extraction, summary generation) into a script. Reserve the model for ambiguous interpretation and review." : "No strong script-candidate signal in this session.",
    evidence: ["workflow_classification: " + workflowType, "run_in_terminal calls: " + terminalCount, "file mutation calls: " + fileMutationCount],
  };
  leversDetected.model_selection = {
    available: true,
    priority: modelLeverPriority,
    recommended_action: cheapestAlt ? "Consider Auto or `" + cheapestAlt.model + "` for repeat runs once the workflow is scripted and validated. Quality is not proven without validation data." : "Alt-model projections do not show meaningful savings.",
    evidence: cheapestAlt ? ["alt projection: " + cheapestAlt.model + " ~$" + (autoOptimalCost || 0).toFixed(4), "quality validation: not_available"] : ["no cheaper alternative projected"],
  };
  leversDetected.inline_prompt = {
    available: true,
    priority: inlinePromptPriority,
    recommended_action: firstChatMode ? "Inline prompt should provide only session-specific scope; do not add full workflow instructions there -- they belong in the chat mode." : "Inline prompt is the only instruction surface here. Make it specific about scope and output format.",
    evidence: firstChatMode ? ["custom chat mode active", "do_not_blame_visible_prompt_alone: true"] : ["no custom chat mode active"],
  };

  // Top developer levers (ranked).
  const leverRankOrder: Record<string, number> = { high: 0, high_for_repeat_use: 1, medium: 2, low: 3 };
  const topDeveloperLevers = Object.entries(leversDetected)
    .map(([k, v]) => {
      const obj = v as { priority: string; recommended_action: string; available: boolean };
      return { key: k, priority: obj.priority, available: obj.available, action: obj.recommended_action };
    })
    .filter(l => l.available && l.priority !== "low")
    .sort((a, b) => (leverRankOrder[a.priority] ?? 9) - (leverRankOrder[b.priority] ?? 9))
    .slice(0, 5)
    .map((l, idx) => ({
      lever: l.key,
      priority: idx + 1,
      action: l.action,
      why: (l.key === "custom_chat_mode" && firstChatMode) ? "The visible prompt was only a trigger; the active chat mode shaped the real behavior."
        : l.key === "script_or_cli" ? "The session behaved like a repeatable workflow that can be partially scripted."
        : l.key === "configure_tools" ? "Many tools were available but unused, adding cost to every call."
        : l.key === "skills" ? "Many skills were attached but unused, adding cost to every call."
        : l.key === "model_selection" ? "Cheaper model projections exist, but quality is not proven without validation data."
        : "Adjust this lever to make the next session more efficient.",
    }));

  // Primary message synthesis.
  const primaryMessageParts: string[] = [];
  if (workflowType === "repeatable_file_processing") primaryMessageParts.push("This was a repeatable file-processing pipeline");
  else if (workflowType === "debugging") primaryMessageParts.push("This was a debugging session");
  else if (workflowType === "research_and_summarization") primaryMessageParts.push("This was a research/summarization session");
  else if (workflowType === "code_generation") primaryMessageParts.push("This was a code-generation session");
  else primaryMessageParts.push("This session does not match a clear workflow pattern");
  if (firstChatMode) primaryMessageParts.push("running through the custom chat mode `" + firstChatMode.name + "`");
  primaryMessageParts.push(".");
  const primaryActions: string[] = [];
  if (firstChatMode) primaryActions.push("optimize the chat mode");
  if (configureToolsPriority !== "low" || skillsPriority !== "low") primaryActions.push("narrow the tool/skill profile");
  if (scriptPriority === "high_for_repeat_use") primaryActions.push("script deterministic steps");
  if (primaryActions.length > 0) primaryMessageParts.push(" Top levers: " + primaryActions.join("; ") + ".");
  const primaryMessage = primaryMessageParts.join("");

  // Developer cost categories.
  const developerCostCategories: Record<string, unknown> = {};
  if (unusedToolUsd > 0 || unusedSkillUsd > 0) {
    developerCostCategories.setup_overhead = {
      summary: "Cost from broad tools, skills, and attached instructions before useful work begins.",
      evidence: [
        unused.unused.length + " unused tools / " + unusedToolPctOfSession.toFixed(2) + "% of session cost",
        skillCarry.unusedCount + " unused skills / " + unusedSkillPctOfSession.toFixed(2) + "% of session cost",
      ],
      developer_levers: ["Configure Tools", "skill pruning", "chat mode simplification"],
      estimated_impact: (unusedToolPctOfSession + unusedSkillPctOfSession) > 10 ? "large" : "moderate",
    };
  }
  if (totalToolExec > 0) {
    developerCostCategories.workflow_execution = {
      summary: "Cost from the agent running a multi-step workflow.",
      evidence: [
        totalToolExec + " tool executions",
        terminalCount > 0 ? "run_in_terminal used " + terminalCount + " times" : null,
        imageCount > 0 ? "image inspection used " + imageCount + " times" : null,
      ].filter(Boolean),
      developer_levers: ["script deterministic steps", "compact intermediate outputs"],
      estimated_impact: workflowType === "repeatable_file_processing" ? "moderate to large for repeat runs" : "moderate",
    };
  }
  if (maxThink.chars >= 5000) {
    developerCostCategories.decision_overhead = {
      summary: "Cost from hidden deliberation before a notable step.",
      evidence: [
        "turn " + maxThink.turn + " cost $" + maxThink.cost.toFixed(4),
        "turn " + maxThink.turn + " thinking chars: " + maxThink.chars.toLocaleString(),
      ],
      developer_levers: ["brief-thinking rule in custom chat mode", "preview/confirm/execute pattern"],
      estimated_impact: "large",
    };
  }
  if (ctxGrowthSources.length > 0 && ctxGrowthSources[0].chars_end > ctxGrowthSources[0].chars_start * 3) {
    developerCostCategories.context_accumulation = {
      summary: "Intermediate results accumulated in the conversation across turns.",
      evidence: ctxGrowthSources.slice(0, 2).map(s => s.source + " chars grew from " + s.chars_start + " to " + s.chars_end),
      developer_levers: ["write detailed intermediate output to files", "feed compact summaries back to the model"],
      estimated_impact: "moderate",
    };
  }
  developerCostCategories.model_choice = {
    summary: "Cost from running the chosen model tier across the whole session.",
    evidence: [
      "chosen model: " + (chosenModelName || "unknown") + " / " + (chosenTier || "unknown"),
      "Auto same-model floor cost $" + autoSameModelCost.toFixed(4),
      cheapestAlt ? "alt-model realism: not_determinable_from_data without validation" : "no meaningful cheaper alternative projected",
    ],
    developer_levers: ["Auto mode", cheapestAlt ? "cheaper model for repeat scripted workflows" : null].filter(Boolean) as string[],
    estimated_impact: cheapestAlt ? "small to large depending on quality requirements" : "small",
  };

  // Developer efficiency findings.
  const efficiencyFindings: Record<string, unknown>[] = [];
  if (firstChatMode) {
    efficiencyFindings.push({
      finding: "The custom chat mode is the main place to optimize",
      why_it_matters: "The visible prompt was only a trigger; the active chat mode shaped the actual behavior.",
      evidence: ["custom_chat_mode_used: true", "custom_chat_mode_name: " + firstChatMode.name, "do_not_blame_visible_prompt_alone: true"],
      developer_lever: "Improve the custom chat mode instructions",
      recommended_venue: "custom chat mode .chatmode.md",
      impact: "large",
      confidence: "high",
    });
  }
  if (workflowType === "repeatable_file_processing") {
    efficiencyFindings.push({
      finding: "This workflow is a script candidate",
      why_it_matters: "The agent behaved like a small pipeline: inspect folder, process files, create output.",
      evidence: ["workflow_classification: repeatable_file_processing", "run_in_terminal calls: " + terminalCount, "file mutation calls: " + fileMutationCount],
      developer_lever: "Script deterministic steps and reserve the model for exceptions",
      recommended_venue: "repo script + custom chat mode",
      impact: "large for repeat use",
      confidence: "medium",
    });
  }
  if (unused.unused.length > 5 || skillCarry.unusedCount > 5) {
    efficiencyFindings.push({
      finding: "The session carried irrelevant tool and skill overhead",
      why_it_matters: "Unused tools and skills add cost to every call without helping the workflow.",
      evidence: [
        unused.unused.length + " unused tools",
        skillCarry.unusedCount + " unused skills",
        unusedToolPctOfSession.toFixed(2) + "% unused tool definition cost",
        unusedSkillPctOfSession.toFixed(2) + "% unused skill cost",
      ],
      developer_lever: "Whitelist tools and prune attached skills",
      recommended_venue: "Configure Tools + custom chat mode / profile",
      impact: (unusedToolPctOfSession + unusedSkillPctOfSession) > 10 ? "large" : "moderate",
      confidence: "high",
    });
  }
  if (maxThink.chars >= 5000) {
    efficiencyFindings.push({
      finding: "The expensive point was a hidden-deliberation step",
      why_it_matters: "Agents can spend a lot of hidden work before a notable output or file-changing operation.",
      evidence: [
        "turn " + maxThink.turn + " cost $" + maxThink.cost.toFixed(4),
        totals.cost > 0 ? "turn " + maxThink.turn + " was " + Math.round(100 * maxThink.cost / totals.cost) + "% of session cost" : null,
        "turn " + maxThink.turn + " thinking chars: " + maxThink.chars.toLocaleString(),
      ].filter(Boolean),
      developer_lever: "Add a preview/confirm/execute pattern and brief-thinking rule",
      recommended_venue: "custom chat mode",
      impact: "large",
      confidence: "high",
    });
  }
  if (ctxGrowthSources.length > 0 && ctxGrowthSources[0].chars_end > ctxGrowthSources[0].chars_start * 3) {
    efficiencyFindings.push({
      finding: "Intermediate context accumulated across the workflow",
      why_it_matters: "Long sessions get more expensive when extraction results and prior steps accumulate in conversation history.",
      evidence: ctxGrowthSources.slice(0, 2).map(s => s.source + " chars grew from " + s.chars_start + " to " + s.chars_end),
      developer_lever: "Write structured intermediate outputs to files and pass compact summaries back to the model",
      recommended_venue: "custom chat mode + repo script",
      impact: "moderate",
      confidence: "medium",
    });
  }

  // Custom chat mode recommendations.
  const customChatModeRecommendations: Record<string, unknown>[] = [];
  if (maxThink.chars >= 5000) {
    customChatModeRecommendations.push({
      problem: "Batch or routine work caused a large hidden-deliberation spike.",
      add_to_chat_mode: "Before renaming or modifying multiple files, create a compact action plan. If all items have high confidence, execute directly with brief reasoning. If any item is ambiguous, ask only about those items.",
      expected_impact: "large",
      evidence: ["turn " + maxThink.turn + " cost $" + maxThink.cost.toFixed(4), "turn " + maxThink.turn + " thinking chars: " + maxThink.chars.toLocaleString()],
    });
  }
  if (unused.unused.length > 5) {
    customChatModeRecommendations.push({
      problem: "Too many unrelated tools were available.",
      add_to_chat_mode: "For this kind of session, use only " + Array.from(unused.used).sort().slice(0, 5).map(t => "`" + t + "`").join(", ") + " unless the user explicitly asks for codebase search, notebooks, or refactoring.",
      expected_impact: "moderate",
      evidence: [unused.unused.length + " unused tools", "tools used: " + Array.from(unused.used).sort().join(", ")],
    });
  }
  if (workflowType === "repeatable_file_processing") {
    customChatModeRecommendations.push({
      problem: "The workflow appears repeatable.",
      add_to_chat_mode: "Prefer a repository script when available for the deterministic steps of this workflow. Use the model for ambiguous interpretation, exception handling, and final review rather than rediscovering the full pipeline each session.",
      expected_impact: "large for repeated use",
      evidence: ["workflow_classification: repeatable_file_processing"],
    });
  }
  if (ctxGrowthSources.length > 0 && ctxGrowthSources[0].chars_end > ctxGrowthSources[0].chars_start * 3) {
    customChatModeRecommendations.push({
      problem: "Intermediate context accumulated during the session.",
      add_to_chat_mode: "Keep intermediate results compact. Store detailed extraction output in files and pass only structured summaries, unresolved items, and final decisions back into chat.",
      expected_impact: "moderate",
      evidence: ctxGrowthSources.slice(0, 2).map(s => s.source + " chars grew from " + s.chars_start + " to " + s.chars_end),
    });
  }

  // IDE configuration recommendations.
  const ideConfigRecommendations: Record<string, unknown>[] = [];
  const notebookToolPatterns = ["notebook", "jupyter"];
  const codeNavPatterns = ["semantic_search", "renameSymbol", "symbol", "rename"];
  const unusedNotebookTools = unused.unused.filter(t => notebookToolPatterns.some(p => t.toLowerCase().includes(p)));
  const unusedCodeNavTools = unused.unused.filter(t => codeNavPatterns.some(p => t.toLowerCase().includes(p)));
  if (unusedNotebookTools.length > 0) {
    ideConfigRecommendations.push({
      surface: "VS Code Configure Tools",
      action: "Disable notebook-related tools for this chat mode",
      tools: unusedNotebookTools.slice(0, 6),
      reason: "No notebook work occurred in this session.",
      expected_impact: "small to moderate",
    });
  }
  if (unusedCodeNavTools.length > 0) {
    ideConfigRecommendations.push({
      surface: "VS Code Configure Tools",
      action: "Disable code-navigation/refactor tools for sessions like this",
      tools: unusedCodeNavTools.slice(0, 6),
      reason: "This was not a codebase navigation or symbol refactor task.",
      expected_impact: "small",
    });
  }
  if (unused.used.size > 0 && unused.used.size <= 6) {
    ideConfigRecommendations.push({
      surface: "custom chat mode tool whitelist",
      action: "Whitelist only the tools used in this session for similar sessions",
      tools_to_keep: Array.from(unused.used).sort(),
      reason: "Only these tools were actually used.",
      expected_impact: "moderate",
    });
  }

  // Skills profile recommendations.
  const skillsProfileRecommendations: Record<string, unknown>[] = [];
  if (largestUnusedSkills.length > 0) {
    skillsProfileRecommendations.push({
      surface: "custom agent skills config / global skill profile / workspace skill profile",
      action: "Remove unrelated skills from sessions like this",
      skills_to_remove_first: largestUnusedSkills.map(s => s.name),
      reason: "These were the largest unused skills attached to the session.",
      expected_impact: unusedSkillPctOfSession > 5 ? "moderate" : "small",
      caveat: "The export does not record which surface attached each skill, so remove them from the source that actually attaches them.",
    });
  }

  // Automation boundary recommendation.
  let automationBoundary: Record<string, unknown> | null = null;
  if (workflowType === "repeatable_file_processing") {
    automationBoundary = {
      summary: "This workflow should be split: deterministic script for repeatable steps; model for ambiguous interpretation and review.",
      should_script: ["folder inventory", "file type detection", "text/data extraction", "rename or transform preview generation", "summary or report file creation", "post-run validation"],
      should_remain_model_driven: ["ambiguous interpretation", "exception handling", "normalization when extraction is unclear", "final human-readable review"],
      confidence: "medium",
      evidence: ["workflow_classification: repeatable_file_processing", "run_in_terminal calls: " + terminalCount, imageCount > 0 ? "image inspection calls: " + imageCount : null].filter(Boolean),
    };
  }

  // Model strategy recommendation.
  const modelStrategyRecommendation = {
    summary: cheapestAlt
      ? "Use the current " + (chosenTier || "chosen") + " tier or Auto for first runs with unknown complexity; consider Auto or a cheaper model for repeat runs after deterministic steps are scripted and validated."
      : "Stay on the current model tier; cheaper alternatives do not show meaningful savings on this token shape.",
    first_run: {
      recommended: (chosenTier || "current tier") + " or Auto",
      reason: "Unknown task complexity may need stronger interpretation on first runs.",
    },
    repeat_run_after_script: {
      recommended: cheapestAlt ? "Auto or `" + cheapestAlt.model + "`" : "current model with Auto",
      reason: cheapestAlt ? "Once deterministic steps are scripted, the model handles only exceptions and review." : "No cheaper realistic alternative projected.",
    },
    auto_mode: {
      recommended: autoFitVerdict !== "poor",
      reason: autoFitVerdict === "good"
        ? "Drift was minimal; Auto's first-call pick likely holds across the session."
        : autoFitVerdict === "borderline"
          ? "Some drift detected; Auto may stay on the same tier or step up mid-session. Quote the floor cost."
          : "Significant drift detected; if Auto picked a lighter model from the first prompt it would have under-served later turns. Use same-model floor as realistic Auto cost.",
    },
    do_not_claim: cheapestAlt ? "Do not claim `" + cheapestAlt.model + "` is definitely sufficient because quality validation data is missing." : "Do not claim a cheaper model is sufficient without quality validation data.",
  };

  const developerActionSummary = {
    primary_message: primaryMessage,
    top_developer_levers: topDeveloperLevers,
  };

  // ---- Spec-aligned derived blocks -------------------------------------
  // These translate the existing derivations into the JSON shapes the spec
  // requires (custom_mode_or_agent_analysis, ide_tool_configuration_analysis,
  // skills_profile_analysis, prompt_strategy_recommendation,
  // quality_and_validation, recommended_changes). They reuse the same
  // upstream signals; nothing here adds new measurement.

  // Tool-family classification for ide_tool_configuration_analysis.disable_by_family.
  // Substring match over canonical VS Code Copilot Chat tool names.
  function classifyToolFamily(name: string): string {
    const n = name.toLowerCase();
    if (n.includes("notebook") || n.includes("jupyter")) return "notebook";
    if (n.includes("renamesymbol") || n.includes("rename_symbol") || (n.includes("symbol") && !n.includes("symbols_search")) || n.includes("definition") || n.includes("references") || n.includes("usages")) return "code_navigation_refactor";
    if (n.includes("terminal") || n.includes("shell") || n.includes("bash") || n.includes("powershell")) return "terminal";
    if (n.includes("task") && !n.includes("multitask")) return "task_automation";
    if (n.includes("search") || n.includes("grep") || n.includes("find")) return "search";
    if (n.includes("create_file") || n.includes("create") || n.includes("edit_file") || n.includes("edit") || n.includes("replace") || n.includes("delete_file") || n.includes("insert")) return "file_editing";
    if (n.includes("image") || n.includes("view_image") || n === "view") return "image_media";
    return "unknown";
  }
  const familyMembership: Record<string, string[]> = {};
  unused.unused.forEach(t => {
    const fam = classifyToolFamily(t);
    if (!familyMembership[fam]) familyMembership[fam] = [];
    familyMembership[fam].push(t);
  });
  const familyReasons: Record<string, string> = {
    notebook: "No notebook work occurred in this session.",
    code_navigation_refactor: "This was not a codebase navigation or symbol refactor task.",
    terminal: "Terminal tools were unused; the workflow did not need shell access.",
    task_automation: "Task automation tools were unused.",
    search: "Search tools were unused.",
    file_editing: "File-editing tools were unused.",
    image_media: "Image/media tools were unused.",
    unknown: "These tools were unused and could not be classified into a known family.",
  };
  const disableByFamily = Object.entries(familyMembership)
    .filter(([, tools]) => tools.length > 0)
    .map(([family, tools]) => ({
      family,
      tools: tools.slice(0, 8),
      reason: familyReasons[family] || "Unused in this session.",
    }));
  const idePriority = unusedToolPctOfSession >= 10 ? "high" : unusedToolPctOfSession >= 3 ? "medium" : "low";
  const ideToolConfigurationAnalysis = {
    tools_offered_count: unused.offeredAll.size,
    tools_used_count: unused.used.size,
    unused_tools_count: unused.unused.length,
    tool_profile_too_broad: unused.unused.length > 5,
    recommended_tools_to_keep: Array.from(unused.used).sort(),
    recommended_tools_to_disable: unused.unused.slice(0, 12),
    disable_by_family: disableByFamily,
    estimated_cost_share_pct: Number(unusedToolPctOfSession.toFixed(2)),
    estimated_cost_share_usd: Number(unusedToolUsd.toFixed(4)),
    confidence: unused.unused.length > 0 ? "high" : "medium",
    priority: idePriority,
  };

  // Custom mode / agent analysis. Full prompt is not available -- we list
  // unknown behavior dimensions honestly rather than guessing.
  const customModeOrAgentAnalysis = {
    active: !!firstChatMode,
    name: firstChatMode ? firstChatMode.name : null,
    type: firstChatMode ? "custom_chat_mode" : "none",
    full_prompt_available: false,
    summary_available: false,
    chars_estimate: firstChatMode ? (firstChatMode.tokensEst || 0) : 0,
    known_behavior: firstChatMode
      ? ["custom chat mode by name `" + firstChatMode.name + "`", "estimated prompt size ~" + (firstChatMode.tokensEst || 0).toLocaleString() + " tokens"]
      : [],
    unknown_behavior: firstChatMode
      ? [
        "confirmation policy (when does the agent ask vs execute)",
        "tool policy (which tools the chat mode whitelists)",
        "cost policy (any explicit cost / thinking budget rules)",
        "output schema (any required output format)",
        "extended-thinking discipline (brief vs deep)",
      ]
      : [],
    recommended_focus: firstChatMode
      ? "Improve the active chat mode `" + firstChatMode.name + "` rather than lengthening the visible prompt."
      : "No custom chat mode active. Consider adding one if this kind of session recurs.",
    specific_recommendations: customChatModeRecommendations,
    confidence: firstChatMode ? "high" : "high",
    note: firstChatMode
      ? "Full prompt not available; recommend storing a redacted summary or hash in future exports so the analyst can speak to specific locked behaviors."
      : null,
  };

  // Skills profile analysis (spec-named view over skill_usage).
  const skillsProfileAnalysis = {
    skills_attached_count: skillCarry.skillCount,
    skills_used_count: skillCarry.usedCount,
    skills_unused_count: skillCarry.unusedCount,
    skill_profile_too_broad: skillCarry.unusedCount >= 5,
    largest_unused_skills: largestUnusedSkills,
    estimated_unused_cost_usd: Number(unusedSkillUsd.toFixed(4)),
    estimated_unused_cost_share_pct: Number(unusedSkillPctOfSession.toFixed(2)),
    skill_attachment_source: "unknown_not_recorded_in_export",
    recommended_action: skillCarry.unusedCount > 0
      ? "Remove unrelated skills from whichever surface attached them (custom agent skills config, VS Code skill profile, workspace, or global profile)."
      : "Skill profile already narrow for this session.",
    priority: skillsPriority,
    confidence: "high",
    caveat: "The export does not record which surface attached each skill, so the developer must locate the attaching surface manually before pruning.",
  };

  // Prompt strategy recommendation -- mostly templated, with derived
  // example_inline_prompt by workflow type.
  let exampleInlinePrompt: string;
  if (workflowType === "repeatable_file_processing") {
    exampleInlinePrompt = "Process the files in <folder> using the standard workflow. Keep intermediate output compact and ask only about ambiguous items.";
  } else if (workflowType === "debugging") {
    exampleInlinePrompt = "Reproduce the failure in <test or file>, identify the root cause, and propose a minimal fix. Show the diff before applying.";
  } else if (workflowType === "research_and_summarization") {
    exampleInlinePrompt = "Summarize <topic / files> in <=10 bullets. Cite file paths or URLs for each claim.";
  } else if (workflowType === "code_generation") {
    exampleInlinePrompt = "Generate <component> in <path>. Match the existing style. Show the diff before writing files.";
  } else {
    exampleInlinePrompt = "Describe the scope of this task in 1-2 sentences and the output format you want.";
  }
  const promptStrategyRecommendation = {
    inline_prompt_role: "session-specific scope and output-shape constraints only",
    custom_mode_role: "workflow policy, tool policy, cost / thinking budget policy, confirmation policy, output schema",
    repo_instructions_role: "repo-specific conventions and stable project rules that apply to every chat in this workspace",
    custom_skill_role: "reusable multi-step capability invoked on demand",
    script_role: "deterministic repeatable execution outside the agent loop",
    example_inline_prompt: exampleInlinePrompt,
    inline_prompt_priority: inlinePromptPriority,
    confidence: "medium",
    note: firstChatMode
      ? "A custom chat mode is active, so inline-prompt priority is low. Use the chat mode for workflow policy."
      : "No custom chat mode active. Inline prompt is currently the only instruction surface aside from repo instructions.",
  };

  // Quality and validation -- honest not_available block.
  const qualityAndValidation = {
    available: false,
    impact_on_report: "Without quality validation, the report cannot recommend cheaper models, more aggressive automation, or reduced reasoning with confidence.",
    recommended_future_capture: [
      "tests passed / failed",
      "files changed as expected",
      "user accepted the result without correction",
      "post-session corrections",
      "lint / typecheck clean",
      "validation script result",
    ],
    confidence: "not_available",
  };

  // Unified recommended_changes -- aggregate per-surface recommendations
  // into one list the analyst can render verbatim.
  const recommendedChanges: Record<string, unknown>[] = [];
  customChatModeRecommendations.forEach(r => {
    const rec = r as { problem: string; add_to_chat_mode: string; expected_impact: string; evidence: string[] };
    recommendedChanges.push({
      surface: ".chatmode.md",
      change_type: "add_instruction",
      title: rec.problem,
      snippet: rec.add_to_chat_mode,
      why: rec.problem,
      evidence: rec.evidence,
      expected_impact: rec.expected_impact,
      confidence: "medium",
    });
  });
  ideConfigRecommendations.forEach(r => {
    const rec = r as { surface: string; action: string; tools?: string[]; tools_to_keep?: string[]; reason: string; expected_impact: string };
    recommendedChanges.push({
      surface: rec.surface === "custom chat mode tool whitelist" ? ".chatmode.md" : "VS Code Configure Tools",
      change_type: "disable_tools",
      title: rec.action,
      snippet: rec.tools_to_keep
        ? "Whitelist only these tools: " + rec.tools_to_keep.map(t => "`" + t + "`").join(", ")
        : "Disable these tools (or a stricter subset): " + (rec.tools || []).map(t => "`" + t + "`").join(", "),
      why: rec.reason,
      evidence: rec.tools ? [rec.tools.length + " unused tools in family"] : [],
      expected_impact: rec.expected_impact,
      confidence: "high",
    });
  });
  skillsProfileRecommendations.forEach(r => {
    const rec = r as { surface: string; action: string; skills_to_remove_first: string[]; reason: string; expected_impact: string; caveat: string };
    recommendedChanges.push({
      surface: "skill profile",
      change_type: "remove_skills",
      title: rec.action,
      snippet: "Remove these skills first: " + rec.skills_to_remove_first.map(s => "`" + s + "`").join(", "),
      why: rec.reason,
      evidence: [rec.caveat],
      expected_impact: rec.expected_impact,
      confidence: "high",
    });
  });
  if (automationBoundary) {
    const ab = automationBoundary as { summary: string; should_script: string[]; evidence: (string | null)[]; confidence: string };
    recommendedChanges.push({
      surface: "repo script",
      change_type: "create_script",
      title: "Script the deterministic steps of this workflow",
      snippet: "Move these steps into a script: " + ab.should_script.slice(0, 5).join(", ") + ". Keep the model for ambiguous interpretation and review.",
      why: ab.summary,
      evidence: ab.evidence.filter(Boolean) as string[],
      expected_impact: "large for repeated use",
      confidence: ab.confidence,
    });
  }
  if (cheapestAlt && autoOptimalSavings != null && autoOptimalSavings > 0.05) {
    recommendedChanges.push({
      surface: "model selector / Auto mode",
      change_type: "change_model_strategy",
      title: "Try Auto or `" + cheapestAlt.model + "` for repeat runs after validation",
      snippet: "Once deterministic steps are scripted and a quality check exists, try Auto mode or `" + cheapestAlt.model + "` for repeat runs. Compare output quality before switching permanently.",
      why: "Projected savings exist on this token shape, but quality is not proven without validation data.",
      evidence: ["projected savings ~$" + autoOptimalSavings.toFixed(4), "alt model: " + cheapestAlt.model + " (" + cheapestAlt.category + " tier)"],
      expected_impact: autoOptimalSavings > 0.20 ? "moderate" : "small",
      confidence: "low",
    });
  }
  recommendedChanges.push({
    surface: "validation pipeline",
    change_type: "add_validation",
    title: "Capture a validation signal at end of session",
    snippet: "Record test results, lint/typecheck, user acceptance, and any post-session corrections so future analysis can recommend cheaper models or more automation with confidence.",
    why: "Efficiency without correctness is not meaningful. Quality data unlocks the cheaper-model and more-automation recommendations.",
    evidence: ["quality_and_validation.available == false"],
    expected_impact: "enables stronger recommendations next time",
    confidence: "high",
  });

  // ===================== Generic spec-aligned blocks =====================
  // These blocks are intentionally workflow-agnostic. They derive only from
  // measured per-turn data so the same shape works for coding, file
  // processing, research, debugging, writing, data analysis, and so on.

  // -- Workflow phase analysis (heuristic) --------------------------------
  // Map each tool family to one of the spec's generic phase names.
  function phaseForToolFamily(family: string): string {
    if (family === "search" || family === "code_navigation_refactor") return "information_gathering";
    if (family === "terminal" || family === "task_automation" || family === "notebook") return "tool_or_command_execution";
    if (family === "file_editing") return "file_or_artifact_creation";
    if (family === "image_media") return "data_extraction";
    return "unknown";
  }
  type ChatEvent = CostAnalysisCall & { kind: "llm" };
  const perTurnEvents: ChatEvent[] = chatEvents as ChatEvent[];
  const turnPhases = perTurnEvents.map((ev, idx) => {
    const turn = idx + 1;
    const tools = ev.producedToolCalls || [];
    const familyCounts = new Map<string, number>();
    tools.forEach(tc => {
      const fam = classifyToolFamily(tc.name);
      familyCounts.set(fam, (familyCounts.get(fam) || 0) + 1);
    });
    const phaseWeights = new Map<string, number>();
    familyCounts.forEach((cnt, fam) => {
      const phase = phaseForToolFamily(fam);
      phaseWeights.set(phase, (phaseWeights.get(phase) || 0) + cnt);
    });
    const visible = ev.visibleResponseChars || 0;
    const thinking = ev.thinkingChars || 0;
    // No tools and a short visible reply on the first turn = task_understanding.
    // No tools and a long visible reply = final_response / review_or_synthesis.
    if (tools.length === 0) {
      if (turn === 1) phaseWeights.set("task_understanding", 1);
      else if (visible >= 800) phaseWeights.set("review_or_synthesis", 1);
      else if (visible > 0) phaseWeights.set("final_response", 1);
      else phaseWeights.set("unknown", 1);
    }
    // Heavy hidden reasoning relative to tool count = planning weight.
    if (thinking >= 4000 && tools.length <= 2) {
      phaseWeights.set("planning", (phaseWeights.get("planning") || 0) + 1);
    }
    const totalWeight = Array.from(phaseWeights.values()).reduce((a, b) => a + b, 0) || 1;
    const phaseMix = Array.from(phaseWeights.entries())
      .map(([phase, w]) => ({ phase, weight: Number((w / totalWeight).toFixed(2)) }))
      .sort((a, b) => b.weight - a.weight)
      .slice(0, 2);
    const primary = phaseMix[0]?.phase || "unknown";
    return {
      turn,
      primary_phase: primary,
      phase_mix: phaseMix,
      cost_usd: Number((ev.cost || 0).toFixed(4)),
      chat_calls: 1,
      tool_calls: tools.length,
      output_tokens: ev.output || 0,
      thinking_chars: thinking,
      tool_result_chars: ev.componentChars?.tool_results || 0,
    };
  });
  // Aggregate per-phase totals across the session.
  const phaseAggregate = new Map<string, { phase: string; turns: number[]; cost_usd: number; chat_calls: number; tool_calls: number; output_tokens: number; thinking_chars: number; tool_result_chars: number }>();
  turnPhases.forEach(t => {
    const key = t.primary_phase;
    const cur = phaseAggregate.get(key) || { phase: key, turns: [], cost_usd: 0, chat_calls: 0, tool_calls: 0, output_tokens: 0, thinking_chars: 0, tool_result_chars: 0 };
    cur.turns.push(t.turn);
    cur.cost_usd += t.cost_usd;
    cur.chat_calls += t.chat_calls;
    cur.tool_calls += t.tool_calls;
    cur.output_tokens += t.output_tokens;
    cur.thinking_chars += t.thinking_chars;
    cur.tool_result_chars += t.tool_result_chars;
    phaseAggregate.set(key, cur);
  });
  const phaseList = Array.from(phaseAggregate.values()).map(p => ({
    ...p,
    cost_usd: Number(p.cost_usd.toFixed(4)),
  })).sort((a, b) => b.cost_usd - a.cost_usd);
  const largestCostPhase = phaseList[0]?.phase || null;
  const largestContextGrowthPhase = (() => {
    let best: { phase: string; chars: number } | null = null;
    phaseAggregate.forEach(p => {
      const chars = p.tool_result_chars + p.thinking_chars;
      if (!best || chars > best.chars) best = { phase: p.phase, chars };
    });
    return best ? (best as { phase: string; chars: number }).phase : null;
  })();
  const workflowPhaseAnalysis = perTurnEvents.length > 0 ? {
    available: true,
    phase_detection_method: "heuristic_tool_family_plus_visible_reply",
    per_turn: turnPhases,
    phases: phaseList,
    largest_cost_phase: largestCostPhase,
    largest_context_growth_phase: largestContextGrowthPhase,
    confidence: "medium",
    caveats: [
      "Phases are inferred from tool families and visible-reply size. A turn often mixes phases; `phase_mix` shows the top-2 phases with weights.",
      "If `primary_phase == \"unknown\"`, the heuristic could not classify the turn.",
    ],
  } : { available: false, reason: "No chat calls in this session." };

  // -- Agent-loop efficiency ---------------------------------------------
  const noToolCalls = perTurnEvents.filter(ev => (ev.producedToolCalls || []).length === 0);
  const noToolNoVisibleOutputCalls = noToolCalls.filter(ev => (ev.visibleResponseChars || 0) < 40);
  const visibleReplyEmptyOrTinyCalls = perTurnEvents.filter(ev => (ev.visibleResponseChars || 0) < 40).length;
  const longInternalProcessingCalls = perTurnEvents
    .map((ev, idx) => ({
      turn: idx + 1,
      thinking_chars: ev.thinkingChars || 0,
      output_tokens: ev.output || 0,
      cost_usd: Number((ev.cost || 0).toFixed(4)),
    }))
    .filter(t => t.thinking_chars >= 6000 || (t.output_tokens >= 4000 && t.cost_usd >= 0.05));
  const chatCallsForShape = perTurnEvents.length;
  const callShapeAssessment = chatCallsForShape === 0 ? "not_enough_data"
    : chatCallsForShape <= 2 ? "efficient_single_pass"
    : longInternalProcessingCalls.length >= 2 ? "hidden_deliberation_spike"
    : chatCallsForShape >= 10 && noToolNoVisibleOutputCalls.length >= 3 ? "many_model_turns_for_repeatable_workflow"
    : (() => {
        const termCount = perTurnEvents.reduce((a, ev) => a + (ev.producedToolCalls || []).filter(tc => classifyToolFamily(tc.name) === "terminal").length, 0);
        return termCount >= Math.max(totals.toolCalls * 0.5, 5) && totals.toolCalls >= 8 ? "terminal_heavy_orchestration" : null;
      })() || (totals.toolCalls >= chatCallsForShape * 1.5 ? "tool_heavy_but_expected" : "reasonable_interactive_session");
  const recommendedTargetShape = callShapeAssessment === "many_model_turns_for_repeatable_workflow"
    ? { chat_calls: "3-5", description: "Workflow looks repeatable. Move deterministic steps to scripts so the model only handles ambiguity and final review." }
    : callShapeAssessment === "hidden_deliberation_spike"
    ? { chat_calls: String(chatCallsForShape), description: "Call count is fine; reduce per-call deliberation. Lower reasoning effort, instruct the model to think briefly, or split into smaller sub-tasks." }
    : callShapeAssessment === "terminal_heavy_orchestration"
    ? { chat_calls: String(Math.max(3, Math.ceil(chatCallsForShape / 3))), description: "Most tool calls are terminal commands the model is orchestrating step by step. Bundle them into a shell script or Makefile and have the model invoke the script once." }
    : callShapeAssessment === "tool_heavy_but_expected"
    ? { chat_calls: String(chatCallsForShape), description: "Tool-heavy shape is appropriate for this workflow." }
    : { chat_calls: String(chatCallsForShape), description: "Current loop shape looks reasonable for an interactive session." };
  const agentLoopEfficiency = {
    chat_calls: chatCallsForShape,
    tool_calls: totals.toolCalls,
    no_tool_calls: noToolCalls.length,
    visible_reply_empty_or_tiny_calls: visibleReplyEmptyOrTinyCalls,
    no_tool_no_visible_output_calls: noToolNoVisibleOutputCalls.length,
    long_internal_processing_calls: longInternalProcessingCalls.slice(0, 5),
    call_shape_assessment: callShapeAssessment,
    recommended_target_shape: recommendedTargetShape,
    confidence: "measured",
  };

  // -- Tool result size analysis (per-turn aggregate) --------------------
  // We only have per-CHAT-CALL aggregates of all tool results combined, not
  // per-individual-tool-call stdout/stderr. State that limitation here so
  // the analyst does not overclaim ("turn X's combined tool results", not
  // "tool Y returned").
  function operationKindForTools(tools: string[]): string {
    if (tools.length === 0) return "unknown";
    const fams = tools.map(classifyToolFamily);
    if (fams.includes("file_editing")) return "artifact_creation";
    if (fams.includes("terminal")) return "terminal_command";
    if (fams.includes("search")) return "search";
    if (fams.includes("code_navigation_refactor")) return "data_extraction";
    if (fams.includes("notebook")) return "data_transformation";
    if (fams.includes("image_media")) return "data_extraction";
    return "unknown";
  }
  const perTurnToolResults = perTurnEvents.map((ev, idx) => {
    const tools = (ev.producedToolCalls || []).map(tc => tc.name);
    return {
      turn: idx + 1,
      tool_names: tools,
      operation_kind: operationKindForTools(tools),
      tool_result_chars: ev.componentChars?.tool_results || 0,
      carried_into_context: (ev.componentChars?.tool_results || 0) > 0,
    };
  });
  const largestToolResultTurns = [...perTurnToolResults]
    .filter(t => t.tool_result_chars > 0)
    .sort((a, b) => b.tool_result_chars - a.tool_result_chars)
    .slice(0, 5);
  const totalToolResultChars = perTurnToolResults.reduce((a, t) => a + t.tool_result_chars, 0);
  const avgToolResultChars = perTurnToolResults.length > 0 ? Math.round(totalToolResultChars / perTurnToolResults.length) : 0;
  const bloatAssessment = avgToolResultChars >= 5000 ? "high" : avgToolResultChars >= 1500 ? "moderate" : "low";
  const toolResultSizeAnalysis = {
    available: true,
    granularity: "per_chat_call_aggregate",
    granularity_caveat: "Tool result chars are summed across all tool calls inside a single chat call. We cannot attribute bloat to one specific tool invocation. See missing_data.per_command_tool_output_size.",
    per_turn: perTurnToolResults,
    largest_turns: largestToolResultTurns,
    total_tool_result_chars: totalToolResultChars,
    avg_tool_result_chars_per_chat_call: avgToolResultChars,
    bloat_assessment: bloatAssessment,
    confidence: "measured",
  };

  // -- Baseline comparison (placeholder until UI wiring) -----------------
  const baselineComparison = opts.baseline
    ? { available: true, reason: "Baseline wiring not yet implemented; placeholder for future Compare-view integration." }
    : { available: false, reason: "No baseline session was provided. To enable iteration-aware analysis, pass a second session through the Compare view (planned)." };

  // -- Experiment validity ------------------------------------------------
  // If the caller declared an expected setup (intended chat mode, agent,
  // model, tool whitelist), check whether the session actually ran under
  // it. Mismatches invalidate "did the optimization work?" comparisons.
  const expected = opts.expected || {};
  const actualChatMode = firstChatMode ? firstChatMode.name : null;
  const actualModel = chosenModelName || null;
  const offeredToolNames = new Set<string>();
  prompts.forEach(p => p.events.forEach(e => {
    if (e.kind === "llm") {
      (e.toolGroups || []).forEach(g => g.tools.forEach(t => offeredToolNames.add(t.name)));
    }
  }));
  const mismatches: { field: string; expected: string; actual: string }[] = [];
  if (expected.chatModeName != null) {
    if ((actualChatMode || "") !== expected.chatModeName) {
      mismatches.push({ field: "chat_mode", expected: expected.chatModeName, actual: actualChatMode || "(none)" });
    }
  }
  if (expected.customAgentName != null) {
    // We do not detect custom agents separately today. Declare honestly.
    mismatches.push({ field: "custom_agent", expected: expected.customAgentName, actual: "not_detected_by_parser" });
  }
  if (expected.modelName != null) {
    if ((actualModel || "") !== expected.modelName) {
      mismatches.push({ field: "model", expected: expected.modelName, actual: actualModel || "(unknown)" });
    }
  }
  if (expected.toolWhitelist && expected.toolWhitelist.length > 0) {
    const extras = Array.from(offeredToolNames).filter(t => !expected.toolWhitelist!.includes(t));
    if (extras.length > 0) {
      mismatches.push({ field: "tool_whitelist", expected: expected.toolWhitelist.join(","), actual: "extras_present: " + extras.slice(0, 8).join(",") + (extras.length > 8 ? " ..." : "") });
    }
  }
  const expectationProvided = expected.chatModeName != null || expected.customAgentName != null || expected.modelName != null || (expected.toolWhitelist && expected.toolWhitelist.length > 0);
  const experimentValidity = {
    available: !!expectationProvided,
    expected: expectationProvided ? {
      chat_mode: expected.chatModeName || null,
      custom_agent: expected.customAgentName || null,
      model: expected.modelName || null,
      tool_whitelist_size: expected.toolWhitelist ? expected.toolWhitelist.length : null,
    } : null,
    actual: expectationProvided ? {
      chat_mode: actualChatMode,
      custom_agent: "not_detected_by_parser",
      model: actualModel,
      tools_offered_count: offeredToolNames.size,
    } : null,
    mismatches,
    valid_for_agent_prompt_evaluation: expectationProvided ? !mismatches.some(m => m.field === "chat_mode" || m.field === "custom_agent") : null,
    valid_for_model_evaluation: expectationProvided ? !mismatches.some(m => m.field === "model") : null,
    valid_for_tool_profile_evaluation: expectationProvided ? !mismatches.some(m => m.field === "tool_whitelist") : null,
    reason: expectationProvided ? null : "No expected setup was provided; cannot check experiment validity. Pass `opts.expected` to enable.",
  };

  // -- Control-surface analysis (aggregator over recommended_changes) ----
  const outOfScopeSurfaces = new Set((opts.outOfScopeSurfaces || []).map(s => s.toLowerCase()));
  function canonSurface(surface: string): string {
    const s = surface.toLowerCase();
    if (s.includes("chatmode") || s.includes("chat mode")) return "custom_chat_mode";
    if (s.includes("configure tools") || s.includes("ide_tools")) return "tool_configuration";
    if (s.includes("skill")) return "skills_or_extensions";
    if (s.includes("repo script") || s.includes("script")) return "scripts_or_automation";
    if (s.includes("agents.md") || s.includes("copilot-instructions")) return "repo_instructions";
    if (s.includes("inline") || s.includes("prompt")) return "inline_prompt";
    if (s.includes("model")) return "model_selection";
    if (s.includes("validation")) return "validation_pipeline";
    return "other";
  }
  const recsBySurface: Record<string, { surface: string; controllable: boolean; recommendations: Record<string, unknown>[] }> = {};
  recommendedChanges.forEach(r => {
    const rec = r as { surface: string };
    const key = canonSurface(rec.surface);
    if (!recsBySurface[key]) {
      recsBySurface[key] = { surface: key, controllable: !outOfScopeSurfaces.has(key), recommendations: [] };
    }
    recsBySurface[key].recommendations.push(r);
  });
  const externalOrFixed: { surface: string; reason: string }[] = [];
  outOfScopeSurfaces.forEach(s => {
    externalOrFixed.push({ surface: s, reason: "Marked out of scope by the caller. Treat as fixed or external overhead, not as a recommended action." });
  });
  const controlSurfaceAnalysis = {
    available: true,
    surfaces: Object.values(recsBySurface),
    external_or_not_controllable: externalOrFixed,
    note: "Each recommendation in `recommended_changes` has a `surface` field. This block groups them and marks any surface the caller listed in `opts.outOfScopeSurfaces` as not controllable. The analyst should de-emphasize recommendations whose surface is not controllable.",
  };

  // -- Automation boundary extensions -------------------------------------
  // Detect deterministic indicators on top of the existing
  // `automationBoundary` block: scripts/tools created in the session,
  // raw large data carried into chat. These are heuristic.
  const fileCreateNames: string[] = [];
  perTurnEvents.forEach(ev => {
    (ev.producedToolCalls || []).forEach(tc => {
      if (classifyToolFamily(tc.name) === "file_editing") {
        const args = tc.argsSummary || "";
        const match = args.match(/[\w\-./]+\.(sh|bash|zsh|py|js|ts|mjs|cjs|mk|Makefile|ps1|rb)\b/);
        if (match) fileCreateNames.push(match[0]);
      }
    });
  });
  const scriptsOrToolsCreated = Array.from(new Set(fileCreateNames));
  const rawLargeDataCarriedInChat = toolResultSizeAnalysis.available && toolResultSizeAnalysis.bloat_assessment !== "low";
  const automationBoundaryExtensions = {
    scripts_or_tools_created: scriptsOrToolsCreated,
    scripts_or_tools_reused: [] as string[],
    raw_large_data_carried_in_chat: rawLargeDataCarriedInChat,
    raw_large_data_signal: rawLargeDataCarriedInChat
      ? "Tool-result bloat is " + toolResultSizeAnalysis.bloat_assessment + " (avg " + toolResultSizeAnalysis.avg_tool_result_chars_per_chat_call + " chars/call). Large raw tool output is flowing back into the model's context."
      : "No significant raw-data carry detected from tool results.",
    confidence: "low",
    caveat: "Heuristic detection from tool-name + filename patterns. The export does not track script re-use or distinguish authored scripts from regenerated content.",
  };

  // -- Session narrative (raw user objective + compressed agent path) ----
  // The analyst LLM writes the prose; we just guarantee it has the
  // structured data. Generic across session kinds: any session has a
  // user objective and an agent path; the same shape works for coding,
  // research, debugging, writing, data analysis.
  const narrativeUserMessages = aggregateUserMessages(prompts);
  // Compress consecutive same-phase turns from turnPhases into groups.
  type PathGroup = { turns: string; phase: string; cost_usd: number; tool_calls: number; tool_names: string[]; output_tokens: number; tool_result_chars: number };
  const pathGroups: PathGroup[] = [];
  turnPhases.forEach((tp, idx) => {
    const ev = perTurnEvents[idx];
    const toolNames = (ev.producedToolCalls || []).map(tc => tc.name);
    const last = pathGroups[pathGroups.length - 1];
    const sameAsLast = last && last.phase === tp.primary_phase;
    if (sameAsLast) {
      const lastRange = last.turns.includes("-") ? last.turns.split("-")[0] : last.turns;
      last.turns = lastRange + "-" + String(tp.turn);
      last.cost_usd = Number((last.cost_usd + tp.cost_usd).toFixed(4));
      last.tool_calls += tp.tool_calls;
      toolNames.forEach(n => { if (!last.tool_names.includes(n)) last.tool_names.push(n); });
      last.output_tokens += tp.output_tokens;
      last.tool_result_chars += tp.tool_result_chars;
    } else {
      pathGroups.push({
        turns: String(tp.turn),
        phase: tp.primary_phase,
        cost_usd: Number(tp.cost_usd.toFixed(4)),
        tool_calls: tp.tool_calls,
        tool_names: [...toolNames],
        output_tokens: tp.output_tokens,
        tool_result_chars: tp.tool_result_chars,
      });
    }
  });
  // Artifact ledger: extract file paths from file-editing tool args.
  const artifactsCreatedSet = new Set<string>();
  perTurnEvents.forEach(ev => {
    (ev.producedToolCalls || []).forEach(tc => {
      if (classifyToolFamily(tc.name) === "file_editing") {
        const args = tc.argsSummary || "";
        const pathMatch = args.match(/(?:[\w./~-]+\/)?[\w-]+\.[A-Za-z0-9]+/g);
        if (pathMatch) pathMatch.slice(0, 3).forEach(p => artifactsCreatedSet.add(p));
      }
    });
  });
  const artifactsCreated = Array.from(artifactsCreatedSet).slice(0, 20);
  // Outcome heuristic: did the session end on artifact creation, on review,
  // or unclear? Useful for the analyst to frame "outcome" without inventing.
  const lastTurn = turnPhases[turnPhases.length - 1];
  const outcomeSignal = !lastTurn
    ? "no chat turns"
    : lastTurn.primary_phase === "file_or_artifact_creation"
    ? "session ended on artifact creation; no validation captured"
    : lastTurn.primary_phase === "final_response" || lastTurn.primary_phase === "review_or_synthesis"
    ? "session ended on a written response; no validation captured"
    : "session ended on " + lastTurn.primary_phase + "; outcome quality not captured";
  const sessionNarrative = {
    user_objective: {
      first_user_message: narrativeUserMessages[0]?.text || null,
      follow_up_messages: narrativeUserMessages.slice(1, 6).map(m => ({ turn: m.turn, text: truncate(m.text, USER_MSG_CHAR_CAP) })),
      message_count: narrativeUserMessages.length,
      note: "Use these messages to write a one-sentence `inferred_objective` in the What-happened section. Quote the first message verbatim if it is concise.",
    },
    agent_path_compressed: pathGroups,
    artifacts_created: artifactsCreated,
    artifacts_caveat: "Heuristic extraction from file-editing tool args. May include paths that were read or referenced rather than created. May miss artifacts whose name is not in the visible args summary.",
    outcome_signal: outcomeSignal,
    note_for_analyst: "Write the What-happened section as 2-4 sentences. Frame: (1) the user objective (one sentence), (2) the agent's path in 1-2 sentences using phase + tool clues, (3) the outcome line. Do not list every turn; collapse the compressed path into prose.",
  };

  // -- Cache health (hit rate + verdict) ----------------------------------
  // Cached input is billed at a fraction of fresh input (typically ~10% for
  // Anthropic, 10% for OpenAI per the pricing table). High cache reuse on a
  // long session means the prefix is stable and the savings are real, but
  // it does NOT mean the long prefix is free.
  const totalIn = totals.promptTokens || 0;
  const totalCached = totals.cached || 0;
  const cacheHitRate = totalIn > 0 ? totalCached / totalIn : 0;
  const cacheVerdict = totalIn < 1000
    ? "not_applicable"
    : cacheHitRate >= 0.85
    ? "excellent"
    : cacheHitRate >= 0.6
    ? "healthy"
    : cacheHitRate >= 0.3
    ? "partial"
    : "poor";
  const cacheGuidance = cacheVerdict === "excellent" || cacheVerdict === "healthy"
    ? "Cache is doing its job. The prefix is stable across calls. Focus optimization on shrinking the prefix and cutting call count, not on cache strategy."
    : cacheVerdict === "partial"
    ? "Cache is helping but something is shifting the prefix mid-session (skill order, tool list, dynamic instructions). Stabilize the prefix to lift the hit rate."
    : cacheVerdict === "poor"
    ? "Cache is not engaging. The prefix likely changes every call (timestamps, dynamic IDs, reordered tools/skills). Investigate before any other optimization."
    : "Session too short to draw cache conclusions.";
  const cacheHealth = {
    available: totalIn > 0,
    cache_hit_rate: Number(cacheHitRate.toFixed(3)),
    cache_hit_rate_pct: Math.round(cacheHitRate * 100),
    cached_input_tokens: totalCached,
    billed_input_tokens: totalIn,
    verdict: cacheVerdict,
    guidance: cacheGuidance,
    note: "Cached tokens are still billed (typically ~10% of fresh-input rate). Caching reduces unit cost; it does not make a long stable prefix free.",
  };

  // -- Every-call overhead (estimated stable-prefix tokens per call) -------
  // The stable prefix is what gets paid on every chat call: chat-mode text,
  // repo instructions, tool definitions, attached skills, plus carried
  // history once it stops changing. We approximate it as `cached / chat_calls`,
  // which is a tight lower bound when cache hit rate is high.
  const prefixTokensPerCall = chatCallCount > 0 ? Math.round(totalCached / chatCallCount) : 0;
  const chosenCachedRateForOverhead = chosenPriceRow ? chosenPriceRow.cachedInputPerMTok : 0;
  const prefixCostPerCallUsd = Number(((prefixTokensPerCall / 1e6) * chosenCachedRateForOverhead).toFixed(5));
  const prefixCostTotalUsd = Number((prefixCostPerCallUsd * chatCallCount).toFixed(4));
  const prefixPctOfSession = totals.cost > 0 ? Number(((prefixCostTotalUsd / totals.cost) * 100).toFixed(1)) : 0;
  const everyCallOverhead = {
    available: chatCallCount > 0 && totalCached > 0,
    chat_calls: chatCallCount,
    estimated_stable_prefix_tokens_per_call: prefixTokensPerCall,
    estimated_prefix_cost_per_call_usd: prefixCostPerCallUsd,
    estimated_prefix_cost_total_usd: prefixCostTotalUsd,
    estimated_prefix_pct_of_session: prefixPctOfSession,
    composition_hints: {
      attached_skills_count: skillCarry.skillCount || 0,
      unused_skills_count: skillCarry.unusedCount || 0,
      unused_tools_count: unused.unused.length || 0,
      custom_chat_mode_active: !!firstChatMode,
      repo_instructions_active: instructions.length > 0,
    },
    note: "Approximation: cached_tokens / chat_calls. Tight lower bound when cache hit rate is high. Use to size the every-call overhead lever (prune skills, prune tools, slim chat mode, shrink repo instructions) vs the per-call workflow lever (shrink history, scripting).",
  };

  // -- Cost projection (1x / 10x / 100x current + rough after-fix) --------
  // Helps the developer decide whether to invest in optimization. The
  // after-fix estimate is intentionally rough: it assumes the workflow
  // shape recommendation lands (target chat-call count from
  // agent_loop_efficiency) and that setup overhead is removed. Quality
  // and validity must still be proven separately.
  const currentRunCost = Number(totals.cost.toFixed(4));
  let afterFixCostEstimate: number | null = null;
  let afterFixAssumptions: string[] = [];
  const targetShapeRaw = recommendedTargetShape?.chat_calls || null;
  const targetCallsLow = targetShapeRaw ? Number(String(targetShapeRaw).split(/[-–]/)[0]) : null;
  if (chatCallCount > 0 && targetCallsLow && targetCallsLow > 0 && currentRunCost > 0) {
    const callShrinkRatio = targetCallsLow / chatCallCount;
    const overheadShare = (unusedToolPctOfSession + unusedSkillPctOfSession) / 100;
    afterFixCostEstimate = Number((currentRunCost * callShrinkRatio * (1 - overheadShare)).toFixed(4));
    afterFixAssumptions = [
      "chat calls drop from " + chatCallCount + " to ~" + targetCallsLow + " (workflow scripted, per agent_loop_efficiency.recommended_target_shape)",
      "unused tools + unused skills are pruned (combined " + (unusedToolPctOfSession + unusedSkillPctOfSession).toFixed(1) + "% of current cost)",
      "model tier unchanged; cache hit rate unchanged",
    ];
  }
  const costProjection = {
    available: currentRunCost > 0,
    current_run_usd: currentRunCost,
    if_unchanged: {
      "1x_runs_usd": currentRunCost,
      "10x_runs_usd": Number((currentRunCost * 10).toFixed(2)),
      "100x_runs_usd": Number((currentRunCost * 100).toFixed(2)),
    },
    after_fix_estimate_per_run_usd: afterFixCostEstimate,
    after_fix_assumptions: afterFixAssumptions,
    after_fix_caveat: "Rough hypothesis. Actual after-fix cost depends on quality validation passing on the cheaper workflow. Treat as a target, not a promise.",
  };

  const facts = {
    // ===================== Developer-facing layer =====================
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
      output_composition: (function () {
        // Estimated split of total_output_tokens into the three buckets the
        // Cost view's Output KPI shows: thinking (extended reasoning),
        // visible (response text the user sees), and tool_args (JSON the
        // model emits to invoke tools). Estimates use the same char-ratio
        // method as the UI: reasoning_tokens when reported, else proportional
        // to visibleResponseChars / thinkingChars / toolArgChars. JSON
        // tokenizes denser than prose, so tool_args is likely understated.
        const out = totals.output || 0;
        if (out <= 0) return null;
        const visCh = totals.visibleResponseChars || 0;
        const thinkCh = totals.thinkingChars || 0;
        const argCh = totals.toolArgChars || 0;
        const codeCh = totals.codeChars || 0;
        let thinkTok = 0, argTok = 0, visTok = out;
        let method = "none";
        if (totals.reasoning > 0) {
          thinkTok = totals.reasoning;
          const remain = Math.max(0, out - thinkTok);
          const remCh = visCh + argCh;
          if (remCh > 0) {
            argTok = Math.round(remain * (argCh / remCh));
            visTok = remain - argTok;
          } else {
            argTok = 0; visTok = remain;
          }
          method = "reasoning_tokens + char_ratio";
        } else {
          const totCh = visCh + thinkCh + argCh;
          if (totCh > 0) {
            thinkTok = Math.round(out * (thinkCh / totCh));
            argTok = Math.round(out * (argCh / totCh));
            visTok = Math.max(0, out - thinkTok - argTok);
            method = "char_ratio";
          }
        }
        let proseTok = visTok, codeTok = 0;
        if (visCh > 0 && visTok > 0 && codeCh > 0) {
          codeTok = Math.round(visTok * (codeCh / visCh));
          proseTok = Math.max(0, visTok - codeTok);
        }
        return {
          thinking_tokens: thinkTok,
          visible_tokens: visTok,
          tool_args_tokens: argTok,
          visible_prose_tokens: proseTok,
          visible_code_tokens: codeTok,
          thinking_pct: Math.round((thinkTok / out) * 100),
          visible_pct: Math.round((visTok / out) * 100),
          tool_args_pct: Math.round((argTok / out) * 100),
          tool_args_by_tool: (function () {
            // Top tools by tool-args token share, so the LLM can pinpoint
            // which tool drove the tool-args cost (bulk generation via
            // create_file looks very different from todo churn via
            // manage_todo_list).
            const arr = totals.toolArgCharsByName || [];
            if (arr.length === 0 || argCh === 0 || argTok === 0) return [];
            return arr.slice(0, 10).map(t => ({
              tool: t.name,
              est_tokens: Math.round(argTok * (t.chars / argCh)),
            }));
          })(),
          visible_code_by_language: (function () {
            const arr = totals.codeCharsByLang || [];
            if (arr.length === 0 || codeCh === 0 || codeTok === 0) return [];
            return arr.slice(0, 5).map(L => ({
              language: L.lang || "(no lang)",
              est_tokens: Math.round(codeTok * (L.chars / codeCh)),
            }));
          })(),
          estimation_method: method,
          caveat: "JSON tool_args tokenize denser than prose; tool_args share may be understated when using char_ratio. tool_args_by_tool/visible_code_by_language shares are computed from char counts.",
        };
      })(),
      custom_chat_mode_used: !!firstChatMode,
      custom_agent_used: false,
      custom_skill_used: skillCarry.usedCount > 0,
      repo_instructions_used: instructions.length > 0,
      confidence: "measured",
    },
    developer_action_summary: developerActionSummary,
    session_narrative: sessionNarrative,
    cache_health: cacheHealth,
    every_call_overhead: everyCallOverhead,
    cost_projection: costProjection,
    workflow_classification: {
      type: workflowType,
      confidence: workflowConfidence,
      reason: workflowReason,
      alternative_types: alternativeWorkflowTypes,
    },
    developer_efficiency_findings: efficiencyFindings,
    developer_levers_detected: leversDetected,
    developer_cost_categories: developerCostCategories,
    recommended_changes: recommendedChanges,
    custom_mode_or_agent_analysis: customModeOrAgentAnalysis,
    ide_tool_configuration_analysis: ideToolConfigurationAnalysis,
    tool_definition_shape_analysis: buildToolDefinitionShapeFacts(analysis.toolDefinitionShape),
    mcp_server_reachability_analysis: buildMcpReachabilityFacts(analysis.mcpReachability),
    skills_profile_analysis: skillsProfileAnalysis,
    automation_boundary_recommendation: automationBoundary
      ? { ...(automationBoundary as Record<string, unknown>), ...automationBoundaryExtensions }
      : { available: false, ...automationBoundaryExtensions },
    model_strategy_recommendation: modelStrategyRecommendation,
    prompt_strategy_recommendation: promptStrategyRecommendation,
    quality_and_validation: qualityAndValidation,
    workflow_phase_analysis: workflowPhaseAnalysis,
    agent_loop_efficiency: agentLoopEfficiency,
    tool_result_size_analysis: toolResultSizeAnalysis,
    baseline_comparison: baselineComparison,
    experiment_validity: experimentValidity,
    control_surface_analysis: controlSurfaceAnalysis,
    missing_data: [
      firstChatMode ? {
        field: "custom_chat_mode_full_prompt_or_summary",
        status: "not_available",
        why_it_matters_for_developer_report: "Without it, the report cannot say whether the chat mode caused the expensive behavior or exactly how to edit it.",
        future_instrumentation: "Store full prompt text when safe. Otherwise store name, hash, character count, and a redacted summary.",
      } : null,
      {
        field: "workflow_phases",
        status: "not_available",
        why_it_matters_for_developer_report: "Without phase labels, the report cannot pinpoint which phase of the workflow cost the most.",
        future_instrumentation: "Capture explicit phase markers from the agent or infer them with a documented classifier.",
      },
      {
        field: "file_inventory_and_artifacts",
        status: "not_available",
        why_it_matters_for_developer_report: "Without it, the report cannot distinguish unavoidable file-handling complexity from waste, and cannot confirm the workflow_classification.",
        future_instrumentation: "Capture file inventory before/after, file types, sizes, and files touched per tool call.",
      },
      {
        field: "quality_validation",
        status: "not_available",
        why_it_matters_for_developer_report: "Without it, the report cannot say whether cheaper models or more automation would preserve correctness.",
        future_instrumentation: "Capture validation checks, user acceptance, and post-session corrections.",
      },
      {
        field: "was_rework_or_retry",
        status: "not_available",
        why_it_matters_for_developer_report: "Without it, the report cannot tell the developer how much cost came from the agent redoing prior work.",
        future_instrumentation: "Add command fingerprinting and repeated file/action detection.",
      },
      {
        field: "skill_attachment_source",
        status: "not_available",
        why_it_matters_for_developer_report: "Without it, the report can only recommend removing skills generically; it cannot point the developer to the right config file.",
        future_instrumentation: "Annotate each attached skill with its source surface (custom agent / workspace / global profile).",
      },
      {
        field: "per_command_tool_output_size",
        status: "not_available",
        why_it_matters_for_developer_report: "Without it, the report cannot identify which specific commands bloated context.",
        future_instrumentation: "Capture per-command stdout/stderr byte counts and truncation flags.",
      },
      {
        field: "reasoning_token_counts",
        status: "not_available",
        why_it_matters_for_developer_report: "Without billed reasoning tokens, the report cannot give exact dollar savings for reducing extended thinking.",
        future_instrumentation: "Surface model-reported reasoning tokens when the platform exposes them.",
      },
    ].filter(Boolean),

    // ===================== Raw supporting telemetry =====================
    // Use only as evidence. Do not make the report a field-by-field
    // summary of this block.
    raw_supporting_telemetry: {
      cost_summary: {
        total_cost_usd: Number(totals.cost.toFixed(4)),
        total_billed_input_tokens: totals.promptTokens,
        total_cached_input_tokens: totals.cached,
        total_cache_write_tokens: totals.cacheWrite,
        total_output_tokens: totals.output,
        chat_call_cost_usd: Number(Object.values(perModel).reduce((a, v) => a + v.cost, 0).toFixed(4)),
        overhead_call_cost_usd: Number(Object.values(perModel).reduce((a, v) => a + v.overheadCost, 0).toFixed(4)),
        top_expensive_call: maxThink.cost > 0 ? {
          turn: maxThink.turn,
          cost_usd: Number(maxThink.cost.toFixed(4)),
          percent_of_session_cost: totals.cost > 0 ? Math.round(100 * maxThink.cost / totals.cost) : 0,
          output_tokens: maxThink.out,
          confidence: "measured",
        } : null,
        confidence: "measured",
      },
      effective_prompt_context: {
        visible_user_prompt: firstUserPromptText,
        visible_user_prompt_chars: visiblePromptLen,
        custom_chat_mode_name: firstChatMode ? firstChatMode.name : null,
        custom_chat_mode_tokens_est: firstChatMode ? (firstChatMode.tokensEst || 0) : 0,
        custom_agent_full_prompt: {
          status: "not_available",
          reason: firstChatMode
            ? "Telemetry includes only the chat mode name and token weight. Full prompt text is not in this export."
            : "No custom chat mode active in this session.",
        },
        visible_prompt_specificity: {
          value: visibleSpecValue,
          confidence: "derived",
          rule: visibleSpecRule,
        },
        effective_prompt_specificity: {
          value: effectiveSpecValue,
          confidence: "derived",
          rule: effectiveSpecRule,
        },
        effective_task_definition: {
          status: firstChatMode ? "partial" : "complete_visible_only",
          value: firstChatMode
            ? "Visible prompt plus active custom chat mode `" + firstChatMode.name + "`. Full chat mode prompt text was not available."
            : "Visible user prompt is the full effective task definition. No chat mode or custom agent active.",
          confidence: "derived",
        },
        do_not_blame_visible_prompt_alone: !!firstChatMode || instructions.length > 0,
      },
      instruction_sources: {
        custom_chat_mode_tokens: firstChatMode ? (firstChatMode.tokensEst || 0) : 0,
        skills_attached_count: skillCarry.skillCount,
        skills_attached_tokens_per_call: skillCarry.skillTokensPerCall,
        tool_definitions_tokens_per_call_first: firstChat && firstChat.components ? (firstChat.components.tool_defs || 0) : 0,
        repo_instruction_files: instructions,
        confidence: "measured",
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
        confidence: "measured",
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
        largest_unused_skills: largestUnusedSkills,
        skill_attachment_source: "unknown_not_recorded_in_export",
        confidence: "measured",
      },
      developer_behavior_signals: {
        visible_prompt_length_chars: visiblePromptLen,
        visible_prompt_specificity: { value: visibleSpecValue, confidence: "derived", rule: visibleSpecRule },
        effective_prompt_specificity: { value: effectiveSpecValue, confidence: "derived", rule: effectiveSpecRule },
        developer_supplied_scope: devSuppliedScope,
        developer_supplied_cost_constraint: false,
        developer_supplied_model_preference: false,
        do_not_blame_visible_prompt_alone: !!firstChatMode || instructions.length > 0,
      },
      agent_behavior_signals: {
        avg_visible_reply_chars_per_chat_call: avgVisible,
        avg_thinking_chars_per_chat_call: avgThink,
        avg_tool_args_chars_per_chat_call: Math.round(totalToolArgs / callsForAvg),
        explanation_verbosity: {
          value: explanationVerbosity,
          confidence: "derived",
          rule: "Bucket from avg visible reply chars per chat call: <500 = low, 500-1999 = medium, >=2000 = high.",
        },
        internal_deliberation_verbosity: {
          value: deliberationVerbosity,
          confidence: "derived",
          rule: "Bucket from avg thinking chars per chat call: <1500 = low, 1500-4999 = medium, >=5000 = high.",
        },
        large_output_spikes: largeOutputSpikes,
        thinking_spikes: thinkingSpikes,
        largest_thinking_spike: maxThink.chars > 0 ? {
          turn: maxThink.turn,
          thinking_chars: maxThink.chars,
          output_tokens: maxThink.out,
          cost_usd: Number(maxThink.cost.toFixed(4)),
          confidence: "measured",
        } : null,
        context_growth_main_sources: ctxGrowthSources,
        model_switched_mid_session: autoModelSwitched,
        distinct_chat_models: Array.from(distinctChatModels).map(shortModelName),
        unexpected_cache_misses_detected: chatEvents.some(e => (e as { unexpectedMiss?: boolean }).unexpectedMiss === true),
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
            realistic_for_full_task: "not_determinable_from_data",
          };
        }),
        projection_caveat: "Alt-model projections re-price the same token shape this session produced. Actual token shape may differ on a different model.",
        confidence: "measured",
      },
      auto_mode_data: {
        verdict: autoFitLabel,
        verdict_bucket: autoFitVerdict,
        visible_prompt_signal_quality: visibleSpecValue,
        effective_first_prompt_signal_quality: firstChatMode ? "higher_due_to_custom_chat_mode" : visibleSpecValue,
        drift_signals: driftSignals,
        chat_mode_present_for_picker: !!firstChatMode,
        same_model_floor_cost_usd: Number(autoSameModelCost.toFixed(4)),
        same_model_floor_savings_usd: Number(autoSameModelSavings.toFixed(4)),
        same_model_floor_savings_pct: 10,
        optimistic_cheapest_viable_cost_usd: autoOptimalCost != null ? Number(autoOptimalCost.toFixed(4)) : null,
        optimistic_cheapest_viable_model: cheapestAlt ? cheapestAlt.model : null,
        recommended_estimate_to_quote: autoFitVerdict === "good" ? "optimistic_cheapest_viable" : autoFitVerdict === "borderline" ? "same_model_floor (in-between if a mid-tier alt is realistic)" : "same_model_floor",
        recommended_estimate_reason: autoFitVerdict === "good"
          ? "Drift was minimal; Auto's first-call pick likely held up across the session, so the optimistic cheaper-model projection is fair to quote."
          : autoFitVerdict === "borderline"
            ? "Some drift detected; Auto may have stayed on the same tier or stepped up mid-session. Quote the floor; mention an in-between number only if a mid-tier alternative is realistic."
            : "Significant drift detected; if Auto picked a lighter model from the first prompt it would have under-served the later turns. Use the same-model floor as the realistic Auto cost.",
      },
      optimization_opportunities: {
        top_cost_levers: topCostLevers,
      },
    },
  };
  lines.push("```json");
  lines.push(JSON.stringify(facts, null, 2));
  lines.push("```");
  lines.push("");
  lines.push("---");
  lines.push("");
  lines.push("## Supporting evidence (legacy human-readable view)");
  lines.push("");
  lines.push("_The structured JSON above is the source of truth. The tables below are supporting evidence; if they appear to contradict the JSON (for example, \"Custom chat mode: (none)\" when `session_metadata.custom_chat_mode_used == true`), trust the JSON._");
  lines.push("");
  lines.push("### Session at a glance");
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
  lines.push("### Models used (with cost share)");
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
  lines.push("### Alt-model cost projection");
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
  lines.push("### System prompt anatomy");
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
  lines.push("### Model-visible tool definitions vs used");
  lines.push("");
  lines.push("- **Model-visible tool definitions sent to model:** " + unused.offeredAll.size + " _(IDE-selected tool count is not carried in the export)_");
  lines.push("- **Tools actually used:** " + unused.used.size + " — `" + Array.from(unused.used).sort().join("`, `") + "`");
  if (unused.unused.length > 0) {
    lines.push("- **Unused model-visible tool definitions (" + unused.unused.length + "):** `" + unused.unused.join("`, `") + "`");
  } else {
    lines.push("- **Unused model-visible tool definitions:** (none)");
  }
  lines.push("");
  // Tool definition shape (direct vs router/grouped vs possible-router).
  // Surfaces the distinction between IDE-selected tools, model-visible tool
  // definitions, and router/grouped tools that wrap many hidden subcommands
  // behind one schema. Without this section the report can imply that all
  // selected/enabled tools were sent on the wire, which is not true.
  const usedToolNames = Array.from(unused.used);
  for (const ln of renderToolDefinitionShapeMarkdown(analysis.toolDefinitionShape, usedToolNames)) {
    lines.push(ln);
  }
  // MCP server reachability (declared in IDE vs visible to the model).
  for (const ln of renderMcpReachabilityMarkdown(analysis.mcpReachability)) {
    lines.push(ln);
  }
  lines.push("### Complexity drift signals (for auto-mode judgement)");
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
  lines.push("### User messages (chronological, full text)");
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
  lines.push("### Per-call breakdown");
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
  lines.push(reportMode === "detailed_audit"
    ? "End of facts. Produce the 12-section detailed audit report now. Remember: write the TL;DR last but place it first; the very first line of your reply is `# <session title>`. Telemetry field paths belong in parentheses as evidence, not as the main prose."
    : "End of facts. Produce the developer-action report now (9 sections in this exact order: What happened / Bottom line / Fix before next run / Cost drivers in plain English / What's working / What not to over-optimize / Model guidance / Suggested next experiment / Evidence). The very first line of your reply is `# <Workflow name>: Optimization Review`. Aim for 700-900 words. Telemetry field paths belong in parentheses as evidence, not as the main prose.");
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
