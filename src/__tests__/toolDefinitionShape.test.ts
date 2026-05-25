import { describe, it, expect } from "vitest";
import {
  classifyToolDefinition,
  analyzeToolDefinitionShape,
  buildRouterUsage,
} from "../lib/toolDefinitionShape";

// ── Fixture builders ────────────────────────────────────────────────────────

function direct(name: string, props: Record<string, unknown> = { path: { type: "string" } }, description = ""): unknown {
  return {
    function: {
      name,
      description,
      parameters: {
        type: "object",
        properties: props,
        required: Object.keys(props),
        additionalProperties: false,
      },
    },
  };
}

function azureRouter(): unknown {
  return {
    function: {
      name: "mcp_azure_mcp_ser_search",
      description: "This is a hierarchical MCP command router using the command field and parameters; set learn=true to discover available sub-commands.",
      parameters: {
        type: "object",
        properties: {
          intent: { type: "string" },
          command: { type: "string" },
          parameters: { type: "object" },
          learn: { type: "boolean", default: false },
        },
        required: ["intent"],
        additionalProperties: false,
      },
    },
  };
}

// ── Classifier ──────────────────────────────────────────────────────────────

describe("classifyToolDefinition", () => {
  it("classifies the azure MCP router as router_or_grouped_tool with high confidence", () => {
    const r = classifyToolDefinition(azureRouter());
    expect(r.kind).toBe("router_or_grouped_tool");
    expect(r.confidence).toBe("high");
    expect(r.hasLearnParameter).toBe(true);
    expect(r.hasCommandParameter).toBe(true);
    expect(r.hasGenericParametersObject).toBe(true);
    expect(r.hasRouterLanguage).toBe(true);
    expect(r.hasMcpNamePrefix).toBe(true);
    expect(r.signals.some(s => s.includes("router/discovery language"))).toBe(true);
  });

  it("classifies typical direct tools as direct_tool", () => {
    for (const name of ["read_file", "file_search", "grep_search", "multi_replace_string_in_file", "create_file", "semantic_search"]) {
      const r = classifyToolDefinition(direct(name, { path: { type: "string" } }, "Read a file"));
      expect(r.kind).toBe("direct_tool");
      expect(r.confidence).toBe("high");
    }
  });

  it("treats `learn` boolean alone as a strong router signal even without router language", () => {
    const tool = direct("custom_tool", { learn: { type: "boolean" }, query: { type: "string" } }, "Search things");
    const r = classifyToolDefinition(tool);
    expect(r.kind).toBe("router_or_grouped_tool");
    expect(r.hasLearnParameter).toBe(true);
  });

  it("treats command+parameters combo as a strong router signal", () => {
    const tool = direct("custom_router", { command: { type: "string" }, parameters: { type: "object" } }, "Dispatch a command");
    const r = classifyToolDefinition(tool);
    expect(r.kind).toBe("router_or_grouped_tool");
  });

  it("classifies generic operation-style schemas as possible_router_tool", () => {
    const tool = direct("widget_tool", { operation: { type: "string" }, payload: { type: "object" } }, "Run an operation on a widget");
    const r = classifyToolDefinition(tool);
    expect(r.kind).toBe("possible_router_tool");
    expect(r.signals.some(s => s.includes("operation"))).toBe(true);
  });

  it("classifies mcp_ prefixed tools without specifics as possible_router_tool", () => {
    const tool = direct("mcp_someserver_thing", { input: { type: "string" } }, "Does a thing");
    const r = classifyToolDefinition(tool);
    expect(r.kind).toBe("possible_router_tool");
    expect(r.hasMcpNamePrefix).toBe(true);
  });

  it("classifies malformed tools as unknown", () => {
    const r = classifyToolDefinition({});
    expect(r.kind).toBe("unknown");
    expect(r.confidence).toBe("low");
  });

  it("handles top-level (non-`function`-wrapped) tool shape", () => {
    const tool = {
      name: "mcp_x",
      description: "Hierarchical MCP command router",
      parameters: { type: "object", properties: { command: { type: "string" }, parameters: { type: "object" } } },
    };
    const r = classifyToolDefinition(tool);
    expect(r.kind).toBe("router_or_grouped_tool");
    expect(r.confidence).toBe("high");
  });
});

// ── Aggregate ───────────────────────────────────────────────────────────────

describe("analyzeToolDefinitionShape", () => {
  it("returns available=false on an empty tool list", () => {
    const r = analyzeToolDefinitionShape([]);
    expect(r.available).toBe(false);
    expect(r.modelVisibleToolDefinitionsCount).toBe(0);
  });

  it("aggregates direct + router + possible-router + unknown counts", () => {
    const tools = [
      direct("read_file"),
      direct("file_search"),
      azureRouter(),
      direct("widget", { operation: { type: "string" } }),
      {},
    ];
    const r = analyzeToolDefinitionShape(tools);
    expect(r.available).toBe(true);
    expect(r.modelVisibleToolDefinitionsCount).toBe(5);
    expect(r.directToolCount).toBe(2);
    expect(r.routerOrGroupedToolCount).toBe(1);
    expect(r.possibleRouterToolCount).toBe(1);
    expect(r.unknownToolCount).toBe(1);
    expect(r.routerOrGroupedTools[0].name).toBe("mcp_azure_mcp_ser_search");
    expect(r.note).toMatch(/model-visible/i);
  });

  it("populates router usage from actual calls", () => {
    const tools = [azureRouter(), direct("read_file")];
    const calls = [
      { name: "mcp_azure_mcp_ser_search", args: { intent: "find blob", learn: true } },
      { name: "mcp_azure_mcp_ser_search", args: { intent: "list", command: "storage list" } },
      { name: "read_file", args: { path: "a.ts" } },
    ];
    const r = analyzeToolDefinitionShape(tools, calls);
    expect(r.routerUsage).toHaveLength(1);
    const u = r.routerUsage[0];
    expect(u.used).toBe(true);
    expect(u.callCount).toBe(2);
    expect(u.learnTrueCalled).toBe(true);
    expect(u.commandsCalled).toEqual(["storage list"]);
  });

  it("reports unused router when never invoked", () => {
    const r = analyzeToolDefinitionShape([azureRouter()], [{ name: "read_file", args: {} }]);
    expect(r.routerUsage[0].used).toBe(false);
    expect(r.routerUsage[0].callCount).toBe(0);
    expect(r.routerUsage[0].learnTrueCalled).toBe(false);
  });
});

// ── buildRouterUsage edge cases ─────────────────────────────────────────────

describe("buildRouterUsage", () => {
  it("ignores calls for non-router tool names", () => {
    const r = buildRouterUsage([], [{ name: "anything", args: {} }]);
    expect(r).toEqual([]);
  });

  it("deduplicates commandsCalled", () => {
    const tools = [classifyToolDefinition(azureRouter())];
    const r = buildRouterUsage(tools, [
      { name: "mcp_azure_mcp_ser_search", args: { command: "x" } },
      { name: "mcp_azure_mcp_ser_search", args: { command: "x" } },
      { name: "mcp_azure_mcp_ser_search", args: { command: "y" } },
    ]);
    expect(r[0].commandsCalled).toEqual(["x", "y"]);
  });
});
