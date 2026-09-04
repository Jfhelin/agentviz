/**
 * GitHub Copilot model pricing table and cost estimation.
 *
 * Prices are per million tokens (USD).
 * GitHub publishes these token rates for Copilot AI credits; 1 credit = $0.01.
 *
 * Last verified: September 2026 against:
 *   - https://docs.github.com/en/copilot/reference/copilot-billing/models-and-pricing
 *
 * Note: more-specific match strings must come BEFORE less-specific ones because
 * lookupPrice() returns the first substring match.
 */

export var PRICING_LAST_VERIFIED = "2026-09";

var PRICE_TABLE = [
  // Anthropic. Keep specific entries before family matches.
  { match: "claude-fable-5-1", input: 10.00, output: 50.00, cacheReadRatio: 0.025, cacheWriteRatio: 1.25 },
  { match: "claude-fable-5",   input: 10.00, output: 50.00, cacheReadRatio: 0.1,   cacheWriteRatio: 1.25 },
  { match: "claude-opus-5",    input:  5.00, output: 25.00 },
  { match: "claude-sonnet-5",  input:  2.00, output: 10.00 },
  { match: "claude-opus-4-8",  input:  5.00, output: 25.00 },
  { match: "claude-opus-4-7",   input:  5.00, output: 25.00 },
  { match: "claude-opus-4",     input:  5.00, output: 25.00 },
  { match: "claude-sonnet-4",   input:  3.00, output: 15.00 },
  { match: "claude-haiku-4",    input:  1.00, output:  5.00 },
  { match: "claude-4",          input:  3.00, output: 15.00 },
  // Claude 3.5 family
  { match: "claude-3-5-sonnet", input:  3.00, output: 15.00 },
  { match: "claude-3-5-haiku",  input:  0.80, output:  4.00 },
  // Claude 3 family
  { match: "claude-3-opus",     input: 15.00, output: 75.00 },
  { match: "claude-3-sonnet",   input:  3.00, output: 15.00 },
  { match: "claude-3-haiku",    input:  0.25, output:  1.25 },
  // OpenAI. A cache write is only billed for the GPT-5.6 models.
  { match: "gpt-5-6-luna", input: 0.20, output: 1.20, cacheReadRatio: 0.1, cacheWriteRatio: 1.25, threshold: 200000, longContext: { input: 0.40, output: 1.80 } },
  { match: "gpt-5-6-sol", input: 4.00, output: 20.00, cacheReadRatio: 0.1, cacheWriteRatio: 1.25, threshold: 272000, longContext: { input: 8.00, output: 30.00 } },
  { match: "gpt-5-6-terra", input: 2.00, output: 12.00, cacheReadRatio: 0.1, cacheWriteRatio: 1.25, threshold: 272000, longContext: { input: 4.00, output: 18.00 } },
  { match: "gpt-5-5", input: 5.00, output: 30.00, cacheReadRatio: 0.1, cacheWriteRatio: 0, threshold: 272000, longContext: { input: 10.00, output: 45.00 } },
  { match: "gpt-5-4-mini", input: 0.75, output: 4.50, cacheReadRatio: 0.1, cacheWriteRatio: 0 },
  { match: "gpt-5-4-nano", input: 0.20, output: 1.25, cacheReadRatio: 0.1, cacheWriteRatio: 0 },
  { match: "gpt-5-4", input: 2.50, output: 15.00, cacheReadRatio: 0.1, cacheWriteRatio: 0, threshold: 272000, longContext: { input: 5.00, output: 22.50 } },
  { match: "gpt-5-3-codex", input: 1.75, output: 14.00, cacheReadRatio: 0.1, cacheWriteRatio: 0 },
  { match: "gpt-5-mini", input: 0.25, output: 2.00, cacheReadRatio: 0.1, cacheWriteRatio: 0 },
  // GPT-4 family retained for historical session exports.
  { match: "gpt-4.1", input: 2.00, output: 8.00, cacheReadRatio: 0.25, cacheWriteRatio: 0 },
  { match: "gpt-4o-mini", input: 0.15, output: 0.60, cacheReadRatio: 0.5, cacheWriteRatio: 0 },
  { match: "gpt-4o", input: 2.50, output: 10.00, cacheReadRatio: 0.5, cacheWriteRatio: 0 },
  // Google, Microsoft, xAI, Moonshot, and GitHub models available in VS Code.
  { match: "gemini-3-8-flash", input: 0.75, output: 3.75, cacheReadRatio: 0.1, cacheWriteRatio: 0 },
  { match: "gemini-3-7-flash", input: 0.75, output: 3.75, cacheReadRatio: 0.1, cacheWriteRatio: 0 },
  { match: "gemini-3-6-flash", input: 0.75, output: 3.75, cacheReadRatio: 0.1, cacheWriteRatio: 0 },
  { match: "gemini-3-5-flash", input: 1.50, output: 9.00, cacheReadRatio: 0.1, cacheWriteRatio: 0 },
  { match: "gemini-3-1-pro", input: 2.00, output: 12.00, cacheReadRatio: 0.1, cacheWriteRatio: 0, threshold: 200000, longContext: { input: 4.00, output: 18.00 } },
  { match: "mai-code-1-1-flash", input: 0.20, output: 1.20, cacheReadRatio: 0.1, cacheWriteRatio: 0 },
  { match: "mai-code-1-flash", input: 0.75, output: 4.50, cacheReadRatio: 0.1, cacheWriteRatio: 0 },
  { match: "grok-4-6", input: 2.00, output: 6.00, cacheReadRatio: 0.25, cacheWriteRatio: 0, threshold: 200000, longContext: { input: 4.00, output: 12.00 } },
  { match: "grok-4-5", input: 2.00, output: 6.00, cacheReadRatio: 0.25, cacheWriteRatio: 0, threshold: 200000, longContext: { input: 4.00, output: 12.00 } },
  { match: "kimi-k2-7-code", input: 0.95, output: 4.00, cacheReadRatio: 0.2, cacheWriteRatio: 0 },
  { match: "kimi-k3", input: 3.00, output: 15.00, cacheReadRatio: 0.1, cacheWriteRatio: 0 },
  { match: "raptor-mini", input: 0.25, output: 2.00, cacheReadRatio: 0.1, cacheWriteRatio: 0 },
];

// Default cache ratios: Anthropic-style (cache read = 10% of input, cache write = 125%).
// Override per-model entry above when the provider differs (e.g. OpenAI).
var DEFAULT_CACHE_READ_RATIO  = 0.1;
var DEFAULT_CACHE_WRITE_RATIO = 1.25;

// Fallback for unrecognized Claude model variants (new releases, etc.)
var DEFAULT_CLAUDE_PRICE = { input: 3.00, output: 15.00 };

function lookupPrice(modelName, tokenUsage) {
  if (!modelName) return null;
  var lower = modelName.toLowerCase().replace(/[._\s]+/g, "-");
  for (var i = 0; i < PRICE_TABLE.length; i++) {
    var price = PRICE_TABLE[i];
    var contextTokens = tokenUsage
      ? (tokenUsage.inputTokens || 0) + (tokenUsage.cacheRead || 0) + (tokenUsage.cacheWrite || 0)
      : 0;
    if (lower.includes(price.match)) {
      return price.longContext && contextTokens > price.threshold
        ? { ...price, ...price.longContext }
        : price;
    }
  }
  // Apply Claude default only to Claude variants we haven't explicitly listed.
  // For GPT, Gemini, or other unknown models we return null -- cost unknown.
  if (lower.includes("claude")) return DEFAULT_CLAUDE_PRICE;
  return null;
}

/** Returns true when we have pricing data for the given model name. */
export function hasModelPricing(modelName) {
  return lookupPrice(modelName) !== null;
}

/** Returns the raw price row for a model (or null). Useful for callers that
 * need the per-input rate to estimate ad-hoc costs (e.g. image attachments
 * billed at standard input rate but counted outside `tokenUsage`). */
export function getModelPrice(modelName, tokenUsage) {
  return lookupPrice(modelName, tokenUsage);
}

/**
 * Estimate cost in USD for a tokenUsage object.
 * tokenUsage: { inputTokens, outputTokens, cacheRead, cacheWrite }
 * modelName: string (optional, used to look up pricing)
 */
export function estimateCost(tokenUsage, modelName) {
  if (!tokenUsage) return 0;
  var price = lookupPrice(modelName, tokenUsage);
  if (!price) return 0; // unknown model -- don't fabricate a number
  var cacheReadRatio  = price.cacheReadRatio  != null ? price.cacheReadRatio  : DEFAULT_CACHE_READ_RATIO;
  var cacheWriteRatio = price.cacheWriteRatio != null ? price.cacheWriteRatio : DEFAULT_CACHE_WRITE_RATIO;
  var inputCost  = (tokenUsage.inputTokens  || 0) / 1e6 * price.input;
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
