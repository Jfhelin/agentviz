import type {
  CostAnalysis,
  CostAnalysisCall,
  CostAnalysisEvent,
} from "./copilotChatExportParser";
// @ts-ignore pricing.js is JavaScript and exposes a stable runtime API.
import { getModelPrice } from "./pricing.js";

export interface SessionAnalysisExportOptions {
  sessionName?: string;
}

function compactCall(call: CostAnalysisCall) {
  return {
    id: call.id,
    name: call.name,
    category: call.category,
    model: call.model,
    durationMs: call.duration,
    usage: {
      input: call.promptTokens,
      cachedInput: call.cached,
      cacheWrite: call.cacheWrite,
      freshInput: call.fresh,
      output: call.output,
      outputAttribution: call.outputAttribution,
    },
    costUsd: call.cost,
    context: call.components,
    cache: {
      deltaVsPreviousSameModel: call.deltaVsPrev,
      unexpectedMiss: call.unexpectedMiss,
      diagnosis: call.cacheMissDiag || null,
    },
    response: {
      visibleText: call.responseText,
      reasoningBlocks: call.reasoningBlocks,
      producedToolCalls: call.producedToolCalls.map((tool) => ({
        name: tool.name,
        arguments: tool.rawArgs,
      })),
    },
    systemPrompt: {
      chars: call.systemChars,
      hash: call.systemHash,
      blocks: call.systemBlocks,
    },
  };
}

function compactEvent(event: CostAnalysisEvent) {
  if (event.kind === "llm") return { kind: "llm", ...compactCall(event) };
  return {
    kind: "tool",
    id: event.id,
    name: event.name,
    arguments: event.rawArgs,
    result: {
      chars: event.resultChars,
      estimatedTokens: event.resultTokens,
      preview: event.resultPreview,
    },
    subagentEstimate: event.subagent
      ? {
          description: event.subagent.description,
          promptChars: event.subagent.promptChars,
          promptTokensEstimated: event.subagent.promptTokensEst,
          model: event.subagent.modelName || null,
        }
      : null,
  };
}

export function buildSessionAnalysisFacts(
  analysis: CostAnalysis,
  options: SessionAnalysisExportOptions = {},
) {
  const models = new Map<string, unknown>();
  for (const prompt of analysis.prompts) {
    for (const event of prompt.events) {
      if (event.kind === "llm" && event.model && !models.has(event.model)) {
        models.set(event.model, getModelPrice(event.model));
      }
    }
  }
  return {
    schemaVersion: 1,
    sessionName: options.sessionName || "AGENTVIZ session",
    methodology: {
      headlineUsage: "Measured request usage only",
      outputInvariant: "visible + reasoning + toolArguments + unattributed = reported output",
      estimates: "Fields containing Estimated or subagentEstimate are supplemental and excluded from measured headline totals",
      currency: "USD; one GitHub Copilot AI Credit equals $0.01",
    },
    totals: analysis.totals,
    threads: analysis.threads,
    models: Array.from(models, ([name, pricing]) => ({ name, pricing })),
    prompts: analysis.prompts.map((prompt) => ({
      index: prompt.index,
      id: prompt.promptId,
      name: prompt.name,
      userMessage: prompt.userMessage,
      measured: {
        llmCalls: prompt.llmCount,
        toolCalls: prompt.toolCount,
        input: prompt.promptTokens,
        output: prompt.output,
        costUsd: prompt.cost,
      },
      events: prompt.events.map(compactEvent),
    })),
  };
}

export function formatSessionForLlmAnalysis(
  analysis: CostAnalysis,
  options: SessionAnalysisExportOptions = {},
): string {
  const facts = buildSessionAnalysisFacts(analysis, options);
  return [
    "# AGENTVIZ session analysis package",
    "",
    "Analyze the measured workflow below. Separate facts from estimates, preserve the output-token accounting invariant, and prioritize actionable cost, cache, context, tool, and workflow findings. Do not present subagent estimates as measured usage.",
    "",
    "## Structured facts",
    "```json",
    JSON.stringify(facts, null, 2),
    "```",
    "",
    "---",
    "Generated deterministically by AGENTVIZ. No model inference was used to create this package.",
  ].join("\n");
}
