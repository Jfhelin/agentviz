/**
 * MCP server reachability analysis
 *
 * VS Code Copilot Chat exports include two pieces of MCP information that can
 * disagree:
 *
 *   1. `root.mcpServers` -- the list of MCP servers the IDE believed were
 *      configured at export time. Each entry has a label, type, and command.
 *
 *   2. `metadata.tools` on each chat request -- the tool definitions actually
 *      shipped to the model. MCP-backed tools follow the convention
 *      `mcp_<server_slug>_<tool_name>` where `<server_slug>` is a normalized
 *      form of the server label (lowercase, alphanumeric segments joined by
 *      underscores, often truncated to the first two non-noise tokens).
 *
 * When (1) lists 8 servers but (2) only ever ships tools from 3 of them, the
 * user is paying setup cost (process memory, startup time, IDE/UX complexity,
 * reconnect noise, occasional auth prompts) for 5 MCP servers the model never
 * sees. The existing "unused tools" finding can't surface this because there
 * are zero tools to mark as unused -- the entire server is invisible upstream.
 *
 * Matching is heuristic, not exact, because the Copilot Chat export does not
 * carry the server-to-tool mapping. We normalize each declared label to a
 * snake-case slug and look for any on-the-wire tool name whose `mcp_<slug>`
 * prefix is a prefix of the tool name. We try the most specific 3-token slug
 * first, then 2-token, then 1-token. The `confidence` field surfaces this so
 * downstream consumers don't overstate the finding.
 */

export interface DeclaredMcpServer {
  label: string;
  /** "stdio" | "http" | etc. -- preserved verbatim from the export. */
  type?: string;
  /** Top-level launch command (e.g. "npx", "docker"). May be absent for
   *  remote/http servers; preserved verbatim. */
  command?: string;
  /** Launch args array; preserved verbatim. */
  args?: unknown;
  /** Optional version string from the export. */
  version?: string;
}

export interface McpServerMatch {
  server: DeclaredMcpServer;
  /** The slug (without the leading `mcp_`) that we matched. */
  slug: string;
  /** Number of distinct on-the-wire tool names whose `mcp_<slug>_` prefix
   *  matched this server. */
  toolCount: number;
  /** Specificity of the matched slug. Higher = more specific. */
  slugTokenCount: number;
}

export interface ExtraInWire {
  /** The mcp_<a>[_<b>] slug observed in tool names but not matched to any
   *  declared server. May indicate a tool name slugged differently than the
   *  declared label or a server added after the export was taken. */
  slug: string;
  toolCount: number;
}

export type McpReachabilityConfidence = "heuristic" | "exact" | "no_servers_declared";

export interface McpReachabilityAnalysis {
  available: boolean;
  declaredCount: number;
  visibleCount: number;
  unusedCount: number;
  /** Total distinct `mcp_*` tool definitions observed across all chat
   *  requests (matched-server tools + extra-on-wire tools). Lets callers
   *  contrast "all model-visible tools" against just the MCP portion. */
  mcpToolCount: number;
  matches: McpServerMatch[];
  unused: DeclaredMcpServer[];
  extraInWire: ExtraInWire[];
  confidence: McpReachabilityConfidence;
  note: string;
}

const NOTE = [
  "MCP server reachability is computed by matching each listed server's normalized label slug",
  "against the `mcp_<slug>_*` prefix of every on-the-wire tool name across all chat requests.",
  "Servers with no matching tool produced no model-visible capabilities in this session.",
  "The export does not record whether such a server was disabled, failed to start, or simply",
  "had no tools the IDE chose to send -- treat the finding as a signal to investigate.",
  "Matching is heuristic because the Copilot Chat export does not carry the server-to-tool mapping.",
].join(" ");

// Tokens we drop only when they appear as the trailing token of a candidate
// slug. We do NOT drop `mcp` here because real on-the-wire slugs like
// `mcp_azure_mcp_*` (from the label "Azure MCP Server") preserve it.
const NOISE_TOKENS = new Set<string>([
  "server",
  "servers",
  "service",
]);

/** Normalize a declared MCP server label into a list of candidate slugs,
 *  most specific first. Each slug is lowercase snake_case, alphanumeric-only.
 *  Noise tokens like `mcp`, `server` are kept only when they're the first
 *  token (otherwise dropped), because most observed mcp_<slug>_ prefixes
 *  follow the form `<label_first_word>_<label_second_word>` for multi-word
 *  labels like "Azure MCP Server" → `azure_mcp`.
 */
export function normalizeServerSlug(label: string): string[] {
  if (!label) return [];
  // Split on any non-alphanumeric, lowercase.
  const tokens = label
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 0);
  if (tokens.length === 0) return [];

  // Keep the first token unconditionally; drop noise tokens after the first
  // only if they collide with mcp_ prefix conventions.
  const kept: string[] = [tokens[0]];
  for (let i = 1; i < tokens.length; i++) {
    const t = tokens[i];
    // Skip duplicates (e.g. "github.github" collapses).
    if (t === kept[kept.length - 1]) continue;
    kept.push(t);
  }

  // Produce candidates from most-specific to least-specific. Skip slugs that
  // end in a noise token to avoid `mcp_azure_mcp_server` style false negatives
  // (the on-the-wire slug is typically truncated before the noise token).
  const slugs: string[] = [];
  for (let take = Math.min(kept.length, 4); take >= 1; take--) {
    const candidate = kept.slice(0, take);
    if (candidate.length > 1 && NOISE_TOKENS.has(candidate[candidate.length - 1])) continue;
    const slug = candidate.join("_");
    if (!slugs.includes(slug)) slugs.push(slug);
  }
  return slugs;
}

/** Build the set of distinct `mcp_<a>_<b>` (3-token) and `mcp_<a>` (2-token)
 *  prefixes observed across all on-the-wire tool names, with their tool counts. */
export function collectMcpPrefixes(toolNames: Iterable<string>): Map<string, number> {
  const counts = new Map<string, number>();
  const seenNames = new Set<string>();
  for (const name of toolNames) {
    if (!name || !name.startsWith("mcp_")) continue;
    if (seenNames.has(name)) continue;
    seenNames.add(name);
    const parts = name.split("_");
    // parts[0] = "mcp", parts[1] = first slug token, parts[2] = second, ...
    for (let take = 1; take <= 3 && take + 1 <= parts.length; take++) {
      const slug = parts.slice(1, 1 + take).join("_");
      counts.set(slug, (counts.get(slug) ?? 0) + 1);
    }
  }
  return counts;
}

export function analyzeMcpReachability(
  declared: DeclaredMcpServer[],
  toolNames: Iterable<string>,
): McpReachabilityAnalysis {
  if (!declared || declared.length === 0) {
    // Even with no declared servers, the wire may carry mcp_* tools we should
    // count so callers can render a coherent "MCP visibility" story.
    let mcpToolCount = 0;
    for (const name of toolNames) {
      if (name && name.startsWith("mcp_")) mcpToolCount++;
    }
    return {
      available: false,
      declaredCount: 0,
      visibleCount: 0,
      unusedCount: 0,
      mcpToolCount,
      matches: [],
      unused: [],
      extraInWire: [],
      confidence: "no_servers_declared",
      note: "No `mcpServers` block was present in the export.",
    };
  }

  // For each tool name, also remember the full set of distinct names per
  // top-level prefix so we can report accurate toolCount per declared server
  // (the prefix-counts map double-counts each tool across 1/2/3-token slugs).
  const namesByTopPrefix = new Map<string, Set<string>>();
  const seenNamesAll = new Set<string>();
  for (const name of toolNames) {
    if (!name || !name.startsWith("mcp_")) continue;
    if (seenNamesAll.has(name)) continue;
    seenNamesAll.add(name);
    const parts = name.split("_");
    for (let take = 1; take <= 3 && take + 1 <= parts.length; take++) {
      const slug = parts.slice(1, 1 + take).join("_");
      let bucket = namesByTopPrefix.get(slug);
      if (!bucket) { bucket = new Set(); namesByTopPrefix.set(slug, bucket); }
      bucket.add(name);
    }
  }

  const matches: McpServerMatch[] = [];
  const unused: DeclaredMcpServer[] = [];
  const claimedTopPrefixes = new Set<string>();

  for (const server of declared) {
    const slugs = normalizeServerSlug(server.label);
    let chosen: McpServerMatch | null = null;
    for (const slug of slugs) {
      const bucket = namesByTopPrefix.get(slug);
      if (!bucket || bucket.size === 0) continue;
      chosen = {
        server,
        slug,
        toolCount: bucket.size,
        slugTokenCount: slug.split("_").length,
      };
      break;
    }
    if (chosen) {
      matches.push(chosen);
      // Mark the top-level (1-token) prefix as claimed so we don't report it
      // as "extra in wire" later.
      claimedTopPrefixes.add(chosen.slug.split("_")[0]);
    } else {
      unused.push(server);
    }
  }

  // Extra-in-wire: 1-token prefixes seen on the wire that no declared server
  // claimed. These often indicate a server added/renamed after the export was
  // captured, or a label-vs-slug mismatch worth investigating.
  const extraInWire: ExtraInWire[] = [];
  for (const [slug, names] of namesByTopPrefix.entries()) {
    if (slug.includes("_")) continue; // only report top-level prefixes
    if (claimedTopPrefixes.has(slug)) continue;
    extraInWire.push({ slug, toolCount: names.size });
  }
  extraInWire.sort((a, b) => b.toolCount - a.toolCount);

  return {
    available: true,
    declaredCount: declared.length,
    visibleCount: matches.length,
    unusedCount: unused.length,
    mcpToolCount: seenNamesAll.size,
    matches,
    unused,
    extraInWire,
    confidence: "heuristic",
    note: NOTE,
  };
}
