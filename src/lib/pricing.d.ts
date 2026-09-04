export interface TokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheRead?: number;
  cacheWrite?: number;
  cacheHitRate?: number;
}

export const PRICING_LAST_VERIFIED: string;

export interface ModelPrice {
  match?: string;
  input: number;
  output: number;
  cacheReadRatio?: number;
  cacheWriteRatio?: number;
  threshold?: number;
  longContext?: {
    input: number;
    output: number;
  };
}

export function hasModelPricing(modelName: string | null | undefined): boolean;
export function getModelPrice(
  modelName: string | null | undefined,
  tokenUsage?: TokenUsage | null,
): ModelPrice | null;
export function estimateCost(tokenUsage: TokenUsage | null | undefined, modelName: string | null | undefined): number;
export function estimateMultiModelCost(modelTokenMap: Record<string, TokenUsage> | null | undefined): number;
export function formatCost(usd: number): string;
