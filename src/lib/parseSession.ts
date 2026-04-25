/**
 * Auto-detect session file format and route to the correct parser.
 *
 * Supported formats:
 *   - Copilot CLI JSONL (producer: "copilot-agent")
 *   - VS Code Copilot Chat JSON (version + requests + sessionId)
 *   - Claude Code JSONL (default fallback)
 *
 * Returns: { events, turns, metadata } or null
 */

import { detectAtif, parseAtifJSON } from "./atifParser";
import { detectCopilotCli, parseCopilotCliJSONL } from "./copilotCliParser";
import { parseClaudeCodeJSONL } from "./parser";
import { detectVSCodeChat, parseVSCodeChatJSON } from "./vscodeSessionParser";
import type { ParsedSession, SessionFormat } from "./sessionTypes";

export function detectFormat(text: string): SessionFormat {
  if (detectAtif(text)) return "atif";
  if (detectCopilotCli(text)) return "copilot-cli";
  if (detectVSCodeChat(text)) return "vscode-chat";
  return "claude-code";
}

export function parseSession(text: string): ParsedSession | null {
  const format = detectFormat(text);

  if (format === "atif") return parseAtifJSON(text);
  if (format === "copilot-cli") return parseCopilotCliJSONL(text);
  if (format === "vscode-chat") return parseVSCodeChatJSON(text);
  return parseClaudeCodeJSONL(text);
}
