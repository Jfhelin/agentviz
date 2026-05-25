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
    expect(out).toContain("TL;DR");
    expect(out).toContain("What the user wanted");
    expect(out).toContain("How it played out");
    expect(out).toContain("Where the money went");
    expect(out).toContain("What the user could change");
    expect(out).toContain("Model fit");
    expect(out).toContain("Auto-mode verdict");
    expect(out).toContain("Unused capacity");
  });

  it("embeds the don't-fabricate guard", () => {
    const out = buildLlmAnalysisPrompt(analysis);
    expect(out.toLowerCase()).toContain("only the facts");
    expect(out.toLowerCase()).toContain("do not speculate");
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

  it("emits the pre-computed cost-lever block with Auto-mode bullets", () => {
    const out = buildLlmAnalysisPrompt(analysis);
    expect(out).toContain("Pre-computed cost levers");
    expect(out).toContain("Unused tool definitions");
    expect(out).toContain("Skill carry overhead");
    expect(out).toContain("Auto-mode floor");
    // The optimistic Auto bullet only appears when a cheaper alt exists,
    // which depends on the chosen model. Just check the floor bullet is
    // always present.
  });

  it("declares skill-usage detection rather than asking the analyst to infer it", () => {
    const out = buildLlmAnalysisPrompt(analysis);
    // The new positive rule must be present; the old guard line must be gone.
    expect(out).toContain("Unused skills (directly removable)");
    expect(out).toContain("We DO detect which skills were USED");
    expect(out).not.toContain("We CANNOT directly detect which skills were USED");
  });

  it("detects used skills when a skill's file path appears in any tool call's args", () => {
    // Mutate a copy of the parsed analysis to inject two known skills + one
    // tool call that references one of them. Easier than building a full
    // CostAnalysis from scratch.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cloned: any = JSON.parse(JSON.stringify(analysis));
    // Find the first non-overhead LLM event and attach our test skills.
    let injected = false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    cloned.prompts.forEach((p: any) => p.events.forEach((e: any) => {
      if (injected || e.kind !== "llm" || e.category === "overhead") return;
      e.skills = [
        { name: "used-skill", file: "/abs/path/to/used-skill/SKILL.md", chars: 4000, description: "" },
        { name: "ghost-skill", file: "/abs/path/to/ghost-skill/SKILL.md", chars: 8000, description: "" },
      ];
      e.producedToolCalls = [
        { name: "read_file", argsSummary: "", rawArgs: '{"path":"/abs/path/to/used-skill/SKILL.md"}' },
      ];
      injected = true;
    }));
    expect(injected).toBe(true);
    const out = buildLlmAnalysisPrompt(cloned);
    expect(out).toContain("✓ `used-skill`");
    expect(out).toContain("✗ `ghost-skill`");
    expect(out).toMatch(/2 skills attached \(1 used, 1 unused\)/);
  });

  it("emits a pre-computed Auto-mode fit verdict with named drift signals", () => {
    const out = buildLlmAnalysisPrompt(analysis);
    expect(out).toContain("Auto-mode fit verdict");
    // Verdict label must be one of the three buckets.
    expect(out).toMatch(/\*\*(Good fit|Borderline fit|Poor fit)\*\*/);
    // Sec 7 instructions must reference the pre-computed verdict.
    expect(out).toMatch(/cite the pre-computed \*\*Auto-mode fit verdict\*\*/);
  });

  it("emits a top-expensive-call composition bullet with cause interpretation and venue guide", () => {
    const out = buildLlmAnalysisPrompt(analysis);
    expect(out).toContain("Top expensive call composition");
    // Composition must identify the dominant output slice as one of the
    // three buckets and include an interpretation hint.
    expect(out).toMatch(/Output dominated by `(thinking|visible_reply|tool_args|\(unknown\))`/);
    // Section 5 must require venue tagging.
    expect(out).toContain("venue tag");
    expect(out).toContain("Venue guide for section 5 suggestions");
    expect(out).toContain("[inline prompt]");
    expect(out).toContain("[AGENTS.md]");
    expect(out).toContain("[custom skill: SKILL.md]");
  });
});
