import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildCoachPrompt, buildSystemPrompt, parseRecommendations, getConfigPathsForFormat } from "../lib/aiCoachAgent.js";

// ─────────────────────────────────────────────────────────────────────────────
// buildCoachPrompt
// ─────────────────────────────────────────────────────────────────────────────

describe("buildCoachPrompt", function () {
  var basePayload = {
    format: "claude-code",
    primaryModel: "claude-opus-4",
    totalEvents: 500,
    totalTurns: 20,
    errorCount: 8,
    totalToolCalls: 150,
    productiveRuntime: "2400s",
    humanResponseTime: "300s",
    idleTime: "120s",
    interventions: 5,
    autonomyEfficiency: "72%",
    topTools: [{ name: "bash", count: 80 }, { name: "view", count: 50 }],
    errorSamples: ["[bash] web_fetch: timeout", "[bash] permission denied"],
    userFollowUps: ["try again", "did it work?"],
    configSummary: ".claude.json: { permissions: {} }",
  };

  it("includes agent type in first line", function () {
    var prompt = buildCoachPrompt(basePayload);
    expect(prompt).toContain("Claude Code");
  });

  it("labels copilot-cli correctly", function () {
    var prompt = buildCoachPrompt(Object.assign({}, basePayload, { format: "copilot-cli" }));
    expect(prompt).toContain("GitHub Copilot CLI");
  });

  it("labels ATIF sessions correctly", function () {
    var prompt = buildCoachPrompt(Object.assign({}, basePayload, { format: "atif" }));
    expect(prompt).toContain("Analyze this ATIF / Harbor session");
    expect(prompt).not.toContain("Analyze this Claude Code session");
  });

  it("includes all key stats", function () {
    var prompt = buildCoachPrompt(basePayload);
    expect(prompt).toContain("claude-opus-4");
    expect(prompt).toContain("Events: 500");
    expect(prompt).toContain("Turns: 20");
    expect(prompt).toContain("Errors: 8");
    expect(prompt).toContain("Autonomy efficiency: 72%");
    expect(prompt).toContain("bash x80");
  });

  it("includes error samples section", function () {
    var prompt = buildCoachPrompt(basePayload);
    expect(prompt).toContain("Errors observed");
    expect(prompt).toContain("web_fetch: timeout");
  });

  it("includes human follow-ups section", function () {
    var prompt = buildCoachPrompt(basePayload);
    expect(prompt).toContain("Human messages verbatim");
    expect(prompt).toContain("try again");
  });

  it("includes available config paths", function () {
    var prompt = buildCoachPrompt(basePayload);
    expect(prompt).toContain("Available config paths");
    expect(prompt).toContain(".mcp.json");
  });

  it("omits error section when no errors", function () {
    var prompt = buildCoachPrompt(Object.assign({}, basePayload, { errorSamples: [] }));
    expect(prompt).not.toContain("Errors observed");
  });

  it("limits topTools to 10 entries", function () {
    var manyTools = Array.from({ length: 15 }, function (_, i) { return { name: "tool" + i, count: i }; });
    var prompt = buildCoachPrompt(Object.assign({}, basePayload, { topTools: manyTools }));
    // Count occurrences of "tool" in the tools line
    var toolsLine = prompt.split("\n").find(function (l) { return l.startsWith("- Top tools used:"); });
    var matches = (toolsLine || "").match(/tool\d+/g) || [];
    expect(matches.length).toBeLessThanOrEqual(10);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// buildSystemPrompt
// ─────────────────────────────────────────────────────────────────────────────

describe("buildSystemPrompt", function () {
  it("uses Copilot guidance for ATIF sessions from Copilot agents", function () {
    var prompt = buildSystemPrompt("atif", "copilot");
    expect(prompt).toContain("Agent type: GITHUB COPILOT CLI");
    expect(prompt).not.toContain("Agent type: CLAUDE CODE");
  });

  it("uses Claude guidance for ATIF sessions from Claude agents", function () {
    var prompt = buildSystemPrompt("atif", "claude-code");
    expect(prompt).toContain("Agent type: CLAUDE CODE");
    expect(prompt).not.toContain("Agent type: GITHUB COPILOT CLI");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// parseRecommendations
// ─────────────────────────────────────────────────────────────────────────────

describe("parseRecommendations", function () {
  it("parses plain JSON array", function () {
    var raw = JSON.stringify([
      { title: "Add MCP server", priority: "high", summary: "Test summary", fix: "Install it", draft: "npm install ..." },
    ]);
    var recs = parseRecommendations(raw);
    expect(recs).toHaveLength(1);
    expect(recs[0].title).toBe("Add MCP server");
    expect(recs[0].priority).toBe("high");
  });

  it("strips markdown code fences", function () {
    var raw = "```json\n[{\"title\":\"T\",\"priority\":\"medium\",\"summary\":\"S\",\"fix\":\"F\",\"draft\":\"D\"}]\n```";
    var recs = parseRecommendations(raw);
    expect(recs).toHaveLength(1);
    expect(recs[0].title).toBe("T");
  });

  it("unwraps { recommendations: [...] } envelope", function () {
    var raw = JSON.stringify({ recommendations: [
      { title: "T", priority: "high", summary: "S", fix: "F", draft: "D" },
    ]});
    var recs = parseRecommendations(raw);
    expect(recs).toHaveLength(1);
    expect(recs[0].title).toBe("T");
  });

  it("unwraps arbitrary object envelope with first array value", function () {
    var raw = JSON.stringify({ items: [
      { title: "T", priority: "medium", summary: "S", fix: "F", draft: "D" },
    ]});
    var recs = parseRecommendations(raw);
    expect(recs).toHaveLength(1);
  });

  it("normalizes missing fields to empty strings", function () {
    var raw = JSON.stringify([{ title: "Only title" }]);
    var recs = parseRecommendations(raw);
    expect(recs[0].summary).toBe("");
    expect(recs[0].fix).toBe("");
    expect(recs[0].draft).toBe("");
    expect(recs[0].priority).toBe("medium");
  });

  it("normalizes unknown priority to medium", function () {
    var raw = JSON.stringify([{ title: "T", priority: "critical", summary: "", fix: "", draft: "" }]);
    var recs = parseRecommendations(raw);
    expect(recs[0].priority).toBe("medium");
  });

  it("extracts array when surrounded by prose", function () {
    var raw = 'Here are recommendations:\n[{"title":"T","priority":"high","summary":"S","fix":"F","draft":"D"}]\nHope this helps!';
    var recs = parseRecommendations(raw);
    expect(recs).toHaveLength(1);
  });

  it("throws on empty response", function () {
    expect(function () { parseRecommendations(""); }).toThrow("Empty response");
  });

  it("throws on non-JSON response", function () {
    expect(function () { parseRecommendations("Sorry, I cannot help with that."); }).toThrow();
  });

  it("throws on object with no array values", function () {
    expect(function () { parseRecommendations(JSON.stringify({ count: 5 })); }).toThrow("unexpected shape");
  });

  it("handles multiple recommendations", function () {
    var items = [
      { title: "A", priority: "high", summary: "Sa", fix: "Fa", draft: "Da" },
      { title: "B", priority: "medium", summary: "Sb", fix: "Fb", draft: "Db" },
      { title: "C", priority: "medium", summary: "Sc", fix: "Fc", draft: "Dc" },
    ];
    var recs = parseRecommendations(JSON.stringify(items));
    expect(recs).toHaveLength(3);
    expect(recs[1].title).toBe("B");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// getConfigPathsForFormat
// ─────────────────────────────────────────────────────────────────────────────

describe("getConfigPathsForFormat", function () {
  it("returns claude paths for claude-code", function () {
    var paths = getConfigPathsForFormat("claude-code");
    expect(paths).toContain("CLAUDE.md");
    expect(paths).toContain(".claude/skills");
  });

  it("returns copilot paths for copilot-cli", function () {
    var paths = getConfigPathsForFormat("copilot-cli");
    expect(paths).toContain(".github/copilot-instructions.md");
    expect(paths).toContain(".github/skills");
  });

  it("routes ATIF with copilot agent name to copilot paths", function () {
    var paths = getConfigPathsForFormat("atif", "copilot");
    expect(paths).toContain(".github/copilot-instructions.md");
    expect(paths).not.toContain("CLAUDE.md");
  });

  it("routes ATIF with claude-code agent name to claude paths", function () {
    var paths = getConfigPathsForFormat("atif", "claude-code");
    expect(paths).toContain("CLAUDE.md");
    expect(paths).not.toContain(".github/copilot-instructions.md");
  });

  it("defaults ATIF without agent name to copilot paths", function () {
    var paths = getConfigPathsForFormat("atif", "");
    expect(paths).toContain(".github/copilot-instructions.md");
  });
});
