// Per-image token cost estimates for vision-capable models.
//
// The Copilot Chat export carries `imageUrl: { url, mediaType, detail }`
// only -- no byte size, no dimensions, no per-call token usage. So the
// cost we charge for an image is unknowable exactly, but we can give a
// useful documented estimate from the model + `detail` field alone.
//
// These constants come from each vendor's documented vision pricing model:
//
//   * Anthropic Claude (claude-*-vision capable models):
//       low detail  -> ~258 tok flat
//       high detail -> images are scaled so the longest edge is at most
//                      1568 px and tokens = (w * h) / 750 rounded up.
//                      For a typical landscape 1568 x 1176 image that
//                      works out to ~2459 tok; we use ~1600 tok as a
//                      conservative middle estimate (matches Anthropic
//                      docs' "≤1.6k tokens per typical image" guidance).
//
//   * OpenAI GPT-4o family:
//       low detail  -> 85 tok flat
//       high detail -> 85 base + 170 per 512x512 tile after the image is
//                      resized to fit within 2048x2048 (long side ≤768).
//                      A typical 1024x1024 high-detail image yields
//                      85 + 4 * 170 = 765 tok. We use 765.
//
// All numbers labelled clearly as estimates in the UI. If a future export
// format starts carrying real image token counts, swap in those instead.

function pickFamily(model) {
  if (!model) return null;
  var m = model.toLowerCase();
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
  var d = (detail || "high").toLowerCase();
  if (fam === "claude") return d === "low" ? 258 : 1600;
  if (fam === "gpt4o") return d === "low" ? 85 : 765;
  // Unknown family: be silent rather than guess wildly.
  return 0;
}

/**
 * Estimate the input cost ($) for a single image, given the model's input
 * rate. We bill at standard input rate (no cache discount) because the
 * image bytes are re-uploaded each call -- they aren't part of Anthropic's
 * prompt-cache window.
 *
 * @param {object} priceRow - { input: $/1M tokens } from pricing.js
 * @param {number} tokens - estimated tokens (from estimateImageTokens)
 * @returns {number} dollars
 */
export function imageDollarCost(priceRow, tokens) {
  if (!priceRow || !priceRow.input || !tokens) return 0;
  return (tokens / 1e6) * priceRow.input;
}
