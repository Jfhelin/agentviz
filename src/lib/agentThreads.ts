import type { CostAnalysisPrompt } from "./copilotChatExportParser";

export interface AgentThread {
  id: string;
  kind: "main" | "subagent";
  label: string;
  promptIds: string[];
  parentPromptId: string | null;
  taskSnippet: string;
  measuredCost: number;
  measuredLlmCalls: number;
  measuredToolCalls: number;
  measuredInputTokens: number;
  measuredOutputTokens: number;
}

export interface AgentThreadsResult {
  threads: AgentThread[];
  promptIdToThreadId: Record<string, string>;
}

function isSubagentPrompt(prompt: CostAnalysisPrompt): boolean {
  return prompt.name === "tool/runSubagent";
}

function firstLine(text: string): string {
  return (text || "").split("\n").map((line) => line.trim()).find(Boolean) || "";
}

function taskSnippet(text: string): string {
  const line = firstLine(text);
  return line.length <= 80 ? line : line.slice(0, 79).trimEnd() + "…";
}

function normalizeTask(text: string): string {
  return (text || "").trim().replace(/\s+/g, " ");
}

export function buildAgentThreads(prompts: CostAnalysisPrompt[]): AgentThreadsResult {
  if (!prompts.length) return { threads: [], promptIdToThreadId: {} };

  const parentsByTask = new Map<string, string[]>();
  for (const prompt of prompts) {
    if (isSubagentPrompt(prompt)) continue;
    for (const event of prompt.events) {
      if (
        event.kind === "tool" &&
        event.name === "runSubagent" &&
        event.subagent?.argsPrompt
      ) {
        const task = normalizeTask(event.subagent.argsPrompt);
        const parents = parentsByTask.get(task) || [];
        parents.push(prompt.promptId);
        parentsByTask.set(task, parents);
      }
    }
  }

  const main: AgentThread = {
    id: "main",
    kind: "main",
    label: "Main agent",
    promptIds: [],
    parentPromptId: null,
    taskSnippet: "",
    measuredCost: 0,
    measuredLlmCalls: 0,
    measuredToolCalls: 0,
    measuredInputTokens: 0,
    measuredOutputTokens: 0,
  };
  const threads: AgentThread[] = [main];
  const promptIdToThreadId: Record<string, string> = {};
  let subagentIndex = 0;

  for (const prompt of prompts) {
    if (!isSubagentPrompt(prompt)) {
      main.promptIds.push(prompt.promptId);
      main.measuredCost += prompt.cost;
      main.measuredLlmCalls += prompt.llmCount;
      main.measuredToolCalls += prompt.toolCount;
      main.measuredInputTokens += prompt.promptTokens;
      main.measuredOutputTokens += prompt.output;
      promptIdToThreadId[prompt.promptId] = main.id;
      continue;
    }

    const letter = String.fromCharCode(65 + (subagentIndex % 26));
    const matchingParents = parentsByTask.get(normalizeTask(prompt.userMessage));
    const thread: AgentThread = {
      id: prompt.promptId,
      kind: "subagent",
      label: "Subagent " + letter,
      promptIds: [prompt.promptId],
      parentPromptId: matchingParents?.shift() || null,
      taskSnippet: taskSnippet(prompt.userMessage),
      measuredCost: prompt.cost,
      measuredLlmCalls: prompt.llmCount,
      measuredToolCalls: prompt.toolCount,
      measuredInputTokens: prompt.promptTokens,
      measuredOutputTokens: prompt.output,
    };
    threads.push(thread);
    promptIdToThreadId[prompt.promptId] = thread.id;
    subagentIndex += 1;
  }

  return { threads, promptIdToThreadId };
}
