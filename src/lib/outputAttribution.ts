export interface OutputAttributionInput {
  totalTokens: number;
  reportedReasoningTokens?: number;
  visibleChars?: number;
  thinkingChars?: number;
  toolArgumentChars?: number;
}

export interface OutputAttribution {
  visible: number;
  reasoning: number;
  toolArguments: number;
  unattributed: number;
  reasoningSource: "reported" | "estimated" | "mixed" | "none";
}

type WeightedBucket = "visible" | "reasoning" | "toolArguments";

function allocateByWeight(
  total: number,
  weights: Record<WeightedBucket, number>,
): Record<WeightedBucket, number> {
  const keys: WeightedBucket[] = ["visible", "reasoning", "toolArguments"];
  const weightTotal = keys.reduce((sum, key) => sum + Math.max(0, weights[key]), 0);
  const result: Record<WeightedBucket, number> = {
    visible: 0,
    reasoning: 0,
    toolArguments: 0,
  };
  if (total <= 0 || weightTotal <= 0) return result;

  const ranked = keys.map((key, index) => {
    const exact = total * Math.max(0, weights[key]) / weightTotal;
    const floor = Math.floor(exact);
    result[key] = floor;
    return { key, index, remainder: exact - floor };
  }).sort((a, b) => b.remainder - a.remainder || a.index - b.index);

  let remaining = total - keys.reduce((sum, key) => sum + result[key], 0);
  for (let i = 0; remaining > 0; i += 1, remaining -= 1) {
    result[ranked[i % ranked.length].key] += 1;
  }
  return result;
}

export function attributeOutputTokens(input: OutputAttributionInput): OutputAttribution {
  const totalTokens = Math.max(0, Math.round(input.totalTokens || 0));
  const visibleChars = Math.max(0, input.visibleChars || 0);
  const thinkingChars = Math.max(0, input.thinkingChars || 0);
  const toolArgumentChars = Math.max(0, input.toolArgumentChars || 0);
  const reportedReasoning = Math.min(
    totalTokens,
    Math.max(0, Math.round(input.reportedReasoningTokens || 0)),
  );

  if (totalTokens === 0) {
    return { visible: 0, reasoning: 0, toolArguments: 0, unattributed: 0, reasoningSource: "none" };
  }

  if (reportedReasoning > 0) {
    const remainder = totalTokens - reportedReasoning;
    const allocated = allocateByWeight(remainder, {
      visible: visibleChars,
      reasoning: 0,
      toolArguments: toolArgumentChars,
    });
    const attributed = reportedReasoning + allocated.visible + allocated.toolArguments;
    return {
      visible: allocated.visible,
      reasoning: reportedReasoning,
      toolArguments: allocated.toolArguments,
      unattributed: totalTokens - attributed,
      reasoningSource: "reported",
    };
  }

  const allocated = allocateByWeight(totalTokens, {
    visible: visibleChars,
    reasoning: thinkingChars,
    toolArguments: toolArgumentChars,
  });
  const attributed = allocated.visible + allocated.reasoning + allocated.toolArguments;
  return {
    ...allocated,
    unattributed: totalTokens - attributed,
    reasoningSource: thinkingChars > 0 ? "estimated" : "none",
  };
}
