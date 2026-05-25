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
import {
  analyzeToolDefinitionShape,
  type ActualToolCall,
  type ToolDefinitionShapeAnalysis,
} from "./toolDefinitionShape";
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
      completion_tokens_details?: {
        reasoning_tokens?: number;
        accepted_prediction_tokens?: number;
        rejected_prediction_tokens?: number;
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

interface Skill {
  name: string;
  description: string;
  file: string;
  /** Length of the entire `<skill>...</skill>` block in chars (description dominates). */
  chars: number;
}

interface ScaffoldingSection {
  /** The XML-ish tag name (e.g. `securityRequirements`, `toolUseInstructions`). */
  tag: string;
  /** Length of the section's inner text in chars. */
  chars: number;
  /** Inner text body, truncated to ~1500 chars for hover preview. */
  body: string;
}

interface FileAttachment {
  filePath: string;
  chars: number;
}

interface EnvironmentInfo {
  os: string;
  workspaceFolders: string[];
}

interface ChatMode {
  /** Name from `<modeInstructions>... "Name" ...`. Empty when no mode is active. */
  name: string;
  /** Body of the mode instructions (between `<modeInstructions>` and `</modeInstructions>`). */
  body: string;
  /** Estimated tokens for the mode body (chars/4). */
  tokensEst: number;
}

interface InstructionAttachment {
  filePath: string;
  /** Length of the attachment body in chars (used to estimate token weight). */
  chars: number;
}

export interface CurrentPart {
  /** Either a tag name like `userRequest` / `attachments` / `editorContext`,
   * or the literal `(plaintext)` for text outside any tag. */
  tag: string;
  /** Length of the inner content in chars (excluding the wrapping tags). */
  chars: number;
  /** Inner body, truncated for hover preview. */
  body: string;
  /** True when this part came from a recognised top-level XML tag in the
   * user message, false for plaintext residuals. */
  isTagged: boolean;
}

interface ClassifiedCall {
  components: ComponentBreakdown;
  /** Raw character counts per bucket (pre-scaling). Used by cacheAnalysis to
   * detect what content actually changed between calls without being fooled
   * by the per-call rescaling that makes unchanged buckets like `system`
   * appear to grow. */
  componentChars: ComponentBreakdown;
  systemPreview: string;
  systemChars: number;
  /** Text at the start of the system prompt before any recognised tagged
   * block (`<modeInstructions>`, `<skills>`, scaffolding, etc.). Typically
   * the role preamble like "You are an expert AI programming assistant...". */
  systemPreamble: string;
  systemHash: string;
  currentText: string;
  /** Per-section breakdown of the current (last-user) prompt, mirroring how
   * we show the system prompt's anatomy. Each section is either a top-level
   * `<tag>...</tag>` block (e.g. `<attachments>`, `<context>`,
   * `<userRequest>`, `<editorContext>`, `<reminderInstructions>`) or a
   * residual "(plaintext)" entry for any text outside such tags. Tooltips
   * surface the body so users can see why their "current prompt" is much
   * larger than the actual question they typed. */
  currentParts: CurrentPart[];
  historyMsgs: { role: "user" | "assistant"; chars: number; tokens: number; preview: string }[];
  toolResultMsgs: { chars: number; tokens: number; preview: string; full: string; truncated: boolean; label: string }[];
  totalTools: number;
  toolGroups: { source: string; tools: { name: string; chars: number; tokens: number; description?: string; paramSummary?: string }[]; chars: number; tokens: number }[];
  /** Image attachments referenced by this call's request messages. The export
   * carries only a CDN URL, mediaType, and detail level -- no byte size,
   * dimensions, or token cost. */
  images: ImageAttachment[];
  /** Custom chat mode active for this call, extracted from the system prompt's
   * `<modeInstructions>` wrapper. Null when running the default Copilot agent. */
  chatMode: ChatMode | null;
  /** Workspace-level instruction files (`.github/copilot-instructions.md`,
   * `.chatmode.md`, `.instructions.md`) attached via `<attachment filePath="...">`
   * blocks in the system prompt. */
  instructionAttachments: InstructionAttachment[];
  /** Skills declared in the `<skills>` block of the system prompt. Each is a
   * named capability with a description and a file path the model can read
   * on demand for full instructions. */
  skills: Skill[];
  /** Stable VS Code Copilot scaffolding sections (security, tool-use, comms,
   * memory, etc.) that are part of every system prompt regardless of mode.
   * Surfacing them lets the user see how much of the system bucket is fixed
   * Copilot boilerplate vs their custom configuration. */
  scaffoldingSections: ScaffoldingSection[];
  /** Non-instruction `<attachment filePath="...">` blocks from the system
   * prompt (e.g. user `#file:foo.ts` references). Instruction files are
   * tracked separately in `instructionAttachments`. */
  fileAttachments: FileAttachment[];
  /** Environment + workspace context extracted from the user-role
   * `<environment_info>` / `<workspace_info>` blocks. Null when neither tag
   * is present. */
  environment: EnvironmentInfo | null;
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

// Extract the active custom chat mode (if any) from the system prompt.
// VS Code wraps mode-specific instructions in `<modeInstructions>...</modeInstructions>`
// with a leading line "You are currently running in \"NAME\" mode" (or, for some
// modes, just a `# Heading`). The full block typically runs a few KB.
function extractChatMode(systemText: string): ChatMode | null {
  const m = /<modeInstructions>([\s\S]*?)<\/modeInstructions>/i.exec(systemText);
  if (!m) return null;
  const body = m[1].trim();
  if (!body) return null;
  let name = "";
  const named = /You are currently running in\s*"([^"]+)"/i.exec(body);
  if (named) name = named[1];
  if (!name) {
    const heading = /^#\s+(.+?)\s*$/m.exec(body);
    if (heading) name = heading[1].trim();
  }
  if (!name) name = "(unnamed mode)";
  return { name, body, tokensEst: chars_to_tokens(body.length) };
}

// Extract workspace-level instruction files attached to the system prompt.
// `<attachment filePath="/abs/path/file.md">body</attachment>` blocks are how
// VS Code surfaces .github/copilot-instructions.md, .chatmode.md, and
// .instructions.md files. We only count instruction-style files so this
// doesn't grab arbitrary file attachments.
function extractInstructionAttachments(systemText: string): InstructionAttachment[] {
  const out: InstructionAttachment[] = [];
  const re = /<attachment filePath="([^"]+)">([\s\S]*?)<\/attachment>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(systemText)) !== null) {
    if (!isInstructionFile(m[1])) continue;
    out.push({ filePath: m[1], chars: m[2].length });
  }
  return out;
}

function isInstructionFile(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  return lower.endsWith("copilot-instructions.md")
    || lower.endsWith(".chatmode.md")
    || lower.endsWith(".instructions.md")
    || lower.includes("/.github/instructions/")
    || lower.includes("/.github/chatmodes/");
}

// Extract NON-instruction `<attachment filePath="...">` blocks: file references
// that the user added via `#file:` or that VS Code attached automatically
// (current file, selection, etc.). Workspace instruction files are handled
// separately by `extractInstructionAttachments`.
function extractFileAttachments(systemText: string): FileAttachment[] {
  const out: FileAttachment[] = [];
  const re = /<attachment filePath="([^"]+)">([\s\S]*?)<\/attachment>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(systemText)) !== null) {
    if (isInstructionFile(m[1])) continue;
    out.push({ filePath: m[1], chars: m[2].length });
  }
  return out;
}

// Extract user-installed skills declared in the `<skills>...<skill>...</skill>...</skills>`
// block. Each skill has a name, description, and file path the model can read
// on demand for the full instructions.
function extractSkills(systemText: string): Skill[] {
  const skillsBlock = /<skills>([\s\S]*?)<\/skills>/i.exec(systemText);
  if (!skillsBlock) return [];
  const inner = skillsBlock[1];
  const out: Skill[] = [];
  const re = /<skill>([\s\S]*?)<\/skill>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(inner)) !== null) {
    const body = m[1];
    const name = (/<name>([\s\S]*?)<\/name>/i.exec(body)?.[1] ?? "").trim();
    const description = (/<description>([\s\S]*?)<\/description>/i.exec(body)?.[1] ?? "").trim();
    const file = (/<file>([\s\S]*?)<\/file>/i.exec(body)?.[1] ?? "").trim();
    out.push({ name, description, file, chars: m[0].length });
  }
  return out;
}

// Stable Copilot scaffolding sections present in every system prompt. We list
// them explicitly so we can both detect them and call them out as "fixed
// scaffolding" in the UI. Tags not in this list are still summed into the
// "other" bucket so nothing is silently dropped.
// Known stable Copilot-injected scaffolding blocks. We only list **leaf**
// sections here -- not wrappers like `<instructions>`, which themselves
// contain `<skills>` and `<attachment>` blocks. Counting the wrapper would
// double-count its inner content and inflate the anatomy beyond 100%.
const SCAFFOLDING_TAGS = [
  "securityRequirements", "operationalSafety", "implementationDiscipline",
  "parallelizationStrategy", "toolUseInstructions", "toolSearchInstructions",
  "communicationStyle", "communicationExamples", "notebookInstructions",
  "outputFormatting", "fileLinkification", "memoryInstructions",
  "memoryScopes", "memoryGuidelines",
];

function extractScaffolding(systemText: string): ScaffoldingSection[] {
  const out: ScaffoldingSection[] = [];
  const MAX_BODY = 1500;
  for (const tag of SCAFFOLDING_TAGS) {
    const re = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, "gi");
    let m: RegExpExecArray | null;
    while ((m = re.exec(systemText)) !== null) {
      const inner = m[1];
      const body = inner.length > MAX_BODY ? inner.slice(0, MAX_BODY).trim() + "\n…[truncated]" : inner.trim();
      out.push({ tag, chars: inner.length, body });
    }
  }
  return out;
}

// Walk the user-message text and extract top-level `<tag>...</tag>` blocks
// regardless of which tag name they use (unlike extractScaffolding which is
// limited to a fixed list for the system prompt). VS Code Copilot wraps the
// user's actual question in scaffolding tags like `<attachments>`,
// `<context>`, `<editorContext>`, `<reminderInstructions>`, `<userRequest>`
// etc. Surfacing each as its own row makes it easy to see why a "current
// prompt" can be 5x the size of what the user actually typed.
function extractCurrentParts(text: string): CurrentPart[] {
  const out: CurrentPart[] = [];
  const MAX_BODY = 1500;
  // Match top-level <tag>...</tag>. Use lazy match and require matching tag
  // name on close. Tags themselves may not contain attributes for closing.
  const re = /<([a-zA-Z][a-zA-Z0-9_]*)(?:\s[^>]*)?>([\s\S]*?)<\/\1>/g;
  let cursor = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > cursor) {
      const between = text.slice(cursor, m.index);
      if (between.trim().length > 0) {
        const body = between.length > MAX_BODY ? between.slice(0, MAX_BODY).trim() + "\n…[truncated]" : between.trim();
        out.push({ tag: "(plaintext)", chars: between.length, body, isTagged: false });
      }
    }
    const inner = m[2];
    const body = inner.length > MAX_BODY ? inner.slice(0, MAX_BODY).trim() + "\n…[truncated]" : inner.trim();
    out.push({ tag: m[1], chars: inner.length, body, isTagged: true });
    cursor = m.index + m[0].length;
  }
  if (cursor < text.length) {
    const tail = text.slice(cursor);
    if (tail.trim().length > 0) {
      const body = tail.length > MAX_BODY ? tail.slice(0, MAX_BODY).trim() + "\n…[truncated]" : tail.trim();
      out.push({ tag: "(plaintext)", chars: tail.length, body, isTagged: false });
    }
  }
  // If nothing matched at all, return a single plaintext part.
  if (out.length === 0 && text.length > 0) {
    const body = text.length > MAX_BODY ? text.slice(0, MAX_BODY).trim() + "\n…[truncated]" : text.trim();
    out.push({ tag: "(plaintext)", chars: text.length, body, isTagged: false });
  }
  return out;
}

// Extract environment + workspace context from the user-role messages. VS Code
// injects `<environment_info>` and `<workspace_info>` as the first user
// message in the request. We scan all user messages so a model switch that
// reorders messages still finds them.
function extractEnvironment(messages: RawMessage[]): EnvironmentInfo | null {
  let os = "";
  const folders: string[] = [];
  for (const msg of messages) {
    if (msg.role !== 1) continue;
    const text = messageText(msg);
    const envM = /<environment_info>([\s\S]*?)<\/environment_info>/i.exec(text);
    if (envM) {
      const osM = /current OS is:\s*([^\n<]+)/i.exec(envM[1]);
      if (osM && !os) os = osM[1].trim();
    }
    const wsM = /<workspace_info>([\s\S]*?)<\/workspace_info>/i.exec(text);
    if (wsM) {
      const lines = wsM[1].split("\n");
      for (const line of lines) {
        const fm = /^\s*[-*]\s+(\S.*?)\s*$/.exec(line);
        if (fm && !folders.includes(fm[1])) folders.push(fm[1]);
      }
    }
  }
  if (!os && folders.length === 0) return null;
  return { os, workspaceFolders: folders };
}

// Build a compact summary of a JSON Schema-style tool parameters object,
// e.g. "intent, domain, scope, timeEstimate, confidence, reasoning (6 required)".
function summarizeToolParameters(params: unknown): string {
  if (!params || typeof params !== "object") return "";
  const obj = params as { properties?: Record<string, unknown>; required?: unknown };
  const props = obj.properties && typeof obj.properties === "object" ? Object.keys(obj.properties) : [];
  if (props.length === 0) return "";
  const required = Array.isArray(obj.required) ? obj.required.length : 0;
  const head = props.slice(0, 6).join(", ");
  const tail = props.length > 6 ? ", +" + (props.length - 6) + " more" : "";
  const req = required > 0 ? " (" + required + " required)" : "";
  return head + tail + req;
}

/** FNV-1a 32-bit hash, 8-char hex. Mirrors compareCost.ts's hashStr so that
 * Run Drift can compare full-text hashes computed at parse time against
 * preview-only hashes computed downstream. */
function fnv1aHex(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
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
      toolResultMsgs.push({
        chars: len,
        tokens: 0,
        preview: text.slice(0, 240),
        // Keep a much larger slice so the per-call detail panel can show a
        // genuinely useful expanded view (line-wise summary, full text).
        // 8KB covers ~120 lines of typical tool output without bloating
        // memory for sessions with hundreds of calls.
        full: text.slice(0, 8000),
        truncated: text.length > 8000,
        label,
      });
    }
  });

  // Tool definitions
  const tools = log.metadata?.tools ?? [];
  const toolDefBuckets = new Map<string, { tools: { name: string; chars: number; tokens: number; description?: string; paramSummary?: string }[]; chars: number }>();
  let toolDefChars = 0;
  for (const tool of tools) {
    const json = JSON.stringify(tool);
    const len = json.length;
    toolDefChars += len;
    const fn = (tool as { function?: { name?: string; description?: string; parameters?: unknown } }).function;
    const name = (tool as { name?: string }).name ?? fn?.name ?? "(unnamed)";
    const description = fn?.description ?? (tool as { description?: string }).description ?? "";
    const paramSummary = summarizeToolParameters(fn?.parameters ?? (tool as { parameters?: unknown }).parameters);
    const group = classifyToolGroup(name);
    if (!toolDefBuckets.has(group)) toolDefBuckets.set(group, { tools: [], chars: 0 });
    const b = toolDefBuckets.get(group)!;
    b.tools.push({ name, chars: len, tokens: 0, description, paramSummary });
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

  const chatMode = extractChatMode(systemText);
  const instructionAttachments = extractInstructionAttachments(systemText);
  const skills = extractSkills(systemText);
  const scaffoldingSections = extractScaffolding(systemText);
  const fileAttachments = extractFileAttachments(systemText);
  const environment = extractEnvironment(messages);

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
    systemChars: systemText.length,
    systemPreamble: (function () {
      const firstTag = systemText.search(/<[a-zA-Z][\w-]*[^>]*>/);
      return firstTag > 0 ? systemText.slice(0, firstTag).trim() : systemText.slice(0, 800).trim();
    })(),
    systemHash: fnv1aHex(systemText.trim().replace(/\s+/g, " ")),
    currentText: currentText.slice(0, 600),
    currentParts: extractCurrentParts(currentText),
    historyMsgs,
    toolResultMsgs,
    totalTools: tools.length,
    toolGroups,
    images,
    chatMode,
    instructionAttachments,
    skills,
    scaffoldingSections,
    fileAttachments,
    environment,
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
  producedToolCalls: { name: string; argsSummary: string; rawArgs: string }[];
  /** Reasoning blocks (extended thinking) that the model emitted as part of
   * this LLM response, before each tool_use it produced. In the export these
   * are attached to the `toolCall` log entries that follow this request; we
   * lift them onto the request event because they semantically belong to the
   * model's response and are billed as output tokens on THIS call, not on
   * the client-side tool execution. Empty when the model didn't emit any
   * extended thinking on this turn. */
  reasoningBlocks: { tool: string; text: string }[];
  /** Set when the model emitted output tokens but neither a text response
   * nor a captured tool call. This is the classic "internal tool call"
   * pattern used by overhead calls like promptCategorization: the model
   * invoked a single exposed tool that the host consumed directly without
   * logging a separate toolCall entry. We surface the exposed tools so the
   * detail panel can say "model likely called X" instead of rendering an
   * empty `{"type":"success","message":[""]}` blob. Null when the response
   * text was non-empty or the model produced visible tool calls. */
  silentToolCall: { likelyTools: string[]; outputTokens: number } | null;
  model: string;
  duration: number;
  promptTokens: number;
  cached: number;
  cacheWrite: number;
  fresh: number;
  output: number;
  /** Subset of `output` that the model spent on internal reasoning / extended
   * thinking (OpenAI o-series, Claude extended thinking). 0 when the model
   * either doesn't expose reasoning or wasn't asked to think extendedly.
   * Visible output = output - reasoningTokens. */
  reasoningTokens: number;
  /** Character count of the user-visible response text from this call (full,
   * not truncated). Used to attribute a portion of output tokens to "what
   * the user saw" vs internal reasoning vs tool-call structured args. */
  visibleResponseChars: number;
  /** Total character count of `thinking.text` blocks attached to tool_use
   * outputs produced by this LLM call. Anthropic surfaces extended thinking
   * as plaintext blocks paired with each tool_use; some portions may be
   * redacted/encrypted and thus not present here. */
  thinkingChars: number;
  /** Total character count of JSON tool-call arguments emitted by this LLM
   * call. These count as output tokens (structured assistant message
   * payload) but are not part of either visible response text or thinking. */
  toolArgsChars: number;
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
  /** Raw character counts per ctx component, BEFORE scaling to match the
   * model's reported `prompt_tokens`. Lets consumers distinguish real
   * component-size changes from scaling-artifact growth -- if
   * `componentChars.tool_defs` is byte-identical across calls but
   * `components.tool_defs` (the scaled token estimate) grows, the growth
   * is purely from the per-call scale factor being inflated by another
   * under-estimated component. */
  componentChars: ComponentBreakdown;
  /** Estimated input tokens for the new images on this call (added to the
   * `current` bucket of `components` for display). 0 when no images are new
   * or the model has no documented image-token rule. Approximation only --
   * the export does not report exact image token usage. */
  imageTokensEst: number;
  /** Estimated input tokens for ALL images on this call, including ones
   * carried over from prior cached calls. Used by the view to surface vision
   * weight on every call that contains images (not just the call that first
   * introduced them). Per-image estimate via `imageTokenEstimate`. */
  visionTokensTotal: number;
  totalTools: number;
  toolGroups: ClassifiedCall["toolGroups"];
  /** Classification of the model-visible tool definitions on this call as
   *  direct vs router/grouped vs possible-router vs unknown. Router-usage
   *  detection uses the tool calls this LLM call produced (next-up
   *  `toolCall` log entries until the next `request`). */
  toolDefinitionShape: ToolDefinitionShapeAnalysis;
  historyMsgs: ClassifiedCall["historyMsgs"];
  toolResultMsgs: ClassifiedCall["toolResultMsgs"];
  /** Image attachments referenced by this call. The export gives URL, media
   * type, and detail level only -- no byte size, dimensions, or token cost. */
  images: ClassifiedCall["images"];
  /** Custom chat mode active for this call (null when running the default
   * Copilot agent). Extracted from the system prompt's `<modeInstructions>`
   * block. */
  chatMode: ClassifiedCall["chatMode"];
  /** Workspace-level instruction files attached to the system prompt
   * (`.github/copilot-instructions.md`, `.chatmode.md`, `.instructions.md`). */
  instructionAttachments: ClassifiedCall["instructionAttachments"];
  /** Skills declared in the `<skills>` block of the system prompt. */
  skills: ClassifiedCall["skills"];
  /** Stable Copilot scaffolding sections present in every system prompt. */
  scaffoldingSections: ClassifiedCall["scaffoldingSections"];
  /** Non-instruction file attachments referenced in the system prompt
   * (e.g. user `#file:foo.ts` references). */
  fileAttachments: ClassifiedCall["fileAttachments"];
  /** Environment + workspace context from `<environment_info>` / `<workspace_info>`. */
  environment: ClassifiedCall["environment"];
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
  systemChars: number;
  systemPreamble: string;
  systemHash: string;
  currentText: string;
  /** Per-section anatomy of the current (last-user) prompt. See
   * `CurrentPart` for shape; surfaces top-level tagged blocks like
   * `<userRequest>`, `<attachments>`, `<context>`, plus any plaintext
   * residual, so the user can see how much of the "current prompt" bucket
   * is actually their question vs Copilot scaffolding. */
  currentParts: CurrentPart[];
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
  /** Larger slice of the tool result (up to ~8KB) used by the per-call
   * detail panel's collapsible "show full result" view. May still be
   * truncated for very long results -- see `resultTruncated`. */
  resultFull: string;
  /** True when `resultFull` was capped at the parser's 8KB limit, meaning
   * the original tool result was longer than what we kept. */
  resultTruncated: boolean;
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
  /** Full user message text for this prompt (untruncated). `label` is a
   * short preview of the same string. Used by exports that need to ship
   * the prompt verbatim. */
  userMessage: string;
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
  /** Session-level shape of model-visible tool definitions, unioned by tool
   *  name across all primary calls. Router-usage stats are computed from
   *  every `toolCall` log entry in the session. */
  toolDefinitionShape: ToolDefinitionShapeAnalysis;
  totals: {
    promptTokens: number;
    output: number;
    /** Sum of reasoning_tokens across all primary LLM calls (extended
     * thinking / o-series reasoning). Subset of `output`. */
    reasoning: number;
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

// Extract the chat thread title that VS Code generates via the `title` overhead
// LLM call on the first prompt. Returns a short string or empty if none.
function extractGeneratedTitle(root: { prompts: RawPrompt[] }): string {
  for (const p of root.prompts) {
    for (const log of p.logs) {
      if (log.kind !== "request") continue;
      if (log.name !== "title") continue;
      const summary = summarizeResponse(log.response);
      if (!summary) continue;
      const cleaned = summary
        .replace(/^["'\s]+|["'\s]+$/g, "")
        .replace(/\s+/g, " ")
        .trim();
      if (cleaned) return cleaned.length > 120 ? cleaned.slice(0, 120) + "…" : cleaned;
    }
  }
  return "";
}

function summarizeResponse(response: unknown): string {
  if (response == null) return "";
  if (typeof response === "string") {
    return response.length > 4000 ? response.slice(0, 4000) + "…" : response;
  }
  if (typeof response === "object") {
    const obj = response as Record<string, unknown>;
    // VS Code Copilot Chat shape: { type: "success" | "error", message: string[] }
    if (Array.isArray(obj.message)) {
      const joined = (obj.message as unknown[])
        .filter((m) => typeof m === "string")
        .join("\n")
        .trim();
      if (joined) return joined.length > 4000 ? joined.slice(0, 4000) + "…" : joined;
      // Empty message array (or array of empty strings) means the model produced
      // no text content this turn (typically because it spent its output budget
      // on a tool call). Don't surface the raw envelope JSON.
      return "";
    }
    try {
      const json = JSON.stringify(obj);
      return json.length > 4000 ? json.slice(0, 4000) + "…" : json;
    } catch {
      return "";
    }
  }
  return "";
}

/** Total character count of the user-visible response text. Unlike
 * summarizeResponse() this is the FULL length (not truncated) and
 * extracts text from both string-array and structured-content shapes. */
function visibleResponseChars(response: unknown): number {
  if (response == null) return 0;
  if (typeof response === "string") return response.length;
  if (typeof response !== "object") return 0;
  const obj = response as Record<string, unknown>;
  let n = 0;
  if (Array.isArray(obj.message)) {
    for (const m of obj.message as unknown[]) {
      if (typeof m === "string") n += m.length;
      else if (m && typeof m === "object" && typeof (m as { text?: unknown }).text === "string") {
        n += ((m as { text: string }).text).length;
      }
    }
  }
  return n;
}

function callUsage(log: RawLog): { prompt_tokens: number; cached_tokens: number; cache_write: number; completion_tokens: number; reasoning_tokens: number } {
  const u = log.metadata?.usage ?? {};
  const ptd = u.prompt_tokens_details ?? {};
  const ctd = u.completion_tokens_details ?? {};
  return {
    prompt_tokens: u.prompt_tokens ?? 0,
    completion_tokens: u.completion_tokens ?? 0,
    cached_tokens: ptd.cached_tokens ?? 0,
    cache_write: u.cache_creation_input_tokens ?? ptd.cache_creation_input_tokens ?? 0,
    reasoning_tokens: ctd.reasoning_tokens ?? 0,
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
  // Session-level shape inputs: union all model-visible tool definitions by
  // name across primary requests, and collect every actual `toolCall` log so
  // router-usage detection covers the whole session.
  const sessionUniqueTools = new Map<string, unknown>();
  const sessionActualCalls: ActualToolCall[] = [];
  const events: NormalizedEvent[] = [];
  const turns: SessionTurn[] = [];
  let cumCost = 0;
  let cumPt = 0, cumOut = 0, cumCached = 0, cumCwrite = 0, cumFresh = 0, cumReasoning = 0;
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
        // Feed session-level router-usage detection (uses parsed args).
        let toolCallArgsParsed: Record<string, unknown> | null = null;
        if (log.args && typeof log.args === "object") toolCallArgsParsed = log.args as Record<string, unknown>;
        else if (typeof log.args === "string" && log.args.trim().startsWith("{")) {
          try { toolCallArgsParsed = JSON.parse(log.args) as Record<string, unknown>; } catch { /* ignore */ }
        }
        sessionActualCalls.push({ name: log.tool ?? "", args: toolCallArgsParsed });
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
          resultFull: "",
          resultTruncated: false,
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
      // Union this call's model-visible tool definitions into the session-
      // level set, keyed by tool name (first occurrence wins). Only primary
      // calls are interesting for the shape report, but adding overhead calls
      // is harmless because their tools tend to be a subset.
      for (const tool of (log.metadata?.tools ?? [])) {
        const name = (tool as { function?: { name?: string }; name?: string })?.function?.name
          ?? (tool as { name?: string })?.name
          ?? "(unnamed)";
        if (!sessionUniqueTools.has(name)) sessionUniqueTools.set(name, tool);
      }
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
      cumPt += usage.prompt_tokens; cumOut += out_t; cumReasoning += usage.reasoning_tokens;
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
          pendingToolCalls[i].resultFull = tr.full;
          pendingToolCalls[i].resultTruncated = tr.truncated;
        }
      });
      pendingToolCalls.length = 0;

      // Look forward in this prompt's logs to the next request log; the
      // toolCall logs in between are what this LLM call produced. This is
      // critical for showing "what the model did" when its text response is
      // empty (model emitted only tool_use blocks, no message content).
      const producedToolCalls: { name: string; argsSummary: string; rawArgs: string }[] = [];
      // Same call set, but with parsed args, used by the router-usage
      // detection in the tool-definition-shape analysis.
      const producedActualCalls: ActualToolCall[] = [];
      const reasoningBlocks: { tool: string; text: string }[] = [];
      let toolArgsChars = 0;
      let thinkingChars = 0;
      for (let lookIdx = logIdx + 1; lookIdx < c.logs.length; lookIdx++) {
        const next = c.logs[lookIdx];
        if (next.kind === "request") break;
        if (next.kind === "toolCall") {
          producedToolCalls.push({
            name: next.tool ?? "",
            argsSummary: shortArgs(next.args),
            rawArgs: next.args == null ? "" : (typeof next.args === "string" ? next.args : JSON.stringify(next.args)),
          });
          let parsedArgs: Record<string, unknown> | null = null;
          if (next.args && typeof next.args === "object") parsedArgs = next.args as Record<string, unknown>;
          else if (typeof next.args === "string" && next.args.trim().startsWith("{")) {
            try { parsedArgs = JSON.parse(next.args) as Record<string, unknown>; } catch { /* ignore */ }
          }
          producedActualCalls.push({ name: next.tool ?? "", args: parsedArgs });
          const thinkText = next.thinking?.text ?? "";
          if (thinkText) {
            reasoningBlocks.push({ tool: next.tool ?? "", text: thinkText });
            thinkingChars += thinkText.length;
          }
          // Tool-call args (JSON the model emitted) count as output tokens.
          // Sum raw arg length to attribute the structured-output portion of
          // completion_tokens.
          if (typeof next.args === "string") toolArgsChars += next.args.length;
          else if (next.args && typeof next.args === "object") {
            try { toolArgsChars += JSON.stringify(next.args).length; } catch { /* ignore */ }
          }
        }
      }
      const visResp = visibleResponseChars(log.response);

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
      let visionTokensTotal = 0;
      for (const img of cls.images) {
        visionTokensTotal += estimateImageTokens(model, img.detail);
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
        reasoningBlocks,
        silentToolCall: (function () {
          const respText = (summarizeResponse(log.response) || "").trim();
          if (respText.length > 0) return null;
          if (producedToolCalls.length > 0) return null;
          if (out_t <= 0) return null;
          const exposed: string[] = [];
          const rawTools = log.metadata?.tools ?? [];
          for (const t of rawTools) {
            const n = (t as { function?: { name?: string }; name?: string })?.function?.name
              ?? (t as { name?: string })?.name
              ?? null;
            if (n) exposed.push(n);
          }
          if (exposed.length === 0) return null;
          return { likelyTools: exposed.slice(0, 5), outputTokens: out_t };
        })(),
        model,
        duration: log.metadata?.duration ?? 0,
        promptTokens: usage.prompt_tokens,
        cached: usage.cached_tokens,
        cacheWrite: usage.cache_write,
        fresh,
        output: out_t,
        reasoningTokens: usage.reasoning_tokens,
        visibleResponseChars: visResp,
        thinkingChars,
        toolArgsChars,
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
        componentChars: cls.componentChars,
        imageTokensEst,
        visionTokensTotal,
        totalTools: cls.totalTools,
        toolGroups: cls.toolGroups,
        toolDefinitionShape: analyzeToolDefinitionShape(log.metadata?.tools ?? [], producedActualCalls),
        historyMsgs: cls.historyMsgs,
        toolResultMsgs: cls.toolResultMsgs,
        images: cls.images,
        chatMode: cls.chatMode,
        instructionAttachments: cls.instructionAttachments,
        skills: cls.skills,
        scaffoldingSections: cls.scaffoldingSections,
        fileAttachments: cls.fileAttachments,
        environment: cls.environment,
        newImages,
        newHistoryMsgs,
        newToolResultMsgs,
        systemPreview: cls.systemPreview,
        systemChars: cls.systemChars,
        systemPreamble: cls.systemPreamble,
        systemHash: cls.systemHash,
        currentText: cls.currentText,
        currentParts: cls.currentParts,
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
      userMessage: promptText,
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
    toolDefinitionShape: analyzeToolDefinitionShape(
      Array.from(sessionUniqueTools.values()),
      sessionActualCalls,
    ),
    totals: {
      promptTokens: cumPt,
      output: cumOut,
      reasoning: cumReasoning,
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
    generatedTitle: extractGeneratedTitle(root),
  };

  return { events, turns, metadata };
}
