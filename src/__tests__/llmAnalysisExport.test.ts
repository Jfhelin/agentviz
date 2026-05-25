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

  it("includes all required report sections", () => {
    const out = buildLlmAnalysisPrompt(analysis);
    expect(out).toContain("TL;DR");
    expect(out).toContain("Developer takeaway");
    expect(out).toContain("Main efficiency levers");
    expect(out).toContain("What made this session expensive");
    expect(out).toContain("What was probably unavoidable");
    expect(out).toContain("Recommended changes");
    expect(out).toContain("Automation boundary");
    expect(out).toContain("Tool and skill profile cleanup");
    expect(out).toContain("Model and Auto-mode guidance");
    expect(out).toContain("Inline prompt guidance");
    expect(out).toContain("Data confidence and missing data");
    expect(out).toContain("Suggestions for improving future telemetry");
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
    // The pre-computed cost-lever bullet must still surface unused skills.
    expect(out).toContain("Unused skills (directly removable)");
    // The structured skill_usage block (and the spec-named skills_profile_analysis)
    // must be present so the analyst can cite per-skill detection rather than re-inferring it.
    expect(out).toContain("\"skills_profile_analysis\"");
    expect(out).toContain("\"skill_attachment_source\": \"unknown_not_recorded_in_export\"");
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
    // Auto-mode guidance section must reference the Auto-mode verdict by JSON field path.
    expect(out).toContain("auto_mode_data");
    expect(out).toContain("verdict");
  });

  it("emits a top-expensive-call composition bullet with cause interpretation and venue guide", () => {
    const out = buildLlmAnalysisPrompt(analysis);
    expect(out).toContain("Top expensive call composition");
    // Composition must identify the dominant output slice as one of the
    // three buckets and include an interpretation hint.
    expect(out).toMatch(/Output dominated by `(thinking|visible_reply|tool_args|\(unknown\))`/);
    // The venue guide must spell out the four canonical surfaces.
    expect(out).toContain("Venue guide");
    expect(out).toContain("[inline prompt]");
    expect(out).toContain("[AGENTS.md]");
    expect(out).toContain("[custom skill: SKILL.md]");
  });

  it("emits a structured facts JSON block with all top-level developer-facing keys", () => {
    const out = buildLlmAnalysisPrompt(analysis);
    expect(out).toContain("## Structured facts (JSON)");
    // Extract the JSON block that follows the heading.
    const match = out.match(/## Structured facts \(JSON\)[\s\S]*?```json\n([\s\S]*?)\n```/);
    expect(match).not.toBeNull();
    const facts = JSON.parse(match![1]);
    // Developer-facing top-level keys (the source of truth).
    expect(facts).toHaveProperty("session_metadata");
    expect(facts).toHaveProperty("developer_action_summary");
    expect(facts).toHaveProperty("workflow_classification");
    expect(facts).toHaveProperty("developer_efficiency_findings");
    expect(facts).toHaveProperty("developer_levers_detected");
    expect(facts).toHaveProperty("developer_cost_categories");
    expect(facts).toHaveProperty("recommended_changes");
    expect(facts).toHaveProperty("custom_mode_or_agent_analysis");
    expect(facts).toHaveProperty("ide_tool_configuration_analysis");
    expect(facts).toHaveProperty("skills_profile_analysis");
    expect(facts).toHaveProperty("automation_boundary_recommendation");
    expect(facts).toHaveProperty("model_strategy_recommendation");
    expect(facts).toHaveProperty("prompt_strategy_recommendation");
    expect(facts).toHaveProperty("quality_and_validation");
    expect(facts).toHaveProperty("workflow_phase_analysis");
    expect(facts).toHaveProperty("agent_loop_efficiency");
    expect(facts).toHaveProperty("tool_result_size_analysis");
    expect(facts).toHaveProperty("baseline_comparison");
    expect(facts).toHaveProperty("experiment_validity");
    expect(facts).toHaveProperty("control_surface_analysis");
    expect(facts).toHaveProperty("missing_data");
    expect(Array.isArray(facts.missing_data)).toBe(true);
    expect(facts.missing_data.length).toBeGreaterThan(0);
    // Raw telemetry must be nested under raw_supporting_telemetry.
    expect(facts).toHaveProperty("raw_supporting_telemetry");
    expect(facts.raw_supporting_telemetry).toHaveProperty("cost_summary");
    expect(facts.raw_supporting_telemetry).toHaveProperty("effective_prompt_context");
    expect(facts.raw_supporting_telemetry).toHaveProperty("instruction_sources");
    expect(facts.raw_supporting_telemetry).toHaveProperty("tool_usage");
    expect(facts.raw_supporting_telemetry).toHaveProperty("skill_usage");
    expect(facts.raw_supporting_telemetry).toHaveProperty("developer_behavior_signals");
    expect(facts.raw_supporting_telemetry).toHaveProperty("agent_behavior_signals");
    expect(facts.raw_supporting_telemetry).toHaveProperty("model_fit_data");
    expect(facts.raw_supporting_telemetry).toHaveProperty("auto_mode_data");
    expect(facts.raw_supporting_telemetry).toHaveProperty("optimization_opportunities");
    // Developer signals must distinguish visible vs effective specificity.
    expect(facts.raw_supporting_telemetry.developer_behavior_signals).toHaveProperty("visible_prompt_specificity");
    expect(facts.raw_supporting_telemetry.developer_behavior_signals).toHaveProperty("effective_prompt_specificity");
    // Missing_data entries use the new field shape.
    expect(facts.missing_data[0]).toHaveProperty("why_it_matters_for_developer_report");
    expect(facts.missing_data[0]).toHaveProperty("future_instrumentation");
  });

  it("includes generic spec-aligned blocks: workflow phases, agent loop, tool result size, baseline placeholder", () => {
    const out = buildLlmAnalysisPrompt(analysis);
    const match = out.match(/## Structured facts \(JSON\)[\s\S]*?```json\n([\s\S]*?)\n```/);
    const facts = JSON.parse(match![1]);
    // Workflow phase analysis.
    expect(facts.workflow_phase_analysis).toHaveProperty("available");
    if (facts.workflow_phase_analysis.available) {
      expect(facts.workflow_phase_analysis).toHaveProperty("per_turn");
      expect(facts.workflow_phase_analysis).toHaveProperty("phases");
      expect(facts.workflow_phase_analysis).toHaveProperty("largest_cost_phase");
      expect(facts.workflow_phase_analysis).toHaveProperty("phase_detection_method");
      // Per-turn entries must have phase_mix (top-2 phases with weights).
      const sample = facts.workflow_phase_analysis.per_turn[0];
      expect(sample).toHaveProperty("primary_phase");
      expect(sample).toHaveProperty("phase_mix");
      expect(Array.isArray(sample.phase_mix)).toBe(true);
    }
    // Agent loop efficiency.
    expect(facts.agent_loop_efficiency).toHaveProperty("chat_calls");
    expect(facts.agent_loop_efficiency).toHaveProperty("no_tool_no_visible_output_calls");
    expect(facts.agent_loop_efficiency).toHaveProperty("call_shape_assessment");
    expect(facts.agent_loop_efficiency).toHaveProperty("recommended_target_shape");
    // Tool result size analysis with explicit granularity caveat.
    expect(facts.tool_result_size_analysis).toHaveProperty("granularity");
    expect(facts.tool_result_size_analysis).toHaveProperty("granularity_caveat");
    expect(facts.tool_result_size_analysis).toHaveProperty("per_turn");
    expect(facts.tool_result_size_analysis).toHaveProperty("largest_turns");
    expect(facts.tool_result_size_analysis).toHaveProperty("bloat_assessment");
    // Baseline comparison placeholder (no baseline supplied).
    expect(facts.baseline_comparison).toHaveProperty("available");
    expect(facts.baseline_comparison.available).toBe(false);
    expect(facts.baseline_comparison).toHaveProperty("reason");
  });

  it("includes cross-cutting analyst guidance (iteration, control surface, phase, quality, automation, generality)", () => {
    const out = buildLlmAnalysisPrompt(analysis);
    expect(out).toContain("Cross-cutting analyst guidance");
    expect(out).toContain("Iteration-aware analysis");
    expect(out).toContain("Experiment validity check");
    expect(out).toContain("Control-surface discipline");
    expect(out).toContain("Phase-aware diagnosis");
    expect(out).toContain("Loop-shape diagnosis");
    expect(out).toContain("Quality-aware model guidance");
    expect(out).toContain("Automation-boundary diagnosis");
    expect(out).toContain("Generality");
  });

  it("emits experiment_validity placeholder when no expected setup is provided", () => {
    const out = buildLlmAnalysisPrompt(analysis);
    const match = out.match(/## Structured facts \(JSON\)[\s\S]*?```json\n([\s\S]*?)\n```/);
    const facts = JSON.parse(match![1]);
    expect(facts.experiment_validity.available).toBe(false);
    expect(facts.experiment_validity.reason).toMatch(/expected setup/i);
  });

  it("detects mismatches when expected setup conflicts with actual run", () => {
    const out = buildLlmAnalysisPrompt(analysis, {
      expected: { modelName: "definitely-not-the-model-used-xyz" },
    });
    const match = out.match(/## Structured facts \(JSON\)[\s\S]*?```json\n([\s\S]*?)\n```/);
    const facts = JSON.parse(match![1]);
    expect(facts.experiment_validity.available).toBe(true);
    expect(facts.experiment_validity.valid_for_model_evaluation).toBe(false);
    expect(facts.experiment_validity.mismatches.some((m: { field: string }) => m.field === "model")).toBe(true);
  });

  it("groups recommendations by surface and marks out-of-scope surfaces as not controllable", () => {
    const out = buildLlmAnalysisPrompt(analysis, {
      outOfScopeSurfaces: ["model_selection"],
    });
    const match = out.match(/## Structured facts \(JSON\)[\s\S]*?```json\n([\s\S]*?)\n```/);
    const facts = JSON.parse(match![1]);
    expect(facts.control_surface_analysis.available).toBe(true);
    expect(Array.isArray(facts.control_surface_analysis.surfaces)).toBe(true);
    const modelSurface = facts.control_surface_analysis.surfaces.find((s: { surface: string }) => s.surface === "model_selection");
    if (modelSurface) {
      expect(modelSurface.controllable).toBe(false);
    }
    expect(facts.control_surface_analysis.external_or_not_controllable.some((e: { surface: string }) => e.surface === "model_selection")).toBe(true);
  });
});
