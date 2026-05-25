import { describe, it, expect } from "vitest";
import {
  normalizeServerSlug,
  collectMcpPrefixes,
  analyzeMcpReachability,
} from "../lib/mcpServerReachability";

// ── Slug normalization ──────────────────────────────────────────────────────

describe("normalizeServerSlug", () => {
  it("returns most-specific slugs first and drops trailing noise tokens", () => {
    // "Azure MCP Server" -> ["azure_mcp", "azure"]  (azure_mcp_server is dropped
    // because trailing "server" is a noise token).
    expect(normalizeServerSlug("Azure MCP Server")).toEqual(["azure_mcp", "azure"]);
  });
  it("collapses adjacent duplicate tokens in path-style labels", () => {
    // tokens = io, github, github, github, mcp, server  -> dedup-adjacent:
    //   kept = io, github, mcp, server  -> trailing "server" dropped at take=4.
    expect(normalizeServerSlug("io.github.github/github-mcp-server")).toEqual([
      "io_github_mcp",
      "io_github",
      "io",
    ]);
  });
  it("handles single-word labels", () => {
    expect(normalizeServerSlug("playwright")).toEqual(["playwright"]);
    expect(normalizeServerSlug("Bicep")).toEqual(["bicep"]);
  });
  it("handles hyphenated labels", () => {
    expect(normalizeServerSlug("github-agentic-workflows")).toEqual([
      "github_agentic_workflows",
      "github_agentic",
      "github",
    ]);
  });
  it("handles empty / garbage", () => {
    expect(normalizeServerSlug("")).toEqual([]);
    expect(normalizeServerSlug("  ---  ")).toEqual([]);
  });
});

// ── Prefix collection ───────────────────────────────────────────────────────

describe("collectMcpPrefixes", () => {
  it("counts distinct names per slug at multiple token depths", () => {
    const m = collectMcpPrefixes([
      "mcp_azure_mcp_storage_list",
      "mcp_azure_mcp_storage_get",
      "mcp_io_github_create_issue",
      "read_file",
    ]);
    expect(m.get("azure")).toBe(2);
    expect(m.get("azure_mcp")).toBe(2);
    expect(m.get("azure_mcp_storage")).toBe(2);
    expect(m.get("io_github")).toBe(1);
  });
});

// ── End-to-end matcher against the real fixture pattern ────────────────────

describe("analyzeMcpReachability", () => {
  // Recreate the discrepancy seen in t1_b_mcp182.json: 8 declared servers, 3
  // contribute tools to the wire, 5 are unused.
  const declared = [
    { label: "Azure MCP Server", type: "stdio", command: "npx" },
    { label: "github", type: "stdio", command: "docker" },
    { label: "github-agentic-workflows", type: "stdio", command: "gh" },
    { label: "github-remote", type: "http" },
    { label: "playwright", type: "stdio", command: "npx" },
    { label: "io.github.github/github-mcp-server", type: "http" },
    { label: "Bicep", type: "stdio" },
    { label: "pylance mcp server", type: "http" },
  ];
  const toolNames = [
    "mcp_azure_mcp_storage_list",
    "mcp_azure_mcp_storage_get",
    "mcp_io_github_create_issue",
    "mcp_io_github_list_repos",
    "mcp_playwright_browser_click",
    "mcp_playwright_browser_screenshot",
    "read_file",
    "grep_search",
  ];

  it("matches the 3 visible servers and reports the other 5 as unused", () => {
    const r = analyzeMcpReachability(declared, toolNames);
    expect(r.available).toBe(true);
    expect(r.declaredCount).toBe(8);
    expect(r.visibleCount).toBe(3);
    expect(r.unusedCount).toBe(5);
    const visibleLabels = r.matches.map((m) => m.server.label).sort();
    expect(visibleLabels).toEqual([
      "Azure MCP Server",
      "io.github.github/github-mcp-server",
      "playwright",
    ]);
    const unusedLabels = r.unused.map((u) => u.label).sort();
    expect(unusedLabels).toEqual([
      "Bicep",
      "github",
      "github-agentic-workflows",
      "github-remote",
      "pylance mcp server",
    ]);
  });

  it("picks the most-specific slug match", () => {
    const r = analyzeMcpReachability(declared, toolNames);
    const azure = r.matches.find((m) => m.server.label === "Azure MCP Server")!;
    expect(azure.slug).toBe("azure_mcp");
    expect(azure.slugTokenCount).toBe(2);
    expect(azure.toolCount).toBe(2);

    const githubMcp = r.matches.find((m) => m.server.label.includes("io.github"))!;
    expect(githubMcp.slug).toBe("io_github");
    expect(githubMcp.toolCount).toBe(2);
  });

  it("reports extra-in-wire mcp_ prefixes not claimed by any declared server", () => {
    const r = analyzeMcpReachability(
      [{ label: "playwright" }],
      ["mcp_playwright_browser_x", "mcp_someother_thing_y", "mcp_someother_thing_z"],
    );
    expect(r.visibleCount).toBe(1);
    expect(r.extraInWire).toEqual([{ slug: "someother", toolCount: 2 }]);
  });

  it("handles empty declared list", () => {
    const r = analyzeMcpReachability([], ["mcp_azure_x"]);
    expect(r.available).toBe(false);
    expect(r.confidence).toBe("no_servers_declared");
  });
});
