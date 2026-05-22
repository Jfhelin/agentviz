/**
 * Model pricing table and cost estimation.
 *
 * Prices are per million tokens (USD). Anthropic models default to cache read
 * at 10% of input and cache write at 125% of input. OpenAI / Copilot models
 * have a different cache policy (no write premium, cache read between 25% and
 * 50% of input depending on family) and carry explicit `cacheReadRatio` /
 * `cacheWriteRatio` overrides on their rows.
 *
 * Last verified: May 2026 against vendor public pricing pages. More-specific
 * matchers must come before less-specific ones because `lookupPrice()` returns
 * the first substring match.
 */

var PRICE_TABLE = [
  // Claude 4 family. Opus 4.7 (May 2026) is significantly cheaper than older
  // Opus 4.x; keep the specific entry first so it wins the substring scan.
  { match: "claude-opus-4.7",   input:  5.00, output: 25.00 },
  { match: "claude-opus-4",     input: 15.00, output: 75.00 },
  { match: "claude-sonnet-4",   input:  3.00, output: 15.00 },
  // Claude Haiku 4.x. May 2026 raw rate (Haiku 4.5).
  { match: "claude-haiku-4",    input:  1.00, output:  5.00 },
  // Claude 3.5 family
  { match: "claude-3-5-sonnet", input:  3.00, output: 15.00 },
  { match: "claude-3-5-haiku",  input:  0.80, output:  4.00 },
  // OpenAI / Copilot models. Cache read between 25% and 50% of input, cache
  // write equals input (no premium, unlike Anthropic).
  { match: "gpt-5-mini",        input:  0.25, output:  2.00, cacheReadRatio: 0.1,  cacheWriteRatio: 1.0 },
  { match: "gpt-5.5",           input:  1.25, output: 10.00, cacheReadRatio: 0.1,  cacheWriteRatio: 1.0 },
  { match: "gpt-5.4",           input:  1.25, output: 10.00, cacheReadRatio: 0.1,  cacheWriteRatio: 1.0 },
  { match: "gpt-5.3",           input:  1.25, output: 10.00, cacheReadRatio: 0.1,  cacheWriteRatio: 1.0 },
  { match: "gpt-5.2",           input:  1.25, output: 10.00, cacheReadRatio: 0.1,  cacheWriteRatio: 1.0 },
  { match: "gpt-5",             input:  1.25, output: 10.00, cacheReadRatio: 0.1,  cacheWriteRatio: 1.0 },
  { match: "gpt-4.1",           input:  2.00, output:  8.00, cacheReadRatio: 0.25, cacheWriteRatio: 1.0 },
  { match: "gpt-4o-mini",       input:  0.15, output:  0.60, cacheReadRatio: 0.5,  cacheWriteRatio: 1.0 },
  { match: "gpt-4o",            input:  2.50, output: 10.00, cacheReadRatio: 0.5,  cacheWriteRatio: 1.0 },
  { match: "o4-mini",           input:  1.10, output:  4.40, cacheReadRatio: 0.25, cacheWriteRatio: 1.0 },
  { match: "o3-mini",           input:  1.10, output:  4.40, cacheReadRatio: 0.25, cacheWriteRatio: 1.0 },
  { match: "o3",                input: 10.00, output: 40.00, cacheReadRatio: 0.25, cacheWriteRatio: 1.0 },
  // Claude 3 family
  { match: "claude-3-opus",     input: 15.00, output: 75.00 },
  { match: "claude-3-sonnet",   input:  3.00, output: 15.00 },
  { match: "claude-3-haiku",    input:  0.25, output:  1.25 },
];

// Default cache ratios when a price row doesn't override them. Anthropic
// pricing model: cache read is 10% of input, cache write is 125% of input.
var DEFAULT_CACHE_READ_RATIO  = 0.1;
var DEFAULT_CACHE_WRITE_RATIO = 1.25;

// Fallback for unrecognized Claude model variants (new releases, etc.)
var DEFAULT_CLAUDE_PRICE = { input: 3.00, output: 15.00 };

function normalizeModelName(modelName) {
  return String(modelName).toLowerCase().replace(/[^a-z0-9.]+/g, "-");
}

function lookupPrice(modelName) {
  if (!modelName) return null;
  var lower = normalizeModelName(modelName);
  for (var i = 0; i < PRICE_TABLE.length; i++) {
    if (lower.includes(PRICE_TABLE[i].match)) return PRICE_TABLE[i];
  }
  // Apply Claude default only to Claude variants we haven't explicitly listed.
  // For Gemini or other unknown models we return null -- cost unknown.
  if (lower.includes("claude")) return DEFAULT_CLAUDE_PRICE;
  return null;
}

/** Returns true when we have pricing data for the given model name. */
export function hasModelPricing(modelName) {
  return lookupPrice(modelName) !== null;
}

/**
 * Returns the raw price row for a model (or null when unknown). Useful for
 * callers that need the per-input rate to estimate ad-hoc costs, for example
 * image attachments that are billed at the standard input rate but tracked
 * outside the regular `tokenUsage` flow.
 */
export function getModelPrice(modelName) {
  return lookupPrice(modelName);
}

/**
 * Estimate cost in USD for a tokenUsage object.
 * tokenUsage: { inputTokens, outputTokens, cacheRead, cacheWrite }
 * modelName: string (optional, used to look up pricing)
 *
 * Cache ratios come from the matched price row when present, otherwise from
 * the Anthropic-style defaults (0.1 / 1.25).
 */
export function estimateCost(tokenUsage, modelName) {
  if (!tokenUsage) return 0;
  var price = lookupPrice(modelName);
  if (!price) return 0; // unknown model -- don't fabricate a number
  var cacheReadRatio  = price.cacheReadRatio  != null ? price.cacheReadRatio  : DEFAULT_CACHE_READ_RATIO;
  var cacheWriteRatio = price.cacheWriteRatio != null ? price.cacheWriteRatio : DEFAULT_CACHE_WRITE_RATIO;
  var freshInputTokens = Math.max((tokenUsage.inputTokens || 0) - (tokenUsage.cacheRead || 0), 0);
  var inputCost  = freshInputTokens / 1e6 * price.input;
  var outputCost = (tokenUsage.outputTokens || 0) / 1e6 * price.output;
  var cacheReadCost  = (tokenUsage.cacheRead  || 0) / 1e6 * price.input * cacheReadRatio;
  var cacheWriteCost = (tokenUsage.cacheWrite || 0) / 1e6 * price.input * cacheWriteRatio;
  return inputCost + outputCost + cacheReadCost + cacheWriteCost;
}

/**
 * Estimate cost across multiple models by pricing each model's tokens at its own rate.
 * modelTokenMap: { [modelName]: { inputTokens, outputTokens, cacheRead, cacheWrite } }
 * Returns 0 if no models have recognized pricing.
 */
export function estimateMultiModelCost(modelTokenMap) {
  if (!modelTokenMap) return 0;
  var total = 0;
  var keys = Object.keys(modelTokenMap);
  for (var i = 0; i < keys.length; i++) {
    total += estimateCost(modelTokenMap[keys[i]], keys[i]);
  }
  return total;
}

/**
 * Format a cost in USD for display.
 * < $0.01  -> "<$0.01"
 * < $1     -> "$0.XX"
 * >= $1    -> "$X.XX"
 */
export function formatCost(usd) {
  if (usd <= 0) return "$0.00";
  if (usd < 0.01) return "<$0.01";
  if (usd < 1) return "$" + usd.toFixed(3);
  return "$" + usd.toFixed(2);
}
