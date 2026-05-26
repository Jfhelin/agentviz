import { describe, it, expect } from "vitest";
import { extractSystemBlocks } from "../lib/copilotChatExportParser";
import { buildSystemPromptDiff } from "../lib/compareCost";

describe("extractSystemBlocks", () => {
  it("returns an empty list for plain text with no tags", () => {
    expect(extractSystemBlocks("You are an AI assistant.")).toEqual([]);
  });

  it("extracts a simple top-level block", () => {
    const blocks = extractSystemBlocks("<a>hello</a>");
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ tag: "a", attrs: "", key: "a", chars: 5 });
  });

  it("captures attributes in the key", () => {
    const blocks = extractSystemBlocks('<instruction forToolsWithPrefix="mcp_azure">body</instruction>');
    expect(blocks).toHaveLength(1);
    expect(blocks[0].tag).toBe("instruction");
    expect(blocks[0].attrs).toBe('forToolsWithPrefix="mcp_azure"');
    expect(blocks[0].key).toBe('instruction[forToolsWithPrefix="mcp_azure"]');
  });

  it("does not emit nested same-tag blocks at the top level", () => {
    // <a><a>inner</a></a> must produce a single outer block of length 13
    const blocks = extractSystemBlocks("<a><a>inner</a></a>");
    expect(blocks).toHaveLength(1);
    expect(blocks[0].tag).toBe("a");
    expect(blocks[0].chars).toBe("<a>inner</a>".length);
  });

  it("does not recurse into the contents of a top-level block", () => {
    // <skills> contains <skill> children; only <skills> should be reported
    const text = "<skills><skill>A</skill><skill>B</skill></skills>";
    const blocks = extractSystemBlocks(text);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].tag).toBe("skills");
  });

  it("emits sibling top-level blocks separately", () => {
    const blocks = extractSystemBlocks("<a>1</a> some text <b>22</b>");
    expect(blocks.map((b) => b.tag)).toEqual(["a", "b"]);
    expect(blocks[0].chars).toBe(1);
    expect(blocks[1].chars).toBe(2);
  });

  it("skips unmatched opens without exploding", () => {
    const blocks = extractSystemBlocks("<a>orphan <b>real</b>");
    // The first <a> has no close — skipped. <b>real</b> still extracts.
    expect(blocks).toHaveLength(1);
    expect(blocks[0].tag).toBe("b");
  });

  it("truncates bodyPreview at 400 chars", () => {
    const big = "x".repeat(1000);
    const blocks = extractSystemBlocks(`<wrap>${big}</wrap>`);
    expect(blocks[0].chars).toBe(1000);
    expect(blocks[0].bodyPreview.length).toBe(400);
  });
});

describe("buildSystemPromptDiff", () => {
  const mkBlock = (key: string, chars: number, preview = "") => ({
    tag: key.split("[")[0],
    attrs: key.includes("[") ? key.slice(key.indexOf("[") + 1, -1) : "",
    key,
    chars,
    bodyPreview: preview,
  });

  it("returns null when both sides are empty", () => {
    expect(buildSystemPromptDiff([], [])).toBeNull();
  });

  it("marks identical blocks", () => {
    const diff = buildSystemPromptDiff(
      [mkBlock("security", 100)],
      [mkBlock("security", 100)],
    );
    expect(diff).not.toBeNull();
    expect(diff!.rows[0].status).toBe("identical");
    expect(diff!.hasBlockDrift).toBe(false);
  });

  it("flags only-A and only-B blocks", () => {
    const diff = buildSystemPromptDiff(
      [mkBlock('instruction[forToolsWithPrefix="mcp_azure"]', 1800), mkBlock("shared", 500)],
      [mkBlock("shared", 500), mkBlock("newkid", 200)],
    );
    expect(diff).not.toBeNull();
    const byKey = Object.fromEntries(diff!.rows.map((r) => [r.key, r]));
    expect(byKey['instruction[forToolsWithPrefix="mcp_azure"]'].status).toBe("only-A");
    expect(byKey['instruction[forToolsWithPrefix="mcp_azure"]'].delta).toBe(-1800);
    expect(byKey["newkid"].status).toBe("only-B");
    expect(byKey["newkid"].delta).toBe(200);
    expect(byKey["shared"].status).toBe("identical");
    expect(diff!.hasBlockDrift).toBe(true);
  });

  it("flags chars-differ when keys match but sizes diverge", () => {
    const diff = buildSystemPromptDiff(
      [mkBlock("instructions", 31876)],
      [mkBlock("instructions", 31950)],
    );
    expect(diff!.rows[0].status).toBe("chars-differ");
    expect(diff!.rows[0].delta).toBe(74);
    expect(diff!.hasBlockDrift).toBe(true);
  });

  it("sorts rows by absolute delta descending", () => {
    const diff = buildSystemPromptDiff(
      [mkBlock("big", 2000), mkBlock("small", 50), mkBlock("same", 100)],
      [mkBlock("same", 100), mkBlock("big", 1000), mkBlock("small", 60)],
    );
    expect(diff!.rows.map((r) => r.key)).toEqual(["big", "small", "same"]);
  });

  it("sums tagged chars on both sides", () => {
    const diff = buildSystemPromptDiff(
      [mkBlock("a", 100), mkBlock("b", 200)],
      [mkBlock("a", 110), mkBlock("c", 50)],
    );
    expect(diff!.taggedCharsA).toBe(300);
    expect(diff!.taggedCharsB).toBe(160);
    expect(diff!.totalBlockDelta).toBe(-140); // 10 + (-200) + 50
  });

  it("recovers the user's real scenario: 2 missing instruction blocks plus a size tweak", () => {
    const a = [
      mkBlock("instructions", 31876),
      mkBlock('instruction[forToolsWithPrefix="mcp_azure"]', 1848),
      mkBlock('instruction[forToolsWithPrefix="mcp_bicep"]', 463),
      mkBlock("skills", 22891),
    ];
    const b = [
      mkBlock("instructions", 31950),
      mkBlock("skills", 22965),
    ];
    const diff = buildSystemPromptDiff(a, b)!;
    const changed = diff.rows.filter((r) => r.status !== "identical");
    expect(changed).toHaveLength(4); // 2 only-A + 2 chars-differ
    expect(changed.filter((r) => r.status === "only-A")).toHaveLength(2);
    expect(changed.filter((r) => r.status === "chars-differ")).toHaveLength(2);
    // The biggest absolute delta should come first (the missing mcp_azure block)
    expect(changed[0].key).toBe('instruction[forToolsWithPrefix="mcp_azure"]');
    expect(changed[0].delta).toBe(-1848);
  });
});
