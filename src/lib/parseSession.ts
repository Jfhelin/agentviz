/**
 * Auto-detect session file format and route to the correct parser.
 *
 * Supported formats:
 *   - Copilot CLI JSONL (producer: "copilot-agent")
 *   - VS Code Copilot Chat JSON (version + requests + sessionId)
 *   - VS Code Copilot prompt exports (copilot_all_prompts_*.json)
 *   - Claude Code JSONL (default fallback)
 *
 * Returns: { events, turns, metadata } or null
 */

import { detectAtif, parseAtifJSON } from "./atifParser";
import { detectCopilotCli, parseCopilotCliJSONL } from "./copilotCliParser";
import { detectCopilotPrompts, parseCopilotPromptsJSON } from "./copilotCostParser";
import { parseClaudeCodeJSONL } from "./parser";
import { detectVSCodeChat, parseVSCodeChatJSON } from "./vscodeSessionParser";
import type { ParsedSession, SessionFormat } from "./sessionTypes";

export function detectFormat(text: string): SessionFormat {
  if (detectAtif(text)) return "atif";
  if (detectCopilotCli(text)) return "copilot-cli";
  if (detectVSCodeChat(text)) return "vscode-chat";
  if (detectCopilotPrompts(text)) return "copilot-prompts";
  return "claude-code";
}

export function parseSession(text: string): ParsedSession | null {
  const format = detectFormat(text);

  let parsed: ParsedSession | null;
  if (format === "atif") parsed = parseAtifJSON(text);
  else if (format === "copilot-cli") parsed = parseCopilotCliJSONL(text);
  else if (format === "vscode-chat") parsed = parseVSCodeChatJSON(text);
  else if (format === "copilot-prompts") parsed = parseCopilotPromptsJSON(text);
  else parsed = parseClaudeCodeJSONL(text);

  if (parsed) pairToolCallsWithResults(parsed);
  return parsed;
}

/**
 * Generic post-processing: for each tool_call event missing `toolOutput`,
 * find a sibling context event whose raw payload references its id and
 * attach that text. Lets all formats expose paired Input/Output to inspectors
 * without each parser duplicating the pairing logic.
 */
function pairToolCallsWithResults(parsed: ParsedSession): void {
  const events = parsed.events;
  if (!events || events.length === 0) return;

  const resultById = new Map<string, string>();
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    if (event.track !== "context") continue;
    const raw = event.raw as Record<string, unknown> | null | undefined;
    if (!raw) continue;
    const candidates = [raw.tool_use_id, raw.toolCallId, raw.tool_call_id, raw.source_call_id];
    for (let candidateIndex = 0; candidateIndex < candidates.length; candidateIndex += 1) {
      const id = candidates[candidateIndex];
      if (typeof id === "string" && id.length > 0 && typeof event.text === "string" && event.text.length > 0) {
        resultById.set(id, event.text);
        break;
      }
    }
  }

  if (resultById.size === 0) return;

  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    if (event.track !== "tool_call") continue;
    if (event.toolOutput) continue;
    const raw = event.raw as Record<string, unknown> | null | undefined;
    const ids: Array<unknown> = [event.toolCallId];
    if (raw) ids.push(raw.id, raw.toolCallId, raw.tool_call_id);
    for (let idIndex = 0; idIndex < ids.length; idIndex += 1) {
      const id = ids[idIndex];
      if (typeof id !== "string") continue;
      const result = resultById.get(id);
      if (result) {
        event.toolOutput = result;
        break;
      }
    }
  }
}
