export interface TokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheRead?: number;
  cacheWrite?: number;
  cacheHitRate?: number;
}

export function hasModelPricing(modelName: string | null | undefined): boolean;
export function estimateCost(tokenUsage: TokenUsage | null | undefined, modelName: string | null | undefined): number;
export function estimateMultiModelCost(modelTokenMap: Record<string, TokenUsage> | null | undefined): number;
export function formatCost(usd: number): string;
