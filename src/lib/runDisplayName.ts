// Convert a session file name into a short, human-friendly display label.
//
// Strips known noise prefixes from Copilot Chat exports
// ("copilot_all_prompts_") and known extensions, leaves anything meaningful.
// If only an ISO-ish timestamp remains, it is reformatted as "YYYY-MM-DD HH:MM".
//
// Examples:
//   copilot_all_prompts_caveman.json                  -> "caveman"
//   copilot_all_prompts_polite.json                   -> "polite"
//   copilot_all_prompts_2026-04-29T14-41-16.json      -> "2026-04-29 14:41"
//   session-3a8c9d1.jsonl                             -> "session-3a8c9d1"
//   /path/to/copilot_all_prompts_caveman.json         -> "caveman"
//   ""                                                -> "session"
export function prettifyRunName(name: string | null | undefined): string {
  if (!name) return "session";

  // Strip path
  const base = String(name).split(/[\\/]/).pop() || "";

  // Strip known extensions (longest first)
  let stem = base;
  for (const ext of [".json", ".jsonl", ".txt", ".log"]) {
    if (stem.toLowerCase().endsWith(ext)) {
      stem = stem.slice(0, -ext.length);
      break;
    }
  }

  // Strip known Copilot Chat export prefixes
  const PREFIXES = [
    "copilot_all_prompts_",
    "copilot-all-prompts-",
    "copilot_chat_export_",
    "copilot-chat-export-",
  ];
  for (const p of PREFIXES) {
    if (stem.toLowerCase().startsWith(p)) {
      stem = stem.slice(p.length);
      break;
    }
  }

  // If what remains looks like an ISO-ish timestamp, reformat it.
  // Matches "2026-04-29T14-41-16" or "2026-04-29T14:41:16".
  const tsMatch = stem.match(/^(\d{4}-\d{2}-\d{2})[T_-](\d{2})[-:](\d{2})(?:[-:](\d{2}))?$/);
  if (tsMatch) {
    return `${tsMatch[1]} ${tsMatch[2]}:${tsMatch[3]}`;
  }

  // Trim trailing/leading separators left over from prefix stripping
  stem = stem.replace(/^[-_.\s]+|[-_.\s]+$/g, "");

  return stem || "session";
}

// ---------------------------------------------------------------------------
// Hypothesis inference from run names
// ---------------------------------------------------------------------------
//
// When two runs have structured names like:
//   "munich3-baseline"     vs "munich3-no-tools"
//   "claude-sonnet-run"    vs "claude-haiku-run"
//   "before-fix-2026-04-29" vs "after-fix-2026-04-30"
// we can extract the shared scenario and the differing axis so the LLM
// analyst can frame the comparison as "A=baseline, B=no-tools (same
// scenario: munich3)" instead of just "A vs B".

export interface NameHypothesis {
  /** The cleaned display label for A (prettifyRunName output). */
  nameA: string;
  /** The cleaned display label for B. */
  nameB: string;
  /** Shared prefix tokens joined back with the original separator,
   * if the names share a meaningful prefix and a meaningful tail
   * remains for each side. Otherwise null. */
  sharedContext: string | null;
  /** The part of nameA that differs from nameB (after stripping the
   * shared prefix/suffix). Null if no useful diff can be extracted. */
  variantA: string | null;
  /** The part of nameB that differs from nameA. */
  variantB: string | null;
  /** A short hypothesis string the analyst can use as framing.
   * Examples:
   *   "A=baseline vs B=no-tools (shared scenario: munich3)"
   *   "A=claude-sonnet vs B=claude-haiku"
   *   null if the names look like raw timestamps / hashes with no signal.
   */
  hypothesis: string | null;
}

// Tokens that, by themselves, carry no hypothesis signal. We do not let
// the hypothesis be these alone.
const NOISE_TOKENS = new Set([
  "run", "test", "v1", "v2", "v3", "1", "2", "3", "a", "b", "x", "y",
  "session", "export", "copilot", "chat",
]);

// Token shapes we treat as noise (timestamps, dates, hashes).
function isNoiseToken(tok: string): boolean {
  if (!tok) return true;
  if (NOISE_TOKENS.has(tok.toLowerCase())) return true;
  // Pure digits.
  if (/^\d+$/.test(tok)) return true;
  // Date-like: 2026-04-29 or 20260429 or 2026.
  if (/^\d{4}$/.test(tok)) return true;
  if (/^\d{4}-\d{2}-\d{2}$/.test(tok)) return true;
  if (/^\d{4}\d{2}\d{2}$/.test(tok)) return true;
  // Time-like: 14:41 or 1441.
  if (/^\d{2}[-:]\d{2}([-:]\d{2})?$/.test(tok)) return true;
  // Short hex / hash tail.
  if (/^[0-9a-f]{6,12}$/i.test(tok) && /[a-f]/i.test(tok)) return true;
  return false;
}

// Split on -, _, ., space. Keep tokens in order.
function tokenize(s: string): string[] {
  return s.split(/[-_.\s]+/).filter(Boolean);
}

function joinTokens(tokens: string[]): string {
  return tokens.join("-");
}

function stripNoiseTail(tokens: string[]): string[] {
  let out = tokens.slice();
  while (out.length > 0 && isNoiseToken(out[out.length - 1])) {
    out.pop();
  }
  return out;
}

function stripNoiseHead(tokens: string[]): string[] {
  let out = tokens.slice();
  while (out.length > 0 && isNoiseToken(out[0])) {
    out.shift();
  }
  return out;
}

export function inferTechniqueFromRunNames(
  rawA: string | null | undefined,
  rawB: string | null | undefined,
): NameHypothesis {
  const nameA = prettifyRunName(rawA);
  const nameB = prettifyRunName(rawB);

  const tokA = tokenize(nameA);
  const tokB = tokenize(nameB);

  // Longest common prefix and suffix at the token level.
  let prefixLen = 0;
  while (
    prefixLen < tokA.length &&
    prefixLen < tokB.length &&
    tokA[prefixLen].toLowerCase() === tokB[prefixLen].toLowerCase()
  ) {
    prefixLen++;
  }
  let suffixLen = 0;
  while (
    suffixLen < tokA.length - prefixLen &&
    suffixLen < tokB.length - prefixLen &&
    tokA[tokA.length - 1 - suffixLen].toLowerCase() ===
      tokB[tokB.length - 1 - suffixLen].toLowerCase()
  ) {
    suffixLen++;
  }

  const sharedPrefix = tokA.slice(0, prefixLen);
  const sharedSuffix = suffixLen > 0 ? tokA.slice(tokA.length - suffixLen) : [];
  const middleA = tokA.slice(prefixLen, tokA.length - suffixLen);
  const middleB = tokB.slice(prefixLen, tokB.length - suffixLen);

  // Clean the shared context by trimming noise on both ends.
  const sharedAll = sharedPrefix.concat(sharedSuffix);
  const sharedSignal = stripNoiseHead(stripNoiseTail(sharedAll));
  const sharedContext = sharedSignal.length > 0
    ? joinTokens(sharedSignal)
    : null;

  // Clean the variant parts.
  const variantATokens = stripNoiseTail(stripNoiseHead(middleA));
  const variantBTokens = stripNoiseTail(stripNoiseHead(middleB));
  const variantA = variantATokens.length > 0 ? joinTokens(variantATokens) : null;
  const variantB = variantBTokens.length > 0 ? joinTokens(variantBTokens) : null;

  // Build hypothesis only if both sides have a non-noise variant.
  let hypothesis: string | null = null;
  if (variantA && variantB && variantA.toLowerCase() !== variantB.toLowerCase()) {
    const ctxSuffix = sharedContext ? ` (shared scenario: ${sharedContext})` : "";
    hypothesis = `A=${variantA} vs B=${variantB}${ctxSuffix}`;
  } else if (
    // Neither side has a shared context to subtract -- but the two full names
    // are different non-noise strings. Use the full names as the hypothesis.
    !sharedContext &&
    nameA.toLowerCase() !== nameB.toLowerCase() &&
    !isNoiseToken(nameA) &&
    !isNoiseToken(nameB) &&
    // And at least one side is not a pure timestamp display.
    !(/^\d{4}-\d{2}-\d{2}/.test(nameA) && /^\d{4}-\d{2}-\d{2}/.test(nameB))
  ) {
    hypothesis = `A=${nameA} vs B=${nameB}`;
  }

  return {
    nameA,
    nameB,
    sharedContext,
    variantA,
    variantB,
    hypothesis,
  };
}
