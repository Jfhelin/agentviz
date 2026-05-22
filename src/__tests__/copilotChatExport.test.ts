import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  categorizeCallName,
  detectCopilotChatExport,
  OVERHEAD_CALL_NAMES,
  parseCopilotChatExport,
} from "../lib/copilotChatExportParser";
import { detectFormat, parseSession } from "../lib/parseSession";

function loadFixture(): string {
  const path = join(__dirname, "fixtures", "copilot-chat-export-minimal.json");
  return readFileSync(path, "utf8");
}

describe("copilotChatExportParser", () => {
  describe("detection", () => {
    it("detects the real chat export shape via totalPrompts + prompts[].logs", () => {
      expect(detectCopilotChatExport(loadFixture())).toBe(true);
    });

    it("rejects the flat copilot-prompts shape (request/response per entry)", () => {
      const flat = JSON.stringify([
        { request: { messages: [] }, response: { usage: { prompt_tokens: 1, completion_tokens: 1 } } },
      ]);
      expect(detectCopilotChatExport(flat)).toBe(false);
    });

    it("rejects malformed JSON", () => {
      expect(detectCopilotChatExport("not json")).toBe(false);
    });

    it("rejects an object without prompts array", () => {
      expect(detectCopilotChatExport(JSON.stringify({ exportedAt: "x" }))).toBe(false);
    });

    it("is routed by detectFormat before copilot-prompts", () => {
      expect(detectFormat(loadFixture())).toBe("copilot-chat-export");
    });
  });

  describe("parsing", () => {
    it("emits one event per kind=request log (toolCall logs are skipped)", () => {
      const parsed = parseCopilotChatExport(loadFixture());
      expect(parsed).not.toBeNull();
      // 4 log entries, 1 of which is kind=toolCall -> 3 events
      expect(parsed!.events).toHaveLength(3);
    });

    it("returns null when no request logs carry usage", () => {
      const empty = JSON.stringify({
        totalPrompts: 1,
        prompts: [{ prompt: "x", logs: [{ kind: "toolCall" }] }],
      });
      expect(parseCopilotChatExport(empty)).toBeNull();
    });

    it("extracts usage including nested cache_creation_input_tokens", () => {
      const parsed = parseCopilotChatExport(loadFixture());
      const claudeWriteCall = parsed!.events[1];
      expect(claudeWriteCall.model).toBe("claude-sonnet-4.6");
      expect(claudeWriteCall.tokenUsage).toMatchObject({
        inputTokens: 5000,
        outputTokens: 450,
        cacheRead: 0,
        cacheWrite: 4800, // nested in prompt_tokens_details
      });
    });

    it("extracts cache reads from prompt_tokens_details.cached_tokens", () => {
      const parsed = parseCopilotChatExport(loadFixture());
      const claudeReadCall = parsed!.events[2];
      expect(claudeReadCall.tokenUsage).toMatchObject({
        inputTokens: 6200,
        cacheRead: 4500,
        cacheWrite: 1500,
      });
    });

    it("emits the upstream costPrompt contract (messages, tools, toolNames, contextBreakdown)", () => {
      const parsed = parseCopilotChatExport(loadFixture());
      const event = parsed!.events[1];
      const costPrompt: any = (event.raw as any).costPrompt;
      expect(costPrompt).toBeDefined();
      expect(Array.isArray(costPrompt.messages)).toBe(true);
      expect(Array.isArray(costPrompt.tools)).toBe(true);
      expect(Array.isArray(costPrompt.toolNames)).toBe(true);
      expect(costPrompt.contextBreakdown).toMatchObject({
        system: expect.any(Number),
        tools: expect.any(Number),
        history: expect.any(Number),
        toolResults: expect.any(Number),
        user: expect.any(Number),
        total: expect.any(Number),
      });
      expect(costPrompt.contextBreakdown.total).toBe(
        costPrompt.contextBreakdown.system
          + costPrompt.contextBreakdown.tools
          + costPrompt.contextBreakdown.history
          + costPrompt.contextBreakdown.toolResults
          + costPrompt.contextBreakdown.user,
      );
    });

    it("categorizes overhead calls (title, promptCategorization) separately", () => {
      const parsed = parseCopilotChatExport(loadFixture());
      const titleCall = parsed!.events[0];
      const overheadMeta: any = (titleCall.raw as any).costPrompt;
      expect(overheadMeta.callName).toBe("title");
      expect(overheadMeta.category).toBe("overhead");

      const primaryCall = parsed!.events[1];
      const primaryMeta: any = (primaryCall.raw as any).costPrompt;
      expect(primaryMeta.category).toBe("primary");
    });

    it("populates session metadata with format=copilot-chat-export", () => {
      const parsed = parseCopilotChatExport(loadFixture());
      expect(parsed!.metadata.format).toBe("copilot-chat-export");
      expect(parsed!.metadata.promptCallCount).toBe(2);
      expect(parsed!.metadata.totalEvents).toBe(3);
      // 2 distinct models seen across events
      expect(Object.keys(parsed!.metadata.models || {}).sort()).toEqual([
        "claude-sonnet-4.6",
        "gpt-4o-mini-2024-07-18",
      ]);
    });

    it("computes a non-zero totalCost using pricing.js", () => {
      const parsed = parseCopilotChatExport(loadFixture());
      expect(parsed!.metadata.totalCost).toBeGreaterThan(0);
    });

    it("handles tool result messages (role=3) as toolResults in the breakdown", () => {
      const parsed = parseCopilotChatExport(loadFixture());
      const lastCall = parsed!.events[2];
      const cb: any = (lastCall.raw as any).costPrompt.contextBreakdown;
      expect(cb.toolResults).toBeGreaterThan(0);
    });

    it("ignores type=3 cache-marker parts when computing breakdown text", () => {
      // The fixture's role=1 user message has a cache marker part; only the
      // text part should contribute to the breakdown.
      const parsed = parseCopilotChatExport(loadFixture());
      const event = parsed!.events[1];
      const cb: any = (event.raw as any).costPrompt.contextBreakdown;
      // The last user message text is "Please help with my task." (~6 tokens).
      // Cache marker contributes nothing.
      expect(cb.user).toBeGreaterThan(0);
      expect(cb.user).toBeLessThan(20);
    });
  });

  describe("categorizeCallName", () => {
    it("classifies known overhead names", () => {
      expect(categorizeCallName("title")).toBe("overhead");
      expect(categorizeCallName("promptCategorization")).toBe("overhead");
    });
    it("classifies primary names", () => {
      expect(categorizeCallName("panel/editAgent")).toBe("primary");
      expect(categorizeCallName("")).toBe("primary");
      expect(categorizeCallName(null)).toBe("primary");
    });
    it("OVERHEAD_CALL_NAMES is a non-empty Set", () => {
      expect(OVERHEAD_CALL_NAMES.size).toBeGreaterThan(0);
      expect(OVERHEAD_CALL_NAMES.has("title")).toBe(true);
    });
  });

  describe("parseSession integration", () => {
    it("routes the fixture through parseSession correctly", () => {
      const parsed = parseSession(loadFixture());
      expect(parsed).not.toBeNull();
      expect(parsed!.metadata.format).toBe("copilot-chat-export");
      expect(parsed!.events.length).toBe(3);
    });
  });
});
