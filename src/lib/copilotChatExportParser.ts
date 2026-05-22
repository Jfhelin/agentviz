/**
 * Parser for the real VS Code Copilot Chat export format
 * (`copilot_all_prompts_*.json` produced by the Copilot Chat extension's
 * "Export prompts" command).
 *
 * This file is intentionally independent of `copilotCostParser.ts`
 * (which handles the synthetic flat `[{request, response}]` shape).
 * Both parsers emit the same `event.raw.costPrompt` contract so that
 * `costAnalysis.js` and `CostView.jsx` work transparently with either
 * input.
 *
 * Real export shape (abridged):
 *   {
 *     exportedAt, totalPrompts, totalLogEntries,
 *     mcpServers: [{ type, label, uri, version }],
 *     prompts: [
 *       {
 *         prompt: <string>,
 *         promptId, logCount,
 *         logs: [
 *           {
 *             id, kind: "request" | "toolCall",
 *             type: "ChatMLSuccess" | ...,
 *             name: "title" | "promptCategorization" | "panel/editAgent" | ...,
 *             metadata: { model, usage, requestType, duration, ... },
 *             requestMessages: { messages: [...] },
 *             response: { type: "success", message: [<string>] }
 *           }
 *         ]
 *       }
 *     ]
 *   }
 *
 * Per-message numeric role mapping (VS Code internal):
 *   0 = system, 1 = user, 2 = assistant, 3 = tool result
 *
 * Per-message content parts can be a string or an array of parts:
 *   type === 1 -> { text: <string> }            (regular text)
 *   type === 2 -> { value: <unknown> }           (tool_use / structured payload)
 *   type === 3 -> { cacheType: <string> }        (Anthropic cache breakpoint marker)
 *
 * Usage shape (OpenAI-compatible, with Anthropic cache extensions):
 *   { prompt_tokens, completion_tokens,
 *     prompt_tokens_details: { cached_tokens, cache_creation_input_tokens } }
 *
 * NOTE: `cache_creation_input_tokens` is NESTED inside `prompt_tokens_details`
 * in this format -- NOT at the top level of `usage`. Both lookups are tried.
 */

import { computeCacheHitRate } from "./cacheMetrics";
import { estimateImageTokens } from "./imageTokenEstimate.js";
import { estimateMultiModelCost } from "./pricing.js";
import type { NormalizedEvent, ParsedSession, SessionMetadata, SessionTurn, TokenUsage } from "./sessionTypes";

const MAX_DISPLAY_TEXT_LENGTH = 4000;

/** Log `name` values produced by the Copilot Chat host as automation overhead
 *  (title generation, prompt categorization) rather than user-driven LLM calls.
 *  These are surfaced separately in the Cost view so users can filter them out. */
export const OVERHEAD_CALL_NAMES = new Set<string>([
  "title",
  "promptCategorization",
  "chat/agentTitle",
  "summarization",
  "followups",
  "rename",
]);

export type CallCategory = "primary" | "overhead";

export function categorizeCallName(name: string | null | undefined): CallCategory {
  if (!name) return "primary";
  return OVERHEAD_CALL_NAMES.has(name) ? "overhead" : "primary";
}

type AnyRecord = Record<string, any>;

interface ChatExportRoot {
  exportedAt?: string;
  totalPrompts?: number;
  totalLogEntries?: number;
  prompts?: ChatExportPrompt[];
  mcpServers?: AnyRecord[];
}

interface ChatExportPrompt {
  prompt?: string;
  promptId?: string;
  logCount?: number;
  logs?: ChatExportLog[];
}

interface ChatExportLog {
  id?: string;
  kind?: string;
  type?: string;
  name?: string;
  metadata?: AnyRecord;
  requestMessages?: { messages?: AnyRecord[] };
  response?: AnyRecord;
}

function isRecord(value: unknown): value is AnyRecord {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function parseJSON(text: string): unknown {
  try {
    return JSON.parse(text.trim());
  } catch {
    return null;
  }
}

export function detectCopilotChatExport(text: string): boolean {
  const parsed = parseJSON(text);
  if (!isRecord(parsed)) return false;
  const root = parsed as ChatExportRoot;
  if (!Array.isArray(root.prompts) || root.prompts.length === 0) return false;
  // Be permissive: a real export has `totalPrompts` or `totalLogEntries`
  // alongside the `prompts` array. The flat copilotCostParser format has
  // `prompts` too, but its entries always carry top-level `request`+`response`
  // keys; the chat export entries carry `logs` instead.
  const hasMarker = typeof root.totalPrompts === "number"
    || typeof root.totalLogEntries === "number"
    || typeof root.exportedAt === "string";
  if (!hasMarker) return false;
  const sample = root.prompts.find((p) => isRecord(p)) as ChatExportPrompt | undefined;
  if (!sample) return false;
  return Array.isArray(sample.logs);
}

function firstNumber(...values: unknown[]): number {
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (typeof value === "number" && Number.isFinite(value)) return Math.max(0, value);
    if (typeof value === "string" && value.trim() !== "") {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return Math.max(0, parsed);
    }
  }
  return 0;
}

function roleFromNumeric(role: unknown): string {
  if (typeof role === "string") return role;
  switch (role) {
    case 0: return "system";
    case 1: return "user";
    case 2: return "assistant";
    case 3: return "tool";
    default: return "unknown";
  }
}

interface PartExtraction {
  text: string;
  imageCount: number;
  imageDetails: string[];
}

function extractContentParts(content: unknown): PartExtraction {
  const out: PartExtraction = { text: "", imageCount: 0, imageDetails: [] };
  if (typeof content === "string") {
    out.text = content;
    return out;
  }
  if (!Array.isArray(content)) {
    if (isRecord(content)) {
      if (typeof content.text === "string") out.text = content.text;
      else if (typeof content.value === "string") out.text = content.value;
    }
    return out;
  }
  const chunks: string[] = [];
  for (let index = 0; index < content.length; index += 1) {
    const part = content[index];
    if (typeof part === "string") { chunks.push(part); continue; }
    if (!isRecord(part)) continue;
    // String-typed parts (OpenAI-shaped content_array)
    if (part.type === "text" && typeof part.text === "string") { chunks.push(part.text); continue; }
    if (part.type === "image_url" || part.type === "imageBlob" || isRecord(part.imageUrl)) {
      out.imageCount += 1;
      const detail = isRecord(part.imageUrl) && typeof part.imageUrl.detail === "string"
        ? part.imageUrl.detail
        : typeof part.detail === "string" ? part.detail : "high";
      out.imageDetails.push(detail);
      continue;
    }
    // Numeric-typed parts (VS Code internal shape)
    if (part.type === 1 && typeof part.text === "string") { chunks.push(part.text); continue; }
    if (part.type === 2) {
      // tool_use / structured value: stringify so it contributes to token count
      try { chunks.push(typeof part.value === "string" ? part.value : JSON.stringify(part.value)); }
      catch { /* ignore unstringifiable values */ }
      continue;
    }
    if (part.type === 3) {
      // Cache breakpoint marker -- not visible content, skip
      continue;
    }
    // Generic fallback
    if (typeof part.text === "string") chunks.push(part.text);
    else if (typeof part.value === "string") chunks.push(part.value);
  }
  out.text = chunks.filter(Boolean).join("\n");
  return out;
}

function truncateForDisplay(text: string): string {
  if (text.length <= MAX_DISPLAY_TEXT_LENGTH) return text;
  const visibleLength = Math.max(MAX_DISPLAY_TEXT_LENGTH - 1, 0);
  if (visibleLength === 0) return "…";
  return text.slice(0, visibleLength) + "…";
}

function estimateTextTokens(text: string): number {
  if (!text) return 0;
  return Math.max(1, Math.ceil(text.length / 4));
}

function getUsage(usage: AnyRecord | undefined | null): TokenUsage | null {
  if (!isRecord(usage)) return null;
  const promptDetails = isRecord(usage.prompt_tokens_details) ? usage.prompt_tokens_details : {};
  const inputDetails = isRecord(usage.input_tokens_details) ? usage.input_tokens_details : {};
  const outputDetails = isRecord(usage.output_tokens_details) ? usage.output_tokens_details : {};
  const rawInput = firstNumber(
    usage.input_tokens,
    usage.prompt_tokens,
    usage.inputTokens,
    usage.promptTokens,
    usage.total_input_tokens,
  );
  const outputTokens = firstNumber(
    usage.output_tokens,
    usage.completion_tokens,
    usage.outputTokens,
    usage.completionTokens,
    usage.total_output_tokens,
  );
  const cacheRead = firstNumber(
    usage.cache_read_input_tokens,
    usage.cache_read_tokens,
    usage.cached_input_tokens,
    usage.cacheRead,
    promptDetails.cached_tokens,
    inputDetails.cached_tokens,
  );
  // NOTE: in real VS Code Copilot Chat exports, cache_creation_input_tokens
  // is nested inside prompt_tokens_details, not at the top level. Check both.
  const cacheWrite = firstNumber(
    usage.cache_creation_input_tokens,
    usage.cache_write_input_tokens,
    usage.cache_write_tokens,
    usage.cacheWrite,
    promptDetails.cache_creation_input_tokens,
    promptDetails.cache_creation_tokens,
    inputDetails.cache_creation_tokens,
    outputDetails.cache_creation_tokens,
  );
  if (rawInput + outputTokens + cacheRead + cacheWrite === 0) return null;
  return {
    inputTokens: rawInput,
    outputTokens,
    cacheRead,
    cacheWrite,
    cacheHitRate: computeCacheHitRate(rawInput, cacheWrite, cacheRead),
  };
}

interface NormalizedMessage {
  role: string;
  content: string;
  extraction: PartExtraction;
  raw: AnyRecord;
}

function normalizeMessages(rawMessages: unknown): NormalizedMessage[] {
  if (!Array.isArray(rawMessages)) return [];
  const out: NormalizedMessage[] = [];
  for (let index = 0; index < rawMessages.length; index += 1) {
    const raw = rawMessages[index];
    if (!isRecord(raw)) continue;
    const extraction = extractContentParts(raw.content);
    out.push({
      role: roleFromNumeric(raw.role),
      content: extraction.text,
      extraction,
      raw,
    });
  }
  return out;
}

function buildContextBreakdown(messages: NormalizedMessage[]): AnyRecord {
  const breakdown = {
    system: 0,
    tools: 0, // tool defs are not surfaced in chat exports; folded into system text
    history: 0,
    toolResults: 0,
    user: 0,
    total: 0,
  };

  let lastUserIndex = -1;
  for (let index = 0; index < messages.length; index += 1) {
    if (messages[index].role === "user") lastUserIndex = index;
  }

  for (let index = 0; index < messages.length; index += 1) {
    const role = messages[index].role;
    const tokens = estimateTextTokens(messages[index].content);
    if (role === "system" || role === "developer") breakdown.system += tokens;
    else if (role === "tool") breakdown.toolResults += tokens;
    else if (role === "user" && index === lastUserIndex) breakdown.user += tokens;
    else breakdown.history += tokens;
  }

  breakdown.total = breakdown.system + breakdown.tools + breakdown.history + breakdown.toolResults + breakdown.user;
  return breakdown;
}

function getLastUserText(messages: NormalizedMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role !== "user") continue;
    const text = messages[index].content.trim();
    if (text) return text;
  }
  return "LLM call";
}

function getResponseText(response: AnyRecord | undefined | null): string {
  if (!isRecord(response)) return "";
  if (Array.isArray(response.message)) {
    return response.message.filter((m: unknown) => typeof m === "string").join("");
  }
  if (typeof response.message === "string") return response.message;
  return "";
}

interface ParsedLogEvent {
  log: ChatExportLog;
  promptText: string;
  promptIndex: number;
  logIndexInPrompt: number;
}

function makeEvent(eventIndex: number, ctx: ParsedLogEvent): NormalizedEvent | null {
  const log = ctx.log;
  const metadata = isRecord(log.metadata) ? log.metadata : {};
  const usage = getUsage(metadata.usage);
  if (!usage) return null;

  const rawMessages = isRecord(log.requestMessages) ? log.requestMessages.messages : undefined;
  const messages = normalizeMessages(rawMessages);
  const contextBreakdown = buildContextBreakdown(messages);

  // Aggregate image attachments across all messages in the prompt
  let imageTokens = 0;
  const model = typeof metadata.model === "string" ? metadata.model : null;
  for (let index = 0; index < messages.length; index += 1) {
    const details = messages[index].extraction.imageDetails;
    for (let detailIndex = 0; detailIndex < details.length; detailIndex += 1) {
      imageTokens += estimateImageTokens(model, details[detailIndex]);
    }
  }

  const callName = typeof log.name === "string" ? log.name : null;
  const category = categorizeCallName(callName);
  const responseText = getResponseText(log.response);
  const userText = getLastUserText(messages);
  const displayText = category === "overhead"
    ? `[${callName}] ${responseText || userText}`
    : userText;

  return {
    t: eventIndex,
    agent: "user",
    track: "output",
    text: truncateForDisplay(displayText),
    duration: 1,
    intensity: Math.min(1, Math.max(0.25, ((usage.inputTokens || 0) + (usage.outputTokens || 0)) / 100000)),
    raw: {
      copilotChatExport: {
        logId: log.id,
        logKind: log.kind,
        logType: log.type,
        callName,
        category,
        promptIndex: ctx.promptIndex,
        promptText: ctx.promptText,
        logIndexInPrompt: ctx.logIndexInPrompt,
        responseText,
        requestType: typeof metadata.requestType === "string" ? metadata.requestType : null,
        durationMs: typeof metadata.duration === "number" ? metadata.duration : null,
      },
      costPrompt: {
        index: eventIndex,
        messages: messages.map((m) => m.raw),
        tools: [],          // chat exports do not list tool definitions
        toolNames: [],
        contextBreakdown,
        callName,
        category,
        imageTokens,
      },
    },
    turnIndex: ctx.promptIndex,
    isError: log.type !== "ChatMLSuccess" && log.type !== undefined && log.type !== null,
    model,
    tokenUsage: usage,
  };
}

function buildMetadata(events: NormalizedEvent[], promptCount: number): SessionMetadata {
  const models: Record<string, number> = {};
  const modelTokenUsage: Record<string, { inputTokens: number; outputTokens: number; cacheRead: number; cacheWrite: number; cacheHitRate?: number }> = {};
  let totalInput = 0;
  let totalOutput = 0;
  let totalCacheRead = 0;
  let totalCacheWrite = 0;
  let errorCount = 0;

  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    const model = event.model || "unknown";
    models[model] = (models[model] || 0) + 1;
    if (event.isError) errorCount += 1;
    if (!event.tokenUsage) continue;
    const usage = event.tokenUsage;
    totalInput += usage.inputTokens || 0;
    totalOutput += usage.outputTokens || 0;
    totalCacheRead += usage.cacheRead || 0;
    totalCacheWrite += usage.cacheWrite || 0;
    if (!modelTokenUsage[model]) modelTokenUsage[model] = { inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0 };
    modelTokenUsage[model].inputTokens += usage.inputTokens || 0;
    modelTokenUsage[model].outputTokens += usage.outputTokens || 0;
    modelTokenUsage[model].cacheRead += usage.cacheRead || 0;
    modelTokenUsage[model].cacheWrite += usage.cacheWrite || 0;
  }

  Object.keys(modelTokenUsage).forEach(function (model) {
    const usage = modelTokenUsage[model];
    usage.cacheHitRate = computeCacheHitRate(usage.inputTokens, usage.cacheWrite, usage.cacheRead);
  });

  const modelEntries = Object.entries(models).sort(function (a, b) { return b[1] - a[1]; });
  const tokenUsage = totalInput + totalOutput + totalCacheRead + totalCacheWrite > 0
    ? {
      inputTokens: totalInput,
      outputTokens: totalOutput,
      cacheRead: totalCacheRead,
      cacheWrite: totalCacheWrite,
      cacheHitRate: computeCacheHitRate(totalInput, totalCacheWrite, totalCacheRead),
    }
    : null;

  return {
    totalEvents: events.length,
    totalTurns: events.length,
    totalToolCalls: 0,
    errorCount,
    duration: events.length > 0 ? events.length : 0,
    models,
    primaryModel: modelEntries.length > 0 ? modelEntries[0][0] : null,
    tokenUsage,
    modelTokenUsage,
    totalCost: estimateMultiModelCost(modelTokenUsage),
    format: "copilot-chat-export",
    customTitle: "Copilot Chat export cost analysis",
    promptCallCount: promptCount,
  };
}

export function parseCopilotChatExport(text: string): ParsedSession | null {
  const parsed = parseJSON(text);
  if (!isRecord(parsed)) return null;
  const root = parsed as ChatExportRoot;
  if (!Array.isArray(root.prompts)) return null;

  const events: NormalizedEvent[] = [];
  let eventIndex = 0;
  for (let promptIndex = 0; promptIndex < root.prompts.length; promptIndex += 1) {
    const prompt = root.prompts[promptIndex];
    if (!isRecord(prompt) || !Array.isArray(prompt.logs)) continue;
    for (let logIndex = 0; logIndex < prompt.logs.length; logIndex += 1) {
      const log = prompt.logs[logIndex];
      if (!isRecord(log)) continue;
      if (log.kind && log.kind !== "request") continue; // skip toolCall marker logs
      const event = makeEvent(eventIndex, {
        log,
        promptText: typeof prompt.prompt === "string" ? prompt.prompt : "",
        promptIndex,
        logIndexInPrompt: logIndex,
      });
      if (event) {
        events.push(event);
        eventIndex += 1;
      }
    }
  }

  if (events.length === 0) return null;

  const turns: SessionTurn[] = events.map(function (event, index) {
    return {
      index,
      startTime: event.t,
      endTime: event.t + event.duration,
      eventIndices: [index],
      userMessage: event.text,
      toolCount: 0,
      hasError: Boolean(event.isError),
    };
  });

  return { events, turns, metadata: buildMetadata(events, root.prompts.length) };
}
