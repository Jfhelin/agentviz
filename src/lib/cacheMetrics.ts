export function computeEffectiveInputTokens(inputTokens: number, cacheReadTokens: number): number {
  return Math.max(inputTokens - cacheReadTokens, 0);
}

export function computeCacheHitRateDenomTokens(
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
