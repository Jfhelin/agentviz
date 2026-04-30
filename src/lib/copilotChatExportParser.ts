/**
 * Parse VS Code Copilot Chat "Export prompts" JSON files.
 *
 * Exported via VS Code's Copilot Chat dev tools "Export all prompts" command.
 * Filename convention: `copilot_all_prompts_<timestamp>.json`.
 *
 * Top-level shape:
 *   {
 *     exportedAt: string,
 *     totalPrompts: number,
 *     totalLogEntries: number,
 *     prompts: [
 *       {
 *         prompt: string,
 *         promptId: string,
 *         logCount: number,
 *         logs: [
 *           { kind: "request", id, type, name, metadata: {model, usage, tools},
 *             requestMessages: { messages: [{role, content}] }, response },
 *           { kind: "toolCall", tool, args, time, thinking, response }
 *         ]
 *       }
 *     ],
 *     mcpServers?: any
 *   }
 *
 * Produces a normal ParsedSession (events/turns/metadata) PLUS a costAnalysis
 * field on metadata that drives the CostView component.
 */

import {
  analyzeSessionCalls,
  emptyComponents,
  type CallAnalysis,
  type CallInput,
  type ComponentBreakdown,
  type PromptAnalysis,
  type ToolDef,
} from "./cacheAnalysis";
import { estimateCost } from "./pricing.js";
import type {
  NormalizedEvent,
  ParsedSession,
  SessionMetadata,
  SessionTurn,
} from "./sessionTypes";

// ── Format detection ─────────────────────────────────────────────────────────

export function detectCopilotChatExport(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{")) return false;
  // Sample heuristics: the export has these markers near the top of the file.
  // Avoid full parse for large files (~3 MB).
  const head = trimmed.slice(0, 4096);
  if (!head.includes('"prompts"')) return false;
  if (!head.includes('"totalLogEntries"') && !head.includes('"totalPrompts"')) {
    return false;
  }
  // Confirm with a structural check on the parsed root.
  try {
    const root = JSON.parse(trimmed);
    return (
      root && typeof root === "object" &&
      Array.isArray(root.prompts) &&
      root.prompts.length > 0 &&
      Array.isArray(root.prompts[0].logs)
    );
  } catch {
    return false;
  }
}

// ── Raw shape types ──────────────────────────────────────────────────────────

interface RawLog {
  id?: string;
  kind: "request" | "toolCall";
  name?: string;
  type?: string;
  // Request-only:
  metadata?: {
    model?: string;
    duration?: number;
    usage?: {
      prompt_tokens?: number;
      completion_tokens?: number;
      cache_creation_input_tokens?: number;
      prompt_tokens_details?: {
        cached_tokens?: number;
        cache_creation_input_tokens?: number;
      };
    };
    tools?: ToolDef[];
  };
  requestMessages?: { messages?: RawMessage[] };
  response?: unknown;
  // ToolCall-only:
  tool?: string;
  args?: string | Record<string, unknown>;
  time?: number;
  thinking?: { text?: string };
}

interface RawMessage {
  role: 0 | 1 | 2 | 3;
  content: string | RawContentPart[];
}

interface RawContentPart {
  type?: number | string;
  text?: string;
  cacheType?: string;
}

interface RawPrompt {
  prompt: string;
  promptId: string;
  logCount?: number;
  logs: RawLog[];
}

interface RawExport {
  exportedAt?: string;
  totalPrompts?: number;
  totalLogEntries?: number;
  prompts: RawPrompt[];
  mcpServers?: unknown;
}

// ── Component classification ─────────────────────────────────────────────────

function chars_to_tokens(chars: number): number {
  // Rough English heuristic. The whole call's bucket totals are scaled to the
  // real prompt_tokens after bucketing, so per-bucket proportions are accurate
  // to within ~5-10%. (Future: swap for tiktoken-wasm.)
  return Math.round(chars / 4);
}

function messageText(msg: RawMessage): string {
  const c = msg.content;
  if (typeof c === "string") return c;
  if (!Array.isArray(c)) return "";
  let out = "";
  for (const p of c) {
    if (p && typeof p === "object" && typeof p.text === "string") out += p.text;
  }
  return out;
}

interface ClassifiedCall {
  components: ComponentBreakdown;
  systemPreview: string;
  currentText: string;
  historyMsgs: { role: "user" | "assistant"; chars: number; tokens: number; preview: string }[];
  toolResultMsgs: { chars: number; tokens: number; preview: string }[];
  totalTools: number;
  toolGroups: { source: string; tools: { name: string; chars: number; tokens: number }[]; chars: number; tokens: number }[];
}

const TOOL_GROUP_PATTERNS: { match: (name: string) => boolean; label: string }[] = [
  { match: (n) => n.startsWith("mcp_azure_"),         label: "MCP: Azure" },
  { match: (n) => n.startsWith("mcp_io_github_"),     label: "MCP: GitHub" },
  { match: (n) => n.startsWith("mcp_bicep_"),         label: "MCP: Bicep" },
  { match: (n) => n.startsWith("mcp_microsoft"),      label: "MCP: Microsoft Learn" },
  { match: (n) => n.startsWith("mcp_"),               label: "MCP: other" },
  { match: (n) => n.startsWith("github-pull-"),       label: "Ext: GitHub PR" },
  { match: (n) => n.startsWith("azure_") || n.startsWith("azure-"), label: "Ext: Azure" },
  { match: (n) => n.startsWith("aitk-") || n.startsWith("ai-mlstudio-"), label: "Ext: AI Toolkit" },
  { match: (n) => n.startsWith("vscode_") || n.startsWith("copilot_"), label: "Built-in: VS Code" },
];

function classifyToolGroup(name: string): string {
  for (const p of TOOL_GROUP_PATTERNS) if (p.match(name)) return p.label;
  return "Built-in: other";
}

function classifyCall(log: RawLog): ClassifiedCall {
  const messages = log.requestMessages?.messages ?? [];
  // Find the LAST user message — that's "current prompt"; earlier user
  // messages are pre-prompt context (env_info / workspace_info / etc) treated
  // here as part of the history bucket. (Future: split into dedicated bucket.)
  let lastUserIdx = -1;
  messages.forEach((m, i) => { if (m.role === 1) lastUserIdx = i; });

  let sysChars = 0, historyChars = 0, toolResultsChars = 0, currentChars = 0;
  let systemText = "", currentText = "";
  const historyMsgs: ClassifiedCall["historyMsgs"] = [];
  const toolResultMsgs: ClassifiedCall["toolResultMsgs"] = [];

  messages.forEach((msg, idx) => {
    const text = messageText(msg);
    const len = text.length;
    if (msg.role === 0) {
      sysChars += len;
      systemText += text + "\n";
    } else if (msg.role === 1) {
      if (idx === lastUserIdx) {
        currentChars += len;
        currentText = text;
      } else {
        historyChars += len;
        historyMsgs.push({ role: "user", chars: len, tokens: 0, preview: text.slice(0, 160) });
      }
    } else if (msg.role === 2) {
      historyChars += len;
      historyMsgs.push({ role: "assistant", chars: len, tokens: 0, preview: text.slice(0, 160) });
    } else if (msg.role === 3) {
      toolResultsChars += len;
      toolResultMsgs.push({ chars: len, tokens: 0, preview: text.slice(0, 240) });
    }
  });

  // Tool definitions
  const tools = log.metadata?.tools ?? [];
  const toolDefBuckets = new Map<string, { tools: { name: string; chars: number; tokens: number }[]; chars: number }>();
  let toolDefChars = 0;
  for (const tool of tools) {
    const json = JSON.stringify(tool);
    const len = json.length;
    toolDefChars += len;
    const group = classifyToolGroup(tool?.name ?? "");
    if (!toolDefBuckets.has(group)) toolDefBuckets.set(group, { tools: [], chars: 0 });
    const b = toolDefBuckets.get(group)!;
    b.tools.push({ name: tool.name, chars: len, tokens: 0 });
    b.chars += len;
  }

  // Estimate tokens then scale
  const realPt = log.metadata?.usage?.prompt_tokens ?? 0;
  const est = {
    system: chars_to_tokens(sysChars),
    tool_defs: chars_to_tokens(toolDefChars),
    history: chars_to_tokens(historyChars),
    tool_results: chars_to_tokens(toolResultsChars),
    current: chars_to_tokens(currentChars),
  };
  const estTotal = est.system + est.tool_defs + est.history + est.tool_results + est.current;
  const scale = estTotal > 0 ? realPt / estTotal : 0;
  const components: ComponentBreakdown = {
    system: Math.round(est.system * scale),
    tool_defs: Math.round(est.tool_defs * scale),
    history: Math.round(est.history * scale),
    tool_results: Math.round(est.tool_results * scale),
    current: Math.round(est.current * scale),
  };
  // Fix rounding drift onto largest bucket
  const sum = components.system + components.tool_defs + components.history + components.tool_results + components.current;
  const drift = realPt - sum;
  if (drift !== 0) {
    type K = keyof ComponentBreakdown;
    let kmax: K = "tool_defs";
    (Object.keys(components) as K[]).forEach((k) => {
      if (components[k] > components[kmax]) kmax = k;
    });
    components[kmax] = Math.max(0, components[kmax] + drift);
  }

  // Per-message token counts (proportional within bucket)
  for (const hm of historyMsgs) {
    hm.tokens = historyChars > 0 ? Math.round((hm.chars / historyChars) * components.history) : 0;
  }
  for (const tr of toolResultMsgs) {
    tr.tokens = toolResultsChars > 0 ? Math.round((tr.chars / toolResultsChars) * components.tool_results) : 0;
  }

  // Per-tool token counts
  const toolGroups = Array.from(toolDefBuckets.entries()).map(([source, b]) => {
    const tokens = toolDefChars > 0 ? Math.round((b.chars / toolDefChars) * components.tool_defs) : 0;
    for (const t of b.tools) {
      t.tokens = b.chars > 0 ? Math.round((t.chars / b.chars) * tokens) : 0;
    }
    b.tools.sort((a, c) => c.tokens - a.tokens);
    return { source, tools: b.tools, chars: b.chars, tokens };
  });
  toolGroups.sort((a, c) => c.tokens - a.tokens);

  return {
    components,
    systemPreview: systemText.slice(0, 400),
    currentText: currentText.slice(0, 600),
    historyMsgs,
    toolResultMsgs,
    totalTools: tools.length,
    toolGroups,
  };
}

// ── Cost analysis (the data structure CostView consumes) ─────────────────────

export interface CostAnalysisCall {
  id: string;
  index: number;
  model: string;
  duration: number;
  promptTokens: number;
  cached: number;
  cacheWrite: number;
  fresh: number;
  output: number;
  cost: number;
  prevPt: number;
  deltaVsPrev: number;
  modelSwitched: boolean;
  newTotal: number;
  trulyNew: number;
  recommit: number;
  unexpectedMiss: boolean;
  cacheMissDiag: CallAnalysis["cacheMissDiag"];
  newPerBucket: ComponentBreakdown;
  components: ComponentBreakdown;
  totalTools: number;
  toolGroups: ClassifiedCall["toolGroups"];
  historyMsgs: ClassifiedCall["historyMsgs"];
  toolResultMsgs: ClassifiedCall["toolResultMsgs"];
  systemPreview: string;
  currentText: string;
  cumCostAfter: number;
}

export interface CostAnalysisToolCall {
  kind: "tool";
  id: string;
  name: string;
  argsSummary: string;
  rawArgs: string;
  thinking: string;
  resultChars: number;
  resultTokens: number;
  resultPreview: string;
  cumCostAfter: number;
}

export type CostAnalysisEvent =
  | (CostAnalysisCall & { kind: "llm" })
  | CostAnalysisToolCall;

export interface CostAnalysisPrompt {
  index: number;
  promptId: string;
  label: string;
  events: CostAnalysisEvent[];
  promptTokens: number;
  output: number;
  cached: number;
  cacheWrite: number;
  fresh: number;
  cost: number;
  cacheHitRate: number;
  llmCount: number;
  toolCount: number;
  prompt: PromptAnalysis;
}

export interface CostAnalysis {
  prompts: CostAnalysisPrompt[];
  totals: {
    promptTokens: number;
    output: number;
    cached: number;
    cacheWrite: number;
    fresh: number;
    cost: number;
    llmCalls: number;
    toolCalls: number;
    cacheHitRate: number;
    unexpectedMissCount: number;
    unexpectedMissCost: number;
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function shortArgs(args: unknown): string {
  if (typeof args === "string") {
    try { return shortArgs(JSON.parse(args)); } catch { /* fall through */ }
    return args.length > 80 ? args.slice(0, 80) + "…" : args;
  }
  if (args && typeof args === "object") {
    const o = args as Record<string, unknown>;
    const keys = ["filePath", "path", "query", "command", "url"];
    for (const k of keys) {
      if (typeof o[k] === "string") {
        const v = o[k] as string;
        return `${k}: ${v.length > 60 ? v.slice(0, 60) + "…" : v}`;
      }
    }
    const json = JSON.stringify(o);
    return json.length > 80 ? json.slice(0, 80) + "…" : json;
  }
  return "";
}

function asString(args: unknown): string {
  if (typeof args === "string") return args;
  if (args == null) return "";
  return JSON.stringify(args);
}

function callUsage(log: RawLog): { prompt_tokens: number; cached_tokens: number; cache_write: number; completion_tokens: number } {
  const u = log.metadata?.usage ?? {};
  const ptd = u.prompt_tokens_details ?? {};
  return {
    prompt_tokens: u.prompt_tokens ?? 0,
    completion_tokens: u.completion_tokens ?? 0,
    cached_tokens: ptd.cached_tokens ?? 0,
    cache_write: u.cache_creation_input_tokens ?? ptd.cache_creation_input_tokens ?? 0,
  };
}

// ── Parser ───────────────────────────────────────────────────────────────────

export function parseCopilotChatExport(text: string): ParsedSession | null {
  let root: RawExport;
  try {
    root = JSON.parse(text.trim());
  } catch {
    return null;
  }
  if (!root || !Array.isArray(root.prompts)) return null;

  // First pass: classify every call. We need the ClassifiedCall structures
  // and tool arrays for cacheAnalysis.
  const classifiedByPrompt: { classified: ClassifiedCall[]; logs: RawLog[] }[] = [];
  for (const p of root.prompts) {
    const classified: ClassifiedCall[] = [];
    const logs: RawLog[] = [];
    for (const log of p.logs) {
      logs.push(log);
      if (log.kind === "request") classified.push(classifyCall(log));
    }
    classifiedByPrompt.push({ classified, logs });
  }

  // Second pass: build CallInput[] per prompt for cache analysis
  const promptInputs: { calls: CallInput[]; cacheWriteSum: number }[] = [];
  classifiedByPrompt.forEach((c, pi) => {
    const calls: CallInput[] = [];
    let cwSum = 0;
    let classifiedIdx = 0;
    for (const log of c.logs) {
      if (log.kind !== "request") continue;
      const usage = callUsage(log);
      cwSum += usage.cache_write;
      calls.push({
        id: log.id ?? `p${pi}-c${classifiedIdx}`,
        model: log.metadata?.model ?? "unknown",
        usage: { ...usage },
        tools: log.metadata?.tools ?? [],
        components: c.classified[classifiedIdx].components,
      });
      classifiedIdx++;
    }
    promptInputs.push({ calls, cacheWriteSum: cwSum });
  });
  const analysis = analyzeSessionCalls(promptInputs);

  // Third pass: build the CostAnalysis structure (per-prompt + per-call) and
  // the normal ParsedSession events/turns/metadata.
  const costPrompts: CostAnalysisPrompt[] = [];
  const events: NormalizedEvent[] = [];
  const turns: SessionTurn[] = [];
  let cumCost = 0;
  let cumPt = 0, cumOut = 0, cumCached = 0, cumCwrite = 0, cumFresh = 0;
  let totalLlm = 0, totalTool = 0;
  let totalUnexpectedMissCount = 0, totalUnexpectedMissCost = 0;
  let timeCursor = 0;

  classifiedByPrompt.forEach((c, pi) => {
    const promptText = root.prompts[pi].prompt ?? "";
    const promptId = root.prompts[pi].promptId ?? `prompt-${pi}`;
    const turnStart = timeCursor;
    const eventIndices: number[] = [];

    let pPt = 0, pOut = 0, pCached = 0, pCwrite = 0, pFresh = 0, pCost = 0;
    let pLlm = 0, pTool = 0;
    const costEvents: CostAnalysisEvent[] = [];
    const pendingToolCalls: CostAnalysisToolCall[] = [];

    let classifiedIdx = 0;
    let analysisCallIdx = 0;
    const callAnalysisList = analysis[pi].calls;

    // First: emit user-message event for the prompt
    if (promptText) {
      const idx = events.length;
      events.push({
        t: timeCursor,
        agent: "user",
        track: "context",
        text: promptText,
        duration: 0,
        intensity: 1,
        isError: false,
        turnIndex: pi,
      });
      eventIndices.push(idx);
      timeCursor += 1;
    }

    for (const log of c.logs) {
      if (log.kind === "toolCall") {
        const argStr = asString(log.args);
        const tc: CostAnalysisToolCall = {
          kind: "tool",
          id: log.id ?? `p${pi}-tool-${pTool}`,
          name: log.tool ?? "",
          argsSummary: shortArgs(log.args),
          rawArgs: argStr,
          thinking: log.thinking?.text ?? "",
          resultChars: 0,
          resultTokens: 0,
          resultPreview: "",
          cumCostAfter: cumCost,
        };
        costEvents.push(tc);
        pendingToolCalls.push(tc);
        pTool += 1;
        totalTool += 1;

        const idx = events.length;
        events.push({
          t: timeCursor,
          agent: "assistant",
          track: "tool_call",
          text: tc.argsSummary,
          duration: 0.5,
          intensity: 1,
          toolName: tc.name,
          toolInput: log.args,
          isError: false,
          turnIndex: pi,
          raw: log,
        });
        eventIndices.push(idx);
        timeCursor += 1;
        continue;
      }

      // request
      const cls = c.classified[classifiedIdx];
      const ca = callAnalysisList[analysisCallIdx];
      const usage = callUsage(log);
      const fresh = Math.max(0, usage.prompt_tokens - usage.cached_tokens - usage.cache_write);
      const out_t = usage.completion_tokens;
      const model = log.metadata?.model ?? "unknown";
      // pricing.estimateCost expects camelCase token usage
      const cost = estimateCost({
        inputTokens: fresh,
        outputTokens: out_t,
        cacheRead: usage.cached_tokens,
        cacheWrite: usage.cache_write,
      }, model);
      cumCost += cost;
      cumPt += usage.prompt_tokens; cumOut += out_t;
      cumCached += usage.cached_tokens; cumCwrite += usage.cache_write; cumFresh += fresh;
      pPt += usage.prompt_tokens; pOut += out_t;
      pCached += usage.cached_tokens; pCwrite += usage.cache_write; pFresh += fresh;
      pCost += cost;
      pLlm += 1;
      totalLlm += 1;

      // Pair pending tool calls with role-3 tool result messages by ordinal
      cls.toolResultMsgs.forEach((tr, i) => {
        if (i < pendingToolCalls.length) {
          pendingToolCalls[i].resultChars = tr.chars;
          pendingToolCalls[i].resultTokens = tr.tokens;
          pendingToolCalls[i].resultPreview = tr.preview;
        }
      });
      pendingToolCalls.length = 0;

      const callEvent: CostAnalysisCall & { kind: "llm" } = {
        kind: "llm",
        id: log.id ?? `p${pi}-call-${analysisCallIdx}`,
        index: analysisCallIdx,
        model,
        duration: log.metadata?.duration ?? 0,
        promptTokens: usage.prompt_tokens,
        cached: usage.cached_tokens,
        cacheWrite: usage.cache_write,
        fresh,
        output: out_t,
        cost,
        prevPt: ca.prevPt,
        deltaVsPrev: ca.deltaVsPrev,
        modelSwitched: ca.modelSwitched,
        newTotal: ca.newTotal,
        trulyNew: ca.trulyNew,
        recommit: ca.recommit,
        unexpectedMiss: ca.unexpectedMiss,
        cacheMissDiag: ca.cacheMissDiag,
        newPerBucket: ca.newPerBucket,
        components: cls.components,
        totalTools: cls.totalTools,
        toolGroups: cls.toolGroups,
        historyMsgs: cls.historyMsgs,
        toolResultMsgs: cls.toolResultMsgs,
        systemPreview: cls.systemPreview,
        currentText: cls.currentText,
        cumCostAfter: cumCost,
      };
      if (ca.unexpectedMiss) {
        totalUnexpectedMissCount += 1;
        totalUnexpectedMissCost += cost;
      }
      costEvents.push(callEvent);

      const idx = events.length;
      events.push({
        t: timeCursor,
        agent: "assistant",
        track: "output",
        text: `${model} · ${usage.prompt_tokens} pt → ${out_t} out`,
        duration: (log.metadata?.duration ?? 0) / 1000 || 1,
        intensity: 1,
        isError: false,
        turnIndex: pi,
        model,
        tokenUsage: {
          inputTokens: fresh,
          outputTokens: out_t,
          cacheRead: usage.cached_tokens,
          cacheWrite: usage.cache_write,
        },
      });
      eventIndices.push(idx);
      timeCursor += Math.max(1, (log.metadata?.duration ?? 0) / 1000);
      classifiedIdx += 1;
      analysisCallIdx += 1;
    }

    // Per-prompt unexpected-miss cost into the analysis (for header callout)
    let promptMissCost = 0;
    for (const ev of costEvents) {
      if (ev.kind === "llm" && ev.unexpectedMiss) promptMissCost += ev.cost;
    }
    const promptAnalysis = analysis[pi].prompt;
    promptAnalysis.unexpectedMissCost = promptMissCost;

    costPrompts.push({
      index: pi,
      promptId,
      label: promptText.slice(0, 200),
      events: costEvents,
      promptTokens: pPt,
      output: pOut,
      cached: pCached,
      cacheWrite: pCwrite,
      fresh: pFresh,
      cost: pCost,
      cacheHitRate: (pCached + pFresh + pCwrite) > 0 ? pCached / (pCached + pFresh + pCwrite) : 0,
      llmCount: pLlm,
      toolCount: pTool,
      prompt: promptAnalysis,
    });

    turns.push({
      index: pi,
      startTime: turnStart,
      endTime: timeCursor,
      eventIndices,
      userMessage: promptText,
      toolCount: pTool,
      hasError: false,
    });
  });

  const totalDenom = cumCached + cumFresh + cumCwrite;
  const costAnalysis: CostAnalysis = {
    prompts: costPrompts,
    totals: {
      promptTokens: cumPt,
      output: cumOut,
      cached: cumCached,
      cacheWrite: cumCwrite,
      fresh: cumFresh,
      cost: cumCost,
      llmCalls: totalLlm,
      toolCalls: totalTool,
      cacheHitRate: totalDenom > 0 ? cumCached / totalDenom : 0,
      unexpectedMissCount: totalUnexpectedMissCount,
      unexpectedMissCost: totalUnexpectedMissCost,
    },
  };

  const models: Record<string, number> = {};
  for (const ev of events) {
    if (ev.model) models[ev.model] = (models[ev.model] ?? 0) + 1;
  }
  const primaryModel = Object.entries(models).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;

  const metadata: SessionMetadata = {
    totalEvents: events.length,
    totalTurns: turns.length,
    totalToolCalls: totalTool,
    errorCount: 0,
    duration: timeCursor,
    models,
    primaryModel,
    tokenUsage: {
      inputTokens: cumFresh,
      outputTokens: cumOut,
      cacheRead: cumCached,
      cacheWrite: cumCwrite,
      cacheHitRate: totalDenom > 0 ? cumCached / totalDenom : 0,
    },
    format: "copilot-chat-export" as any,
    costAnalysis,
  };

  return { events, turns, metadata };
}
