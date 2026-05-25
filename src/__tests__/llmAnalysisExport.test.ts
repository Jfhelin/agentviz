import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseSession } from "../lib/parseSession";
import { buildLlmAnalysisPrompt } from "../lib/llmAnalysisExport";

const fixturePath = resolve(__dirname, "fixtures/copilot-chat-export-minimal.json");

describe("buildLlmAnalysisPrompt", () => {
  const text = readFileSync(fixturePath, "utf8");
  const parsed = parseSession(text)!;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const analysis = (parsed as any).metadata.costAnalysis;

  it("produces a non-empty markdown payload", () => {
    const out = buildLlmAnalysisPrompt(analysis);
    expect(typeof out).toBe("string");
    expect(out.length).toBeGreaterThan(500);
  });

  it("includes the eight required report sections", () => {
    const out = buildLlmAnalysisPrompt(analysis);
    expect(out).toContain("Session title");
    expect(out).toContain("The user's goal");
    expect(out).toContain("How the agent got there");
    expect(out).toContain("Efficiency analysis");
    expect(out).toContain("What the user could have done differently");
    expect(out).toContain("Model fit");
    expect(out).toContain("Auto-mode suitability");
    expect(out).toContain("Unused capacity");
  });

  it("embeds the don't-fabricate guard", () => {
    const out = buildLlmAnalysisPrompt(analysis);
    expect(out.toLowerCase()).toContain("do not invent");
    expect(out.toLowerCase()).toContain("only the facts");
  });

  it("includes a per-call JSON breakdown", () => {
    const out = buildLlmAnalysisPrompt(analysis);
    expect(out).toContain("Per-call breakdown");
    expect(out).toMatch(/"ctx_in":\s*\d+/);
    expect(out).toMatch(/"cost_usd":/);
  });

  it("points the analyst at the GitHub pricing reference URL", () => {
    const out = buildLlmAnalysisPrompt(analysis);
    expect(out).toContain("docs.github.com");
    expect(out).toContain("copilot-billing/models-and-pricing");
  });

  it("includes the user's prompt text in full", () => {
    const out = buildLlmAnalysisPrompt(analysis);
    expect(out).toContain("User messages");
    // Fixture's first prompt is short enough to round-trip unchanged.
    expect(out).toContain("Turn 1");
  });

  it("respects the session label when provided", () => {
    const out = buildLlmAnalysisPrompt(analysis, { sessionLabel: "test-session-xyz" });
    expect(out).toContain("test-session-xyz");
  });
});
