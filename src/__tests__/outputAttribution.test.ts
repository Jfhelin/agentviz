import { describe, expect, it } from "vitest";
import { attributeOutputTokens } from "../lib/outputAttribution";

describe("attributeOutputTokens", () => {
  it("uses reported reasoning tokens before estimating other buckets", () => {
    expect(attributeOutputTokens({
      totalTokens: 100,
      reportedReasoningTokens: 40,
      visibleChars: 300,
      thinkingChars: 9999,
      toolArgumentChars: 100,
    })).toEqual({
      visible: 45,
      reasoning: 40,
      toolArguments: 15,
      unattributed: 0,
      reasoningSource: "reported",
    });
  });

  it("estimates captured buckets and leaves unobserved output unattributed", () => {
    const result = attributeOutputTokens({
      totalTokens: 11,
      visibleChars: 5,
      thinkingChars: 3,
      toolArgumentChars: 2,
    });
    expect(result).toEqual({
      visible: 2,
      reasoning: 1,
      toolArguments: 1,
      unattributed: 7,
      reasoningSource: "estimated",
    });
    expect(result.visible + result.reasoning + result.toolArguments + result.unattributed).toBe(11);
  });

  it("keeps uncaptured output honest as unattributed", () => {
    expect(attributeOutputTokens({ totalTokens: 17 })).toEqual({
      visible: 0,
      reasoning: 0,
      toolArguments: 0,
      unattributed: 17,
      reasoningSource: "none",
    });
  });

  it("does not inflate a short visible reply to fill reported output", () => {
    expect(attributeOutputTokens({ totalTokens: 100, visibleChars: 4 })).toEqual({
      visible: 1,
      reasoning: 0,
      toolArguments: 0,
      unattributed: 99,
      reasoningSource: "none",
    });
  });

  it("clamps invalid and oversized values", () => {
    expect(attributeOutputTokens({
      totalTokens: 5.4,
      reportedReasoningTokens: 99,
      visibleChars: -3,
    })).toEqual({
      visible: 0,
      reasoning: 5,
      toolArguments: 0,
      unattributed: 0,
      reasoningSource: "reported",
    });
  });
});
