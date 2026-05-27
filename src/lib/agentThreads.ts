// Agent thread grouping for VS Code Copilot Chat exports.
//
// A "prompt" in the export is one independent conversation thread:
//   - `name === "panel/editAgent"` (or `panel/request`, etc) → main agent
//   - `name === "tool/runSubagent"`                          → subagent thread
//
// The parent's `runSubagent` toolCall carries the subagent's full prompt
// in `args.prompt`. We link parent → child by matching that string to
// the subagent prompt's own `prompt` field — VS Code re-uses the exact
// invocation text as the subagent thread's first user message, which
// gives us a reliable deterministic link without relying on internal IDs.
//
// All main-agent prompts are folded into a single "Main agent" thread
// (sessions can have many user turns; they all belong to the same agent).
// Each subagent prompt becomes its own thread (Sub A, Sub B, …) because
// each is an independent spawned worker with its own context.
//
// The output drives the agent-cards row above the Cost timeline and the
// per-prompt color/badge in the timeline itself.

import type { CostAnalysisPrompt } from "./copilotChatExportParser";

export type AgentSlot = "main" | "sub";

export interface AgentThread {
  /** Stable id used as the filter key. For main, always "main". For
   * subagents, the subagent's promptId (unique within the export). */
  id: string;
  slot: AgentSlot;
  /** Display label: "Main agent" or "Subagent A", "Subagent B", …  */
  label: string;
  /** Short letter suffix for subagents ("A", "B", "C"…); empty for main. */
  letter: string;
  /** Color token key from `theme.agentThread.*` (resolved by the view).
   * Keeping this as a key rather than a hex so the value adapts to
   * light/dark theme. */
  colorKey: string;
  /** PromptIds in this thread, in document order. Main collects every
   * non-subagent prompt; each subagent gets exactly one. */
  promptIds: string[];
  /** Sum of `p.cost` across this thread's prompts. Real numbers — even
   * subagent threads are exported with full per-call usage data when
   * VS Code includes them. */
  totalCost: number;
  /** Sum of `p.llmCount` across this thread's prompts. */
  llmCount: number;
  /** Sum of `p.toolCount` across this thread's prompts. */
  toolCount: number;
  /** Sum of `p.promptTokens` (billed input across this thread). */
  inputTokens: number;
  /** Sum of `p.output` (billed output across this thread). */
  outputTokens: number;
  /** For subagent threads only: the parent's promptId (the main-agent
   * prompt that contained the spawning `runSubagent` tool call). null
   * when we could not locate the spawn site (e.g. the parent prompt
   * isn't in the export). */
  parentPromptId: string | null;
  /** First user-message snippet for subagents (the task assignment).
   * Empty for main. */
  taskSnippet: string;
}

export interface AgentThreadsResult {
  threads: AgentThread[];
  /** O(1) lookup: promptId → thread id. */
  promptIdToThreadId: Map<string, string>;
}

// Stable palette of theme keys cycled across subagent threads. The view
// resolves these to actual colors via `theme.agentThread[key]`. Four
// distinct tones cover the realistic upper bound for one session; we
// cycle if a session somehow has more.
const SUBAGENT_COLOR_KEYS = ["subA", "subB", "subC", "subD"];

function letterFor(index: number): string {
  // 0 → "A", 1 → "B", … 25 → "Z", 26 → "AA", etc. Subagent counts in
  // practice stay well under 26.
  if (index < 26) return String.fromCharCode(65 + index);
  return letterFor(Math.floor(index / 26) - 1) + String.fromCharCode(65 + (index % 26));
}

function firstNonEmptyLine(text: string): string {
  const lines = (text || "").split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed) return trimmed;
  }
  return "";
}

function truncate(text: string, max: number): string {
  if (!text) return "";
  if (text.length <= max) return text;
  return text.slice(0, max).trimEnd() + "…";
}

/** Classify each prompt as main or subagent and return one thread per
 * agent (one shared "main" + N subagent threads). */
export function buildAgentThreads(prompts: CostAnalysisPrompt[]): AgentThreadsResult {
  const result: AgentThreadsResult = {
    threads: [],
    promptIdToThreadId: new Map(),
  };
  if (!prompts || prompts.length === 0) return result;

  // Pass 1: walk the parent prompts and index every `runSubagent` toolCall
  // by its `args.prompt` text. We use that as the link key because it's
  // verbatim re-used as the spawned subagent's first user message.
  // Value = the parent's promptId.
  const spawnerByArgsPrompt = new Map<string, string>();
  for (const p of prompts) {
    if (isSubagentPrompt(p)) continue;
    for (const ev of p.events || []) {
      if (ev.kind !== "tool" || ev.name !== "runSubagent" || !ev.subagent) continue;
      const argsPrompt = ev.subagent.argsPrompt;
      if (argsPrompt) spawnerByArgsPrompt.set(argsPrompt, p.promptId);
    }
  }

  // Always emit a "main agent" thread, even if the session is one prompt.
  // This keeps the UI consistent (filter chip always visible, color
  // assignment stable) instead of switching layouts between agent counts.
  const mainThread: AgentThread = {
    id: "main",
    slot: "main",
    label: "Main agent",
    letter: "",
    colorKey: "main",
    promptIds: [],
    totalCost: 0,
    llmCount: 0,
    toolCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    parentPromptId: null,
    taskSnippet: "",
  };
  result.threads.push(mainThread);

  let subIndex = 0;
  for (const p of prompts) {
    if (isSubagentPrompt(p)) {
      const letter = letterFor(subIndex);
      const colorKey = SUBAGENT_COLOR_KEYS[subIndex % SUBAGENT_COLOR_KEYS.length];
      const thread: AgentThread = {
        id: p.promptId,
        slot: "sub",
        label: "Subagent " + letter,
        letter,
        colorKey,
        promptIds: [p.promptId],
        totalCost: p.cost || 0,
        llmCount: p.llmCount || 0,
        toolCount: p.toolCount || 0,
        inputTokens: p.promptTokens || 0,
        outputTokens: p.output || 0,
        parentPromptId: spawnerByArgsPrompt.get(p.userMessage || "") || null,
        taskSnippet: truncate(firstNonEmptyLine(p.userMessage || ""), 80),
      };
      result.threads.push(thread);
      result.promptIdToThreadId.set(p.promptId, thread.id);
      subIndex += 1;
    } else {
      mainThread.promptIds.push(p.promptId);
      mainThread.totalCost += p.cost || 0;
      mainThread.llmCount += p.llmCount || 0;
      mainThread.toolCount += p.toolCount || 0;
      mainThread.inputTokens += p.promptTokens || 0;
      mainThread.outputTokens += p.output || 0;
      result.promptIdToThreadId.set(p.promptId, "main");
    }
  }

  return result;
}

/** A prompt is a subagent thread iff its first `request` log was named
 * `tool/runSubagent`. The parser surfaces this on each prompt via the
 * `name` field carried up from the first request log. */
function isSubagentPrompt(p: CostAnalysisPrompt): boolean {
  return (p.name || "") === "tool/runSubagent";
}
