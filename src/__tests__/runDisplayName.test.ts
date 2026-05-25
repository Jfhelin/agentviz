import { describe, it, expect } from "vitest";
import { prettifyRunName, inferTechniqueFromRunNames } from "../lib/runDisplayName";

describe("prettifyRunName", () => {
  it("strips path, copilot prefix, and .json extension", () => {
    expect(prettifyRunName("/foo/bar/copilot_all_prompts_caveman.json")).toBe("caveman");
  });
  it("reformats ISO-ish timestamps", () => {
    expect(prettifyRunName("copilot_all_prompts_2026-04-29T14-41-16.json")).toBe("2026-04-29 14:41");
  });
  it("returns 'session' for empty input", () => {
    expect(prettifyRunName("")).toBe("session");
    expect(prettifyRunName(null)).toBe("session");
    expect(prettifyRunName(undefined)).toBe("session");
  });
  it("is idempotent on already-prettified names", () => {
    expect(prettifyRunName("munich3-baseline")).toBe("munich3-baseline");
    expect(prettifyRunName(prettifyRunName("munich3-baseline"))).toBe("munich3-baseline");
  });
});

describe("inferTechniqueFromRunNames", () => {
  it("extracts shared scenario and variant when names share a prefix", () => {
    const h = inferTechniqueFromRunNames("munich3-baseline", "munich3-no-tool-defs");
    expect(h.sharedContext).toBe("munich3");
    expect(h.variantA).toBe("baseline");
    expect(h.variantB).toBe("no-tool-defs");
    expect(h.hypothesis).toBe("A=baseline vs B=no-tool-defs (shared scenario: munich3)");
  });

  it("extracts shared scenario from a shared suffix", () => {
    const h = inferTechniqueFromRunNames("baseline-receipts", "no-tools-receipts");
    expect(h.sharedContext).toBe("receipts");
    expect(h.variantA).toBe("baseline");
    expect(h.variantB).toBe("no-tools");
    expect(h.hypothesis).toBe("A=baseline vs B=no-tools (shared scenario: receipts)");
  });

  it("falls back to whole-name hypothesis when there is no shared context", () => {
    const h = inferTechniqueFromRunNames("caveman", "polite");
    expect(h.sharedContext).toBeNull();
    expect(h.hypothesis).toBe("A=caveman vs B=polite");
  });

  it("returns no hypothesis when both names are pure timestamps", () => {
    const h = inferTechniqueFromRunNames(
      "copilot_all_prompts_2026-04-29T14-41-16.json",
      "copilot_all_prompts_2026-04-30T09-22-04.json",
    );
    expect(h.hypothesis).toBeNull();
  });

  it("strips trailing date/version noise from shared context and variants", () => {
    const h = inferTechniqueFromRunNames(
      "munich3-baseline-2026-04-29",
      "munich3-with-script-2026-04-30",
    );
    expect(h.sharedContext).toBe("munich3");
    expect(h.variantA).toBe("baseline");
    expect(h.variantB).toBe("with-script");
    expect(h.hypothesis).toContain("shared scenario: munich3");
  });

  it("does not invent a hypothesis when only noise tokens differ", () => {
    const h = inferTechniqueFromRunNames("munich3-run-1", "munich3-run-2");
    // "1" and "2" are noise, "run" is noise -- nothing meaningful differs.
    expect(h.hypothesis).toBeNull();
  });

  it("uses prettified names in the hypothesis even when given raw paths", () => {
    const h = inferTechniqueFromRunNames(
      "/exports/copilot_all_prompts_baseline.json",
      "/exports/copilot_all_prompts_no-tools.json",
    );
    expect(h.nameA).toBe("baseline");
    expect(h.nameB).toBe("no-tools");
    expect(h.hypothesis).toBe("A=baseline vs B=no-tools");
  });
});
