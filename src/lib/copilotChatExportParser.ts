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
import { estimateImageTokens } from "./imageTokenEstimate.js";
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
  kind: "request" | "toolCall" | string;
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
  // Assistant tool-call payload (Copilot Chat export uses camelCase). Their
  // JSON-serialized arguments contribute meaningfully to `prompt_tokens` when
  // the message is replayed as history on the next call -- we MUST count them.
  toolCalls?: unknown;
  tool_calls?: unknown;
  // Set on tool_result (role=3) messages, references the originating tool call
  // by id. Lets us look up the tool name and primary argument so the UI can
  // show "readFile: NavBar.tsx" instead of "result 1".
  toolCallId?: string;
  tool_call_id?: string;
}

interface ToolCallInfo { name: string; args: Record<string, unknown> | null; argsRaw: string }

/** Pull a short, human-meaningful label out of a tool call's name + args.
 *  Falls back gracefully when the tool is unknown or the args don't have a
 *  recognized "primary" field -- never throws. */
function toolResultLabel(info: ToolCallInfo | undefined, fallbackIdx: number): string {
  if (!info) return "result " + (fallbackIdx + 1);
  const name = info.name || "tool";
  const args = info.args || {};
  const pathLike = (args.filePath ?? args.path ?? args.file ?? args.filepath) as string | undefined;
  if (typeof pathLike === "string" && pathLike.length > 0) {
    const parts = pathLike.split(/[\\/]/);
    const base = parts[parts.length - 1] || pathLike;
    const short = (parts.length >= 2 && (base === "index.ts" || base === "index.tsx" || base === "index.js"))
      ? parts.slice(-2).join("/")
      : base;
    return name + ": " + short;
  }
  const cmd = args.command as string | undefined;
  if (typeof cmd === "string" && cmd.length > 0) {
    return name + ": " + (cmd.length > 60 ? cmd.slice(0, 60) + "…" : cmd);
  }
  const query = (args.query ?? args.pattern ?? args.searchText) as string | undefined;
  if (typeof query === "string" && query.length > 0) {
    return name + ': "' + (query.length > 60 ? query.slice(0, 60) + "…" : query) + '"';
  }
  const url = args.url as string | undefined;
  if (typeof url === "string" && url.length > 0) {
    try { const u = new URL(url); return name + ": " + u.hostname + u.pathname; }
    catch { return name + ": " + url.slice(0, 60); }
  }
  const desc = (args.description ?? args.title ?? args.name) as string | undefined;
  if (typeof desc === "string" && desc.length > 0) {
    return name + ": " + (desc.length > 60 ? desc.slice(0, 60) + "…" : desc);
  }
  return name;
}

function buildToolCallMap(messages: RawMessage[]): Map<string, ToolCallInfo> {
  const map = new Map<string, ToolCallInfo>();
  for (const m of messages) {
    if (m.role !== 2) continue;
    const tcs = (m.toolCalls ?? m.tool_calls) as unknown;
    if (!Array.isArray(tcs)) continue;
    for (const tc of tcs) {
      if (!tc || typeof tc !== "object") continue;
      const id = (tc as { id?: string }).id;
      const fn = (tc as { function?: { name?: string; arguments?: string } }).function;
      if (typeof id !== "string" || !fn) continue;
      const argsRaw = typeof fn.arguments === "string" ? fn.arguments : "";
      let args: Record<string, unknown> | null = null;
      if (argsRaw) { try { args = JSON.parse(argsRaw); } catch { args = null; } }
      map.set(id, { name: fn.name || "tool", args, argsRaw });
    }
  }
  return map;
}

interface RawContentPart {
  type?: number | string;
  text?: string;
  cacheType?: string;
  imageUrl?: { url?: string; detail?: string; mediaType?: string };
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
  let out = "";
  if (typeof c === "string") out = c;
  else if (Array.isArray(c)) {
    for (const p of c) {
      if (p && typeof p === "object" && typeof p.text === "string") out += p.text;
    }
  }
  // Include serialized tool_calls -- the API counts these toward prompt_tokens
  // when the assistant message is replayed as history. Without this, big
  // tool_call argument payloads (e.g. file edits) appear as "unaccounted"
  // growth and get falsely attributed to other buckets by the scaling step.
  const tc = msg.toolCalls ?? msg.tool_calls;
  if (tc) {
    try { out += JSON.stringify(tc); } catch { /* ignore */ }
  }
  return out;
}

interface ImageAttachment {
  url: string;
  mediaType: string;
  detail: string;
}

interface ClassifiedCall {
  components: ComponentBreakdown;
  /** Raw character counts per bucket (pre-scaling). Used by cacheAnalysis to
   * detect what content actually changed between calls without being fooled
   * by the per-call rescaling that makes unchanged buckets like `system`
   * appear to grow. */
  componentChars: ComponentBreakdown;
  systemPreview: string;
  currentText: string;
  historyMsgs: { role: "user" | "assistant"; chars: number; tokens: number; preview: string }[];
  toolResultMsgs: { chars: number; tokens: number; preview: string; label: string }[];
  totalTools: number;
  toolGroups: { source: string; tools: { name: string; chars: number; tokens: number }[]; chars: number; tokens: number }[];
  /** Image attachments referenced by this call's request messages. The export
   * carries only a CDN URL, mediaType, and detail level -- no byte size,
   * dimensions, or token cost. */
  images: ImageAttachment[];
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
  // Find the LAST user message -- that's "current prompt"; earlier user
  // messages are pre-prompt context (env_info / workspace_info / etc) treated
  // here as part of the history bucket. (Future: split into dedicated bucket.)
  let lastUserIdx = -1;
  messages.forEach((m, i) => { if (m.role === 1) lastUserIdx = i; });

  let sysChars = 0, historyChars = 0, toolResultsChars = 0, currentChars = 0;
  let systemText = "", currentText = "";
  const historyMsgs: ClassifiedCall["historyMsgs"] = [];
  const toolResultMsgs: ClassifiedCall["toolResultMsgs"] = [];
  const toolCallMap = buildToolCallMap(messages);

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
      const tcId = msg.toolCallId ?? msg.tool_call_id;
      const info = tcId ? toolCallMap.get(tcId) : undefined;
      const label = toolResultLabel(info, toolResultMsgs.length);
      toolResultMsgs.push({ chars: len, tokens: 0, preview: text.slice(0, 240), label });
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

  // Extract image attachments. Images appear as content parts with
  // `imageUrl: { url, mediaType, detail }`. The export carries no byte size.
  const images: ImageAttachment[] = [];
  for (const msg of messages) {
    const c = msg.content;
    if (!Array.isArray(c)) continue;
    for (const p of c) {
      if (p && typeof p === "object" && p.imageUrl && typeof p.imageUrl.url === "string") {
        images.push({
          url: p.imageUrl.url,
          mediaType: p.imageUrl.mediaType || "image",
          detail: p.imageUrl.detail || "",
        });
      }
    }
  }

  return {
    components,
    componentChars: {
      system: sysChars,
      tool_defs: toolDefChars,
      history: historyChars,
      tool_results: toolResultsChars,
      current: currentChars,
    },
    systemPreview: systemText.slice(0, 400),
    currentText: currentText.slice(0, 600),
    historyMsgs,
    toolResultMsgs,
    totalTools: tools.length,
    toolGroups,
    images,
  };
}

// ── Cost analysis (the data structure CostView consumes) ─────────────────────

// Names of LLM calls that VS Code Copilot Chat issues for UI/telemetry
// purposes (not the actual user-facing chat turn). They are still real LLM
// calls and still cost tokens, but a user analyzing their session usually
// wants to be able to hide them. See `categorizeCallName`.
export const OVERHEAD_CALL_NAMES = new Set<string>([
  "title",
  "promptCategorization",
]);

export type CallCategory = "primary" | "overhead";

export function categorizeCallName(name: string | undefined | null): CallCategory {
  return name && OVERHEAD_CALL_NAMES.has(name) ? "overhead" : "primary";
}

export interface CostAnalysisCall {
  id: string;
  index: number;
  /** Original `log.name` from the export (e.g. `panel/editAgent`, `title`,
   * `promptCategorization`). Used as the row label and for overhead filtering. */
  name: string;
  /** Whether this call is the actual user-facing chat turn ("primary") or a
   * UI/telemetry side call ("overhead"). Derived from `name`. */
  category: CallCategory;
  /** Short human-readable preview of `log.response` (joined `message[]` for
   * the standard `{type:"success", message:[...]}` shape). Empty when the
   * export had no response payload. */
  responsePreview: string;
  /** When the model emitted no text and only tool calls, this lists the
   * tool names + short arg summary that immediately followed this LLM call
   * in the export. Lets us show *what the model did* instead of an empty
   * response box. */
  producedToolCalls: { name: string; argsSummary: string }[];
  model: string;
  duration: number;
  promptTokens: number;
  cached: number;
  cacheWrite: number;
  fresh: number;
  output: number;
  cost: number;
  prevPt: number;
  /** prompt_tokens of the previous call ON THE SAME MODEL, even when
   * modelSwitched=true. 0 only when the model has never appeared before
   * in this session. */
  priorSameModelPt: number;
  deltaVsPrev: number;
  modelSwitched: boolean;
  newTotal: number;
  trulyNew: number;
  recommit: number;
  unexpectedMiss: boolean;
  cacheMissDiag: CallAnalysis["cacheMissDiag"];
  newPerBucket: ComponentBreakdown;
  components: ComponentBreakdown;
  /** Estimated input tokens for the new images on this call (added to the
   * `current` bucket of `components` for display). 0 when no images are new
   * or the model has no documented image-token rule. Approximation only --
   * the export does not report exact image token usage. */
  imageTokensEst: number;
  totalTools: number;
  toolGroups: ClassifiedCall["toolGroups"];
  historyMsgs: ClassifiedCall["historyMsgs"];
  toolResultMsgs: ClassifiedCall["toolResultMsgs"];
  /** Image attachments referenced by this call. The export gives URL, media
   * type, and detail level only -- no byte size, dimensions, or token cost. */
  images: ClassifiedCall["images"];
  /** Subset of `images` that were NOT present on the previous same-model call.
   * Re-sending an image with the same URL is part of the cached prefix and
   * does not contribute new content -- only first appearance (or first
   * appearance after a model switch) counts as new. */
  newImages: ClassifiedCall["images"];
  /** Subset of `historyMsgs` that were appended since the previous same-model
   * call (chat history is append-only, so the suffix). On a model switch or
   * the very first call, this is the full history. */
  newHistoryMsgs: ClassifiedCall["historyMsgs"];
  /** Subset of `toolResultMsgs` appended since the previous same-model call. */
  newToolResultMsgs: ClassifiedCall["toolResultMsgs"];
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
  /**
   * For `runSubagent` calls only: extracted summary of the subagent invocation.
   * The export does NOT include actual token counts for the subagent's own
   * LLM calls, so promptTokensEst is a 4-chars/token estimate from
   * `args.prompt` and the cost is estimated using `pricing.estimateCost`
   * (input ≈ promptTokensEst, output ≈ resultTokens).
   */
  subagent?: {
    description: string;
    promptChars: number;
    promptTokensEst: number;
    modelName?: string;
  };
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

function extractSubagent(log: RawLog): CostAnalysisToolCall["subagent"] | undefined {
  if (log.tool !== "runSubagent") return undefined;
  let args: Record<string, unknown> = {};
  if (typeof log.args === "string") {
    try { args = JSON.parse(log.args) as Record<string, unknown>; } catch { args = {}; }
  } else if (log.args && typeof log.args === "object") {
    args = log.args as Record<string, unknown>;
  }
  const prompt = typeof args.prompt === "string" ? args.prompt : "";
  const description = typeof args.description === "string" ? args.description : "";
  const meta = (log as unknown as { toolMetadata?: { modelName?: string } }).toolMetadata;
  return {
    description,
    promptChars: prompt.length,
    // Char/4 is the standard rough token estimate. Real cost will be off by
    // ~25% but it's the best we can do without per-subagent usage data.
    promptTokensEst: Math.ceil(prompt.length / 4),
    modelName: meta?.modelName,
  };
}

function summarizeResponse(response: unknown): string {
  if (response == null) return "";
  if (typeof response === "string") {
    return response.length > 800 ? response.slice(0, 800) + "…" : response;
  }
  if (typeof response === "object") {
    const obj = response as Record<string, unknown>;
    // VS Code Copilot Chat shape: { type: "success" | "error", message: string[] }
    if (Array.isArray(obj.message)) {
      const joined = (obj.message as unknown[])
        .filter((m) => typeof m === "string")
        .join("\n")
        .trim();
      if (joined) return joined.length > 800 ? joined.slice(0, 800) + "…" : joined;
    }
    try {
      const json = JSON.stringify(obj);
      return json.length > 800 ? json.slice(0, 800) + "…" : json;
    } catch {
      return "";
    }
  }
  return "";
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
        componentChars: c.classified[classifiedIdx].componentChars,
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
  // Per-model set of image URLs already sent in a prior call's prompt.
  // Used to mark images as "newly added" only on the call where they first
  // appear (or first appear after a model switch / cache miss). Re-sending
  // the same imageUrl on subsequent calls is part of the cached prefix.
  const prevImageUrlsByModel = new Map<string, Set<string>>();
  // Per-model count of history / tool-result messages on the previous same-
  // model call. History grows append-only (chat semantics), so anything past
  // the prior count on this call is genuinely new content. Reset on model
  // switch (handled inline by clearing on first call to a new model).
  const prevHistoryCountByModel = new Map<string, number>();
  const prevToolResultCountByModel = new Map<string, number>();

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

    for (let logIdx = 0; logIdx < c.logs.length; logIdx++) {
      const log = c.logs[logIdx];
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
          subagent: extractSubagent(log),
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
      if (log.kind !== "request") {
        if (typeof console !== "undefined" && console.debug) {
          console.debug("[agentviz][copilot-chat-export] skipping unknown log kind", { promptIndex: pi, logIdx, kind: (log as { kind?: unknown }).kind });
        }
        continue;
      }
      const cls = c.classified[classifiedIdx];
      const ca = callAnalysisList[analysisCallIdx];
      if (!cls || !ca) {
        if (typeof console !== "undefined" && console.warn) {
          console.warn("[agentviz][copilot-chat-export] classified/analysis index out of range; skipping log", {
            promptIndex: pi,
            logIdx,
            classifiedIdx,
            classifiedLen: c.classified.length,
            analysisCallIdx,
            analysisLen: callAnalysisList.length,
          });
        }
        continue;
      }
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

      // Look forward in this prompt's logs to the next request log; the
      // toolCall logs in between are what this LLM call produced. This is
      // critical for showing "what the model did" when its text response is
      // empty (model emitted only tool_use blocks, no message content).
      const producedToolCalls: { name: string; argsSummary: string }[] = [];
      for (let lookIdx = logIdx + 1; lookIdx < c.logs.length; lookIdx++) {
        const next = c.logs[lookIdx];
        if (next.kind === "request") break;
        if (next.kind === "toolCall") {
          producedToolCalls.push({ name: next.tool ?? "", argsSummary: shortArgs(next.args) });
        }
      }

      // Compute which images are newly added on this call vs. prior same-model
      // history. Re-sending the same imageUrl on subsequent calls is part of
      // the cached prefix and should not be flagged as new content. A model
      // switch resets the per-model cache, so all images become new again.
      let prevImgSet = ca.modelSwitched ? new Set<string>() : (prevImageUrlsByModel.get(model) ?? new Set<string>());
      const newImages = cls.images.filter((img) => !prevImgSet.has(img.url));
      const updatedSet = new Set<string>(prevImgSet);
      for (const img of cls.images) updatedSet.add(img.url);
      prevImageUrlsByModel.set(model, updatedSet);

      // History and tool-results are append-only across calls in a chat
      // session. The "new" suffix is everything past the previous same-model
      // call's message count. A model switch resets this baseline.
      const prevHistCount = ca.modelSwitched ? 0 : (prevHistoryCountByModel.get(model) ?? 0);
      const prevTrCount = ca.modelSwitched ? 0 : (prevToolResultCountByModel.get(model) ?? 0);
      const newHistoryMsgs = cls.historyMsgs.slice(prevHistCount);
      const newToolResultMsgs = cls.toolResultMsgs.slice(prevTrCount);
      prevHistoryCountByModel.set(model, cls.historyMsgs.length);
      prevToolResultCountByModel.set(model, cls.toolResultMsgs.length);

      // Estimated image-input tokens for the new images on this call.
      // export does not report exact image token usage, so we use a documented
      // vendor approximation from `imageTokenEstimate`. These are added to the
      // `current` bucket of the displayed components so the stack bar reflects
      // image weight, but cacheAnalysis has already finished using the
      // un-bumped values: the API's `prompt_tokens` already includes vision
      // tokens for capable models, so cacheAnalysis correctly attributes them
      // to existing buckets via the rescale factor. The bump here is
      // visualization-only.
      let imageTokensEst = 0;
      for (const img of newImages) {
        imageTokensEst += estimateImageTokens(model, img.detail);
      }
      const componentsForDisplay: ComponentBreakdown = imageTokensEst > 0
        ? { ...cls.components, current: cls.components.current + imageTokensEst }
        : cls.components;

      const callEvent: CostAnalysisCall & { kind: "llm" } = {
        kind: "llm",
        id: log.id ?? `p${pi}-call-${analysisCallIdx}`,
        index: analysisCallIdx,
        name: log.name ?? "request",
        category: categorizeCallName(log.name),
        responsePreview: summarizeResponse(log.response),
        producedToolCalls,
        model,
        duration: log.metadata?.duration ?? 0,
        promptTokens: usage.prompt_tokens,
        cached: usage.cached_tokens,
        cacheWrite: usage.cache_write,
        fresh,
        output: out_t,
        cost,
        prevPt: ca.prevPt,
        priorSameModelPt: ca.priorSameModelPt,
        deltaVsPrev: ca.deltaVsPrev,
        modelSwitched: ca.modelSwitched,
        newTotal: ca.newTotal,
        trulyNew: ca.trulyNew,
        recommit: ca.recommit,
        unexpectedMiss: ca.unexpectedMiss,
        cacheMissDiag: ca.cacheMissDiag,
        newPerBucket: ca.newPerBucket,
        components: componentsForDisplay,
        imageTokensEst,
        totalTools: cls.totalTools,
        toolGroups: cls.toolGroups,
        historyMsgs: cls.historyMsgs,
        toolResultMsgs: cls.toolResultMsgs,
        images: cls.images,
        newImages,
        newHistoryMsgs,
        newToolResultMsgs,
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
    format: "copilot-chat-export",
    costAnalysis,
  };

  return { events, turns, metadata };
}
