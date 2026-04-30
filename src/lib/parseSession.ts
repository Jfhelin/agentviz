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

  if (format === "copilot-cli") return parseCopilotCliJSONL(text);
  if (format === "copilot-chat-export") return parseCopilotChatExport(text);
  if (format === "vscode-chat") return parseVSCodeChatJSON(text);
  return parseClaudeCodeJSONL(text);
}
