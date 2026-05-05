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
