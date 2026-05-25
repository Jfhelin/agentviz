import type { TokenUsage } from "./sessionTypes";

export function hasModelPricing(modelName: string | null | undefined): boolean;
export function estimateCost(tokenUsage: TokenUsage | null | undefined, modelName?: string | null): number;
export function estimateMultiModelCost(modelTokenMap: Record<string, TokenUsage> | null | undefined): number;
export function formatCost(usd: number): string;
export function isPremiumRequestUnit(unit: string | null | undefined): boolean;
export function formatPremiumRequests(value: number | null | undefined): string;
export function formatCostValue(value: number, unit?: string | null): string;
export function formatSessionCost(metadata: { totalCost?: number | null; totalCostUnit?: string | null } | null | undefined): string | null;
export function getSessionCostLabel(metadata: { totalCost?: number | null; totalCostUnit?: string | null } | null | undefined, estimated?: boolean): string;
