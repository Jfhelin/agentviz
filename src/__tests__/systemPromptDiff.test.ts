import { describe, expect, it } from "vitest";
import { extractSystemBlocks } from "../lib/copilotChatExportParser";
import { buildSystemPromptDiff } from "../lib/compareCost";

describe("extractSystemBlocks", () => {
  it("extracts top-level tagged blocks without recursing", () => {
    const blocks = extractSystemBlocks("<skills><skill>A</skill></skills><rules>BC</rules>");
    expect(blocks).toEqual([
      expect.objectContaining({ tag: "skills", attrs: "", key: "skills", chars: 16, bodyPreview: "<skill>A</skill>" }),
      expect.objectContaining({ tag: "rules", attrs: "", key: "rules", chars: 2, bodyPreview: "BC" }),
    ]);
    expect(blocks.every((block) => /^[0-9a-f]{8}$/.test(block.bodyHash))).toBe(true);
  });

  it("uses attributes to disambiguate blocks and skips unmatched tags", () => {
    const blocks = extractSystemBlocks(
      '<broken><instruction forToolsWithPrefix="mcp_azure">body</instruction>',
    );
    expect(blocks).toHaveLength(1);
    expect(blocks[0].key).toBe('instruction[forToolsWithPrefix="mcp_azure"]');
  });

  it("limits previews while preserving full character counts", () => {
    const blocks = extractSystemBlocks(`<large>${"x".repeat(500)}</large>`);
    expect(blocks[0].chars).toBe(500);
    expect(blocks[0].bodyPreview).toHaveLength(400);
  });

  it("keeps repeated blocks as separate occurrences", () => {
    const blocks = extractSystemBlocks("<instruction>first</instruction><instruction>second</instruction>");
    expect(blocks.map((block) => block.key)).toEqual(["instruction", "instruction#2"]);
  });
});

describe("buildSystemPromptDiff", () => {
  const block = (key: string, chars: number) => ({
    tag: key.split("[")[0],
    attrs: "",
    key,
    chars,
    bodyPreview: key,
  });

  it("reports additions, removals, and changed sizes", () => {
    const diff = buildSystemPromptDiff(
      [block("removed", 100), block("changed", 20), block("same", 5)],
      [block("added", 80), block("changed", 30), block("same", 5)],
    )!;
    expect(diff.hasBlockDrift).toBe(true);
    expect(Object.fromEntries(diff.rows.map((row) => [row.key, row.status]))).toEqual({
      removed: "only-A",
      added: "only-B",
      changed: "chars-differ",
      same: "identical",
    });
    expect(diff.totalBlockDelta).toBe(-10);
  });

  it("returns null when neither side exposes blocks", () => {
    expect(buildSystemPromptDiff([], [])).toBeNull();
  });

  it("detects equal-length content changes using full-body hashes", () => {
    const a = extractSystemBlocks(`<rules>${"x".repeat(400)}a</rules>`);
    const b = extractSystemBlocks(`<rules>${"x".repeat(400)}b</rules>`);
    const diff = buildSystemPromptDiff(a, b)!;
    expect(diff.hasBlockDrift).toBe(true);
    expect(diff.rows[0].status).toBe("chars-differ");
    expect(diff.rows[0].delta).toBe(0);
  });

  it("detects changes in the first of repeated blocks", () => {
    const a = extractSystemBlocks("<instruction>first</instruction><instruction>same</instruction>");
    const b = extractSystemBlocks("<instruction>other</instruction><instruction>same</instruction>");
    const diff = buildSystemPromptDiff(a, b)!;
    expect(diff.rows.find((row) => row.key === "instruction")?.status).toBe("chars-differ");
    expect(diff.rows.find((row) => row.key === "instruction#2")?.status).toBe("identical");
  });
});
