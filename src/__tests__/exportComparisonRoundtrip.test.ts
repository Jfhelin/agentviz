// Verifies that the comparison-export payload round-trips correctly:
// raw text -> JSON serialize (jsonSafe) -> embed in HTML -> re-parse out ->
// re-run parser -> compute cost comparison.
//
// This is the core invariant that makes the exported HTML's "Cost" tab work:
// the raw text inside `window.__AGENTVIZ_COMPARE__` must yield the same
// CostAnalysis as if the file had been loaded interactively.
//
// Skipped when the user's real Copilot Chat fixtures aren't on disk.

import { describe, it, expect } from "vitest";
import * as fs from "fs";
import { parseCopilotChatExport } from "../lib/copilotChatExportParser";
import { compareRunsCost } from "../lib/compareCost";

const FIXTURES = {
  caveman: "/Users/jfhelin/.copilot/workspaces/e41f93cd-465a-4313-8701-888682ca72ec/attachments/9be5e028-3b03-41ae-915f-41b83e05bf53-copilot_all_prompts_caveman.json",
  polite:  "/Users/jfhelin/.copilot/workspaces/e41f93cd-465a-4313-8701-888682ca72ec/attachments/729bad37-c16c-4dc1-8231-f47f96d310af-copilot_all_prompts_polite.json",
};

const haveFixtures = Object.values(FIXTURES).every(p => {
  try { fs.accessSync(p); return true; } catch { return false; }
});

// Mirrors src/lib/exportHtml.js:jsonSafe -- serialize a value safely for
// embedding inside a <script> block.
function jsonSafe(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026");
}

const describeReal = haveFixtures ? describe : describe.skip;

describeReal("export comparison round-trip (real fixtures)", () => {
  it("serializes both raw texts, deserializes, re-parses, and produces an identical cost comparison", () => {
    const rawA = fs.readFileSync(FIXTURES.caveman, "utf8");
    const rawB = fs.readFileSync(FIXTURES.polite, "utf8");

    // ---- INTERACTIVE PATH (baseline) ------------------------------------
    const interactiveA = parseCopilotChatExport(rawA);
    const interactiveB = parseCopilotChatExport(rawB);
    const interactiveCmp = compareRunsCost(
      (interactiveA as any).metadata.costAnalysis,
      (interactiveB as any).metadata.costAnalysis,
    )!;

    // ---- EXPORT PATH ----------------------------------------------------
    // What exportHtml.js#exportComparison embeds in the HTML:
    const comparePayload = jsonSafe({
      a: { name: "caveman.json", text: rawA },
      b: { name: "polite.json",  text: rawB },
    });
    // Sanity-check the encoding: no raw </script>, no raw < or >.
    expect(comparePayload).not.toMatch(/<\/script>/i);
    expect(comparePayload).not.toMatch(/[<>&](?!\\)/);

    // Simulate the browser's eval of `window.__AGENTVIZ_COMPARE__ = {payload}`.
    // JSON.parse is the inverse of JSON.stringify; jsonSafe's escapes are a
    // SUBSET of valid JSON unicode escapes, so JSON.parse handles them.
    const decoded = JSON.parse(comparePayload) as {
      a: { name: string; text: string };
      b: { name: string; text: string };
    };
    expect(decoded.a.text).toBe(rawA);
    expect(decoded.b.text).toBe(rawB);

    // Run the parsers on the round-tripped text -- this is what App.jsx's
    // useEffect does via session.handleFile / sessionB.handleFile.
    const exportA = parseCopilotChatExport(decoded.a.text);
    const exportB = parseCopilotChatExport(decoded.b.text);
    const exportCmp = compareRunsCost(
      (exportA as any).metadata.costAnalysis,
      (exportB as any).metadata.costAnalysis,
    )!;

    // ---- ASSERT IDENTICAL ----------------------------------------------
    // Headline numbers must match exactly.
    expect(exportCmp.a.totalCost).toBe(interactiveCmp.a.totalCost);
    expect(exportCmp.b.totalCost).toBe(interactiveCmp.b.totalCost);
    expect(exportCmp.a.llmCallCount).toBe(interactiveCmp.a.llmCallCount);
    expect(exportCmp.b.llmCallCount).toBe(interactiveCmp.b.llmCallCount);
    expect(exportCmp.a.fixedShare).toBe(interactiveCmp.a.fixedShare);
    expect(exportCmp.b.fixedShare).toBe(interactiveCmp.b.fixedShare);

    // Verdict + recommendations must be identical.
    expect(exportCmp.verdict.kind).toBe(interactiveCmp.verdict.kind);
    expect(exportCmp.recommendations.map(r => r.id))
      .toEqual(interactiveCmp.recommendations.map(r => r.id));

    // I/O must match (this is the panel that just got fixed in the previous
    // commit -- regression-guarding it through the export path too).
    expect(exportCmp.userTextA).toBe(interactiveCmp.userTextA);
    expect(exportCmp.userTextB).toBe(interactiveCmp.userTextB);
    expect(exportCmp.finalAnswerA).toBe(interactiveCmp.finalAnswerA);
    expect(exportCmp.finalAnswerB).toBe(interactiveCmp.finalAnswerB);
    expect(exportCmp.userPromptsA).toEqual(interactiveCmp.userPromptsA);
    expect(exportCmp.userPromptsB).toEqual(interactiveCmp.userPromptsB);
    expect(exportCmp.answersEquivalent).toBe(interactiveCmp.answersEquivalent);
  });
});
