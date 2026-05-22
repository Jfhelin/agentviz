/**
 * Per-image token cost estimates for vision-capable models.
 *
 * The Copilot Chat export carries image attachment metadata only --
 * no byte size, no dimensions, no per-call token usage. So the cost we
 * charge for an image is unknowable exactly, but we can give a useful
 * documented estimate from the model + `detail` field alone.
 *
 *   Anthropic Claude (vision-capable models):
 *     low detail  -> ~258 tok flat
 *     high detail -> ~1600 tok per typical image (per Anthropic docs)
 *
 *   OpenAI GPT-4o / GPT-4.1 family:
 *     low detail  -> 85 tok flat
 *     high detail -> ~765 tok per typical 1024x1024 image (base + 4 tiles)
 *
 * All numbers are clearly labelled as estimates in the UI. If a future
 * export format starts carrying real image token counts, swap in those
 * instead.
 */

function pickFamily(model) {
  if (!model) return null;
  var m = String(model).toLowerCase();
  if (m.indexOf("claude") !== -1) return "claude";
  if (m.indexOf("gpt-4o") !== -1 || m.indexOf("gpt-4.1") !== -1) return "gpt4o";
  return null;
}

/**
 * Estimate input tokens for a single image attachment.
 *
 * @param {string} model - model name (e.g. "claude-sonnet-4.6", "gpt-4o")
 * @param {string} detail - "low" | "high" | "" (defaults to "high")
 * @returns {number} estimated input tokens (0 if model/family unknown)
 */
export function estimateImageTokens(model, detail) {
  var fam = pickFamily(model);
  var d = String(detail || "high").toLowerCase();
  if (fam === "claude") return d === "low" ? 258 : 1600;
  if (fam === "gpt4o") return d === "low" ? 85 : 765;
  return 0;
}

/**
 * Estimate the input cost (USD) for a single image, given the model's input
 * rate. We bill at standard input rate because the image bytes are
 * re-uploaded each call and are not part of any prompt-cache window.
 *
 * @param {{input?: number} | null | undefined} priceRow - price row from pricing.js
 * @param {number} tokens - estimated tokens (from estimateImageTokens)
 * @returns {number} dollars
 */
export function imageDollarCost(priceRow, tokens) {
  if (!priceRow || !priceRow.input || !tokens) return 0;
  return (tokens / 1e6) * priceRow.input;
}
