import { describe, it, expect } from "vitest";
import { prettifyRunName } from "../lib/runDisplayName";

describe("prettifyRunName", () => {
  it("strips copilot_all_prompts_ prefix", () => {
    expect(prettifyRunName("copilot_all_prompts_caveman.json")).toBe("caveman");
    expect(prettifyRunName("copilot_all_prompts_polite.json")).toBe("polite");
  });

  it("strips path", () => {
    expect(prettifyRunName("/foo/bar/copilot_all_prompts_caveman.json")).toBe("caveman");
    expect(prettifyRunName("C:\\Users\\x\\copilot_all_prompts_polite.json")).toBe("polite");
  });

  it("reformats ISO-ish timestamps left over after prefix strip", () => {
    expect(prettifyRunName("copilot_all_prompts_2026-04-29T14-41-16.json")).toBe("2026-04-29 14:41");
    expect(prettifyRunName("copilot_all_prompts_2026-05-05T14-22-21.json")).toBe("2026-05-05 14:22");
  });

  it("leaves unrelated names alone", () => {
    expect(prettifyRunName("session-3a8c9d1.jsonl")).toBe("session-3a8c9d1");
    expect(prettifyRunName("my-test.json")).toBe("my-test");
  });

  it("strips known extensions", () => {
    expect(prettifyRunName("foo.JSON")).toBe("foo");
    expect(prettifyRunName("bar.jsonl")).toBe("bar");
    expect(prettifyRunName("baz.txt")).toBe("baz");
  });

  it("falls back gracefully", () => {
    expect(prettifyRunName(null)).toBe("session");
    expect(prettifyRunName(undefined)).toBe("session");
    expect(prettifyRunName("")).toBe("session");
    expect(prettifyRunName("copilot_all_prompts_.json")).toBe("session");
  });

  it("trims residual separators", () => {
    expect(prettifyRunName("copilot_all_prompts__test_.json")).toBe("test");
  });
});
