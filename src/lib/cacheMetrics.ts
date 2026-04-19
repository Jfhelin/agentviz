import type { TokenUsage } from "./sessionTypes";

export function computeEffectiveInputTokens(inputTokens: number, cacheReadTokens: number): number {
  return Math.max(inputTokens - cacheReadTokens, 0);
}

function computeCacheHitRateDenomTokens(
  inputTokens: number,
  cacheWriteTokens: number,
  cacheReadTokens: number,
): number {
  var effectiveInput = computeEffectiveInputTokens(inputTokens, cacheReadTokens);
  return effectiveInput + Math.max(cacheWriteTokens, 0) + Math.max(cacheReadTokens, 0);
}

export function computeCacheHitRate(
  inputTokens: number,
  cacheWriteTokens: number,
  cacheReadTokens: number,
): number | undefined {
  var denom = computeCacheHitRateDenomTokens(inputTokens, cacheWriteTokens, cacheReadTokens);
  if (denom <= 0) return undefined;
  return Math.max(cacheReadTokens, 0) / denom;
}

export function summarizeTokenUsage(usages: Array<TokenUsage | null | undefined>): TokenUsage | null {
  var summary = { inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0 };
  var hasUsage = false;

  for (var i = 0; i < usages.length; i += 1) {
    var usage = usages[i];
    if (!usage) continue;
    hasUsage = true;
    summary.inputTokens += usage.inputTokens || 0;
    summary.outputTokens += usage.outputTokens || 0;
    summary.cacheRead += usage.cacheRead || 0;
    summary.cacheWrite += usage.cacheWrite || 0;
  }

  if (!hasUsage) return null;

  return {
    inputTokens: summary.inputTokens,
    outputTokens: summary.outputTokens,
    cacheRead: summary.cacheRead,
    cacheWrite: summary.cacheWrite,
    cacheHitRate: computeCacheHitRate(summary.inputTokens, summary.cacheWrite, summary.cacheRead),
  };
}

export function formatCacheUsageSummary(
  usage: TokenUsage | null | undefined,
  options?: { variant?: "compact" | "verbose" },
): string | null {
  if (!usage) return null;

  var cacheRead = usage.cacheRead || 0;
  if (cacheRead <= 0) return null;

  var cacheWrite = usage.cacheWrite || 0;
  var cacheHitRate = usage.cacheHitRate != null
    ? usage.cacheHitRate
    : computeCacheHitRate(usage.inputTokens || 0, cacheWrite, cacheRead);
  var parts = [cacheRead.toLocaleString() + " cache read"];

  if (cacheWrite > 0) {
    parts.push(cacheWrite.toLocaleString() + " cache write");
  }

  if (cacheHitRate != null) {
    parts.push(
      options && options.variant === "compact"
        ? (cacheHitRate * 100).toFixed(1) + "% hit"
        : "cache hit rate " + (cacheHitRate * 100).toFixed(1) + "%",
    );
  }

  return parts.join(" / ");
}
