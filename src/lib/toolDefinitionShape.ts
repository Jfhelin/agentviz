/**
 * Tool definition shape analysis
 *
 * Classifies each model-visible tool definition sent to a Copilot chat call as
 * one of:
 *  - direct_tool             : single-operation schema (read_file, grep, …).
 *  - router_or_grouped_tool  : one schema standing in for many deferred
 *                              subcommands (e.g. an MCP command router that
 *                              expects `learn=true` to discover subcommands).
 *  - possible_router_tool    : looks generic (operation / mode / action /
 *                              resource fields) but does not explicitly
 *                              advertise routing.
 *  - unknown                 : malformed or missing schema/description.
 *
 * Why this matters: a user can have hundreds of tools selected in VS Code, but
 * the model is shown only the tool definitions that Copilot decides to ship in
 * the request. Some of those model-visible definitions may themselves wrap
 * many hidden subcommands. The cost-analysis report must therefore distinguish
 * "IDE selected tools" from "model-visible tool definitions" and within the
 * latter, direct tools from router/grouped tools, so we never overstate
 * savings or imply that every selected tool was sent on the wire.
 */

export type ToolDefinitionKind =
  | "direct_tool"
  | "router_or_grouped_tool"
  | "possible_router_tool"
  | "unknown";

export type ToolDefinitionConfidence = "high" | "medium" | "low";

export interface ToolDefinitionClassification {
  name: string;
  kind: ToolDefinitionKind;
  confidence: ToolDefinitionConfidence;
  /** Human-readable signal strings that drove the classification.
   *  Surfaced in the LLM analysis export so a reviewer can audit the call. */
  signals: string[];
  hasLearnParameter: boolean;
  hasCommandParameter: boolean;
  hasGenericParametersObject: boolean;
  hasRouterLanguage: boolean;
  hasSubcommandLanguage: boolean;
  hasMcpNamePrefix: boolean;
}

export interface RouterToolUsage {
  name: string;
  used: boolean;
  callCount: number;
  learnTrueCalled: boolean;
  commandsCalled: string[];
}

export interface ToolDefinitionShapeAnalysis {
  available: boolean;
  modelVisibleToolDefinitionsCount: number;
  directToolCount: number;
  routerOrGroupedToolCount: number;
  possibleRouterToolCount: number;
  unknownToolCount: number;
  routerOrGroupedTools: ToolDefinitionClassification[];
  possibleRouterTools: ToolDefinitionClassification[];
  directTools: ToolDefinitionClassification[];
  /** Detected usage of each router/grouped tool across actual tool calls.
   *  Keyed by tool name; only populated for router_or_grouped_tool entries. */
  routerUsage: RouterToolUsage[];
  note: string;
}

const NOTE = [
  "\"Model-visible tool definitions\" are the tool schemas actually sent to the model.",
  "This may be much smaller than the number of tools selected/enabled in VS Code.",
  "Router/grouped tools can represent multiple hidden or deferred subcommands behind one schema.",
].join(" ");

const ROUTER_DESCRIPTION_PATTERNS: RegExp[] = [
  /hierarchical\s+mcp\s+command\s+router/i,
  /command\s+router/i,
  /\brouter\b/i,
  /\bsub-?\s?commands?\b/i,
  /\bsub\s+commands?\b/i,
  /discover\s+available\s+sub-?commands?/i,
  /learn\s*=\s*true/i,
  /routed\s+to\s+mcp\s+servers/i,
];

const SUBCOMMAND_DESCRIPTION_PATTERNS: RegExp[] = [
  /\bsub-?\s?commands?\b/i,
  /\bsub\s+commands?\b/i,
];

const POSSIBLE_ROUTER_PROP_NAMES = new Set([
  "operation",
  "action",
  "mode",
  "resource",
  "intent",
  "type",
]);

const GENERIC_PARAMETERS_PROP_DESCRIPTION = /\bgeneric|free-?form|arbitrary\b/i;

interface RawToolShape {
  name?: string;
  description?: string;
  function?: { name?: string; description?: string; parameters?: unknown };
  parameters?: unknown;
}

function extractName(tool: unknown): string {
  const t = tool as RawToolShape | null;
  if (!t) return "(unnamed)";
  return t.name ?? t.function?.name ?? "(unnamed)";
}

function extractDescription(tool: unknown): string {
  const t = tool as RawToolShape | null;
  if (!t) return "";
  return t.function?.description ?? t.description ?? "";
}

function extractParameters(tool: unknown): { properties: Record<string, unknown>; required: string[] } | null {
  const t = tool as RawToolShape | null;
  if (!t) return null;
  const params = t.function?.parameters ?? t.parameters;
  if (!params || typeof params !== "object") return null;
  const obj = params as { properties?: unknown; required?: unknown };
  const properties = (obj.properties && typeof obj.properties === "object")
    ? (obj.properties as Record<string, unknown>)
    : {};
  const required = Array.isArray(obj.required) ? (obj.required as unknown[]).filter((x): x is string => typeof x === "string") : [];
  return { properties, required };
}

function isBooleanProperty(propSchema: unknown): boolean {
  if (!propSchema || typeof propSchema !== "object") return false;
  const t = (propSchema as { type?: unknown }).type;
  return t === "boolean";
}

function isGenericObjectProperty(propSchema: unknown): boolean {
  if (!propSchema || typeof propSchema !== "object") return false;
  const ps = propSchema as { type?: unknown; properties?: unknown; description?: unknown };
  if (ps.type !== "object") return false;
  const subProps = (ps.properties && typeof ps.properties === "object")
    ? Object.keys(ps.properties as Record<string, unknown>)
    : [];
  if (subProps.length === 0) return true;
  if (typeof ps.description === "string" && GENERIC_PARAMETERS_PROP_DESCRIPTION.test(ps.description)) return true;
  return false;
}

export function classifyToolDefinition(tool: unknown): ToolDefinitionClassification {
  const name = extractName(tool);
  const description = extractDescription(tool);
  const params = extractParameters(tool);

  // Malformed: no schema AND no description.
  if (!params && !description) {
    return {
      name,
      kind: "unknown",
      confidence: "low",
      signals: ["no schema and no description"],
      hasLearnParameter: false,
      hasCommandParameter: false,
      hasGenericParametersObject: false,
      hasRouterLanguage: false,
      hasSubcommandLanguage: false,
      hasMcpNamePrefix: name.startsWith("mcp_"),
    };
  }

  const props = params?.properties ?? {};
  const propNames = Object.keys(props);

  const hasLearnParameter = "learn" in props && isBooleanProperty((props as Record<string, unknown>)["learn"]);
  const hasCommandParameter = "command" in props;
  const hasParametersProperty = "parameters" in props;
  const hasGenericParametersObject = hasParametersProperty
    && isGenericObjectProperty((props as Record<string, unknown>)["parameters"]);

  const hasRouterLanguage = ROUTER_DESCRIPTION_PATTERNS.some((re) => re.test(description));
  const hasSubcommandLanguage = SUBCOMMAND_DESCRIPTION_PATTERNS.some((re) => re.test(description));
  const hasMcpNamePrefix = name.startsWith("mcp_");

  const signals: string[] = [];
  if (hasLearnParameter) signals.push("has `learn` boolean parameter");
  if (hasCommandParameter) signals.push("has `command` parameter");
  if (hasGenericParametersObject) signals.push("has generic `parameters` object");
  if (hasRouterLanguage) signals.push("description contains router/discovery language");
  if (hasSubcommandLanguage && !hasRouterLanguage) signals.push("description mentions subcommands");
  if (hasMcpNamePrefix) signals.push("name has `mcp_` prefix");

  // Strong router signal combinations -> router_or_grouped_tool / high confidence.
  const commandPlusParameters = hasCommandParameter && hasParametersProperty;
  const strongRouter =
    hasLearnParameter
    || commandPlusParameters
    || hasRouterLanguage
    || (hasMcpNamePrefix && (hasSubcommandLanguage || hasCommandParameter));

  if (strongRouter) {
    return {
      name,
      kind: "router_or_grouped_tool",
      confidence: "high",
      signals,
      hasLearnParameter,
      hasCommandParameter,
      hasGenericParametersObject,
      hasRouterLanguage,
      hasSubcommandLanguage,
      hasMcpNamePrefix,
    };
  }

  // Possible router: generic routing-flavoured property names, or mcp_ prefix
  // with no specific schema, or a `parameters` object without specific siblings.
  const hasRoutingFlavouredProp = propNames.some((p) => POSSIBLE_ROUTER_PROP_NAMES.has(p));
  const hasGenericMode = hasRoutingFlavouredProp || hasGenericParametersObject;
  const mcpWithoutSpecifics = hasMcpNamePrefix && propNames.length <= 2;

  if (hasGenericMode || mcpWithoutSpecifics) {
    if (hasRoutingFlavouredProp) {
      const matching = propNames.filter((p) => POSSIBLE_ROUTER_PROP_NAMES.has(p));
      signals.push("generic routing-style property: " + matching.join(", "));
    }
    if (mcpWithoutSpecifics && !hasRoutingFlavouredProp) {
      signals.push("`mcp_` tool with no specific schema fields");
    }
    return {
      name,
      kind: "possible_router_tool",
      confidence: hasRoutingFlavouredProp && hasMcpNamePrefix ? "medium" : "low",
      signals,
      hasLearnParameter,
      hasCommandParameter,
      hasGenericParametersObject,
      hasRouterLanguage,
      hasSubcommandLanguage,
      hasMcpNamePrefix,
    };
  }

  // Default: direct tool.
  return {
    name,
    kind: "direct_tool",
    confidence: "high",
    signals,
    hasLearnParameter,
    hasCommandParameter,
    hasGenericParametersObject,
    hasRouterLanguage,
    hasSubcommandLanguage,
    hasMcpNamePrefix,
  };
}

export interface ActualToolCall {
  name: string;
  args: Record<string, unknown> | null;
}

/** Build router-usage stats by scanning actual tool calls against the set of
 *  classified router/grouped tool definitions. */
export function buildRouterUsage(
  routerTools: ToolDefinitionClassification[],
  actualCalls: ActualToolCall[],
): RouterToolUsage[] {
  const byName = new Map<string, RouterToolUsage>();
  for (const t of routerTools) {
    byName.set(t.name, {
      name: t.name,
      used: false,
      callCount: 0,
      learnTrueCalled: false,
      commandsCalled: [],
    });
  }
  for (const c of actualCalls) {
    const u = byName.get(c.name);
    if (!u) continue;
    u.used = true;
    u.callCount += 1;
    const args = c.args ?? {};
    if (args["learn"] === true) u.learnTrueCalled = true;
    const cmd = args["command"];
    if (typeof cmd === "string" && cmd.length > 0 && !u.commandsCalled.includes(cmd)) {
      u.commandsCalled.push(cmd);
    }
  }
  return Array.from(byName.values());
}

/** Aggregate a list of tool definitions (already de-duplicated upstream if
 *  desired) into a ToolDefinitionShapeAnalysis. `actualCalls` is optional --
 *  pass it to populate router usage. */
export function analyzeToolDefinitionShape(
  tools: unknown[],
  actualCalls: ActualToolCall[] = [],
): ToolDefinitionShapeAnalysis {
  if (!tools || tools.length === 0) {
    return {
      available: false,
      modelVisibleToolDefinitionsCount: 0,
      directToolCount: 0,
      routerOrGroupedToolCount: 0,
      possibleRouterToolCount: 0,
      unknownToolCount: 0,
      routerOrGroupedTools: [],
      possibleRouterTools: [],
      directTools: [],
      routerUsage: [],
      note: NOTE,
    };
  }

  const classified = tools.map(classifyToolDefinition);
  const directTools = classified.filter((c) => c.kind === "direct_tool");
  const routerTools = classified.filter((c) => c.kind === "router_or_grouped_tool");
  const possibleRouterTools = classified.filter((c) => c.kind === "possible_router_tool");
  const unknownTools = classified.filter((c) => c.kind === "unknown");

  return {
    available: true,
    modelVisibleToolDefinitionsCount: classified.length,
    directToolCount: directTools.length,
    routerOrGroupedToolCount: routerTools.length,
    possibleRouterToolCount: possibleRouterTools.length,
    unknownToolCount: unknownTools.length,
    routerOrGroupedTools: routerTools,
    possibleRouterTools,
    directTools,
    routerUsage: buildRouterUsage(routerTools, actualCalls),
    note: NOTE,
  };
}
