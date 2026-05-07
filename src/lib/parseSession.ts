/**
 * Auto-detect session file format and route to the correct parser.
 *
 * Supported formats:
 *   - Copilot CLI JSONL (producer: "copilot-agent")
 *   - VS Code Copilot Chat export JSON (Export prompts dev tool)
 *   - VS Code Copilot Chat session JSON (version + requests + sessionId)
 *   - Claude Code JSONL (default fallback)
 *
 * Returns: { events, turns, metadata } or null
 */

import { detectCopilotCli, parseCopilotCliJSONL } from "./copilotCliParser";
import { detectCopilotChatExport, parseCopilotChatExport } from "./copilotChatExportParser";
import { parseClaudeCodeJSONL } from "./parser";
import { detectVSCodeChat, parseVSCodeChatJSON } from "./vscodeSessionParser";
import type { ParsedSession, SessionFormat } from "./sessionTypes";

export function detectFormat(text: string): SessionFormat {
  if (detectCopilotCli(text)) return "copilot-cli";
  // Copilot Chat export must be checked before vscode-chat: both are JSON
  // starting with '{', but the export's `prompts[]`+`totalLogEntries` shape
  // is unambiguous.
  if (detectCopilotChatExport(text)) return "copilot-chat-export";
  if (detectVSCodeChat(text)) return "vscode-chat";
  return "claude-code";
}

export function parseSession(text: string): ParsedSession | null {
  const format = detectFormat(text);
  // eslint-disable-next-line no-console
  if (typeof console !== "undefined") {
    console.log("[agentviz][parseSession] detected format", {
      format,
      chars: text ? text.length : 0,
      first120: text ? text.slice(0, 120).replace(/\n/g, "\\n") : "",
    });
  }

  let result: ParsedSession | null;
  try {
    if (format === "copilot-cli") result = parseCopilotCliJSONL(text);
    else if (format === "copilot-chat-export") result = parseCopilotChatExport(text);
    else if (format === "vscode-chat") result = parseVSCodeChatJSON(text);
    else result = parseClaudeCodeJSONL(text);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[agentviz][parseSession] parser threw for format=" + format, err);
    throw err;
  }

  // eslint-disable-next-line no-console
  if (typeof console !== "undefined") {
    console.log("[agentviz][parseSession] result", {
      format,
      ok: !!result,
      events: result ? result.events.length : 0,
      turns: result ? result.turns.length : 0,
    });
  }
  return result;
}
