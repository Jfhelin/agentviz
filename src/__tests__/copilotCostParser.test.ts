import { describe, expect, it } from "vitest";
import { detectFormat, parseSession } from "../lib/parseSession";
import { detectCopilotPrompts, parseCopilotPromptsJSON } from "../lib/copilotCostParser";

function fixture() {
  return JSON.stringify([
    {
      request: {
        model: "gpt-4.1",
        messages: [
          { role: "system", content: "You are a coding assistant." },
          { role: "user", content: "Build a parser" },
        ],
        tools: [{ type: "function", function: { name: "read_file", parameters: { type: "object" } } }],
      },
      response: {
        usage: {
          prompt_tokens: 1000,
          completion_tokens: 120,
          prompt_tokens_details: { cached_tokens: 200 },
          cache_creation_input_tokens: 50,
        },
      },
    },
    {
      request: {
        model: "gpt-4.1",
        messages: [
          { role: "system", content: "You are a coding assistant." },
          { role: "assistant", content: "I can do that." },
          { role: "user", content: "Now build the UI" },
        ],
        tools: [{ type: "function", function: { name: "read_file", parameters: { type: "object" } } }],
      },
      response: {
        usage: {
          input_tokens: 1800,
          output_tokens: 240,
          input_tokens_details: { cached_tokens: 900 },
          cache_write_input_tokens: 20,
        },
      },
    },
  ]);
}

describe("detectCopilotPrompts", function () {
  it("detects copilot_all_prompts style exports", function () {
    expect(detectCopilotPrompts(fixture())).toBe(true);
    expect(detectFormat(fixture())).toBe("copilot-prompts");
  });

  it("rejects unrelated JSON", function () {
    expect(detectCopilotPrompts(JSON.stringify({ version: 1, requests: [] }))).toBe(false);
  });
});

describe("parseCopilotPromptsJSON", function () {
  it("normalizes prompt calls into events and turns", function () {
    const parsed = parseCopilotPromptsJSON(fixture());
    expect(parsed).not.toBeNull();
    expect(parsed!.events).toHaveLength(2);
    expect(parsed!.turns).toHaveLength(2);
    expect(parsed!.events[0].text).toBe("Build a parser");
    expect(parsed!.events[0].agent).toBe("user");
    expect(parsed!.events[1].text).toBe("Now build the UI");
    expect(parsed!.metadata.format).toBe("copilot-prompts");
  });

  it("extracts token usage, model usage, tools, and context breakdown", function () {
    const parsed = parseSession(fixture());
    expect(parsed).not.toBeNull();
    expect(parsed!.metadata.primaryModel).toBe("gpt-4.1");
    expect(parsed!.metadata.tokenUsage).toMatchObject({
      inputTokens: 2800,
      outputTokens: 360,
      cacheRead: 1100,
      cacheWrite: 70,
    });
    expect(parsed!.metadata.totalCost).toBeGreaterThan(0);
    expect((parsed!.events[0].raw as any).costPrompt.toolNames).toEqual(["read_file"]);
    expect((parsed!.events[1].raw as any).costPrompt.contextBreakdown.history).toBeGreaterThan(0);
  });

  it("supports wrapper objects with prompts arrays", function () {
    const wrapped = JSON.stringify({ prompts: JSON.parse(fixture()) });
    const parsed = parseCopilotPromptsJSON(wrapped);
    expect(parsed!.metadata.promptCallCount).toBe(2);
  });

  it("truncates prompt text exceeding MAX_DISPLAY_TEXT_LENGTH", function () {
    const longPrompt = JSON.stringify([
      {
        request: {
          model: "gpt-4.1",
          messages: [
            { role: "user", content: "x".repeat(5000) },
          ],
        },
        response: {
          usage: {
            prompt_tokens: 1000,
            completion_tokens: 100,
          },
        },
      },
    ]);
    const parsed = parseCopilotPromptsJSON(longPrompt);
    expect(parsed).not.toBeNull();
    expect(parsed!.events[0].text.length).toBe(4000);
    expect(parsed!.events[0].text.endsWith("…")).toBe(true);
  });

  it("flattens nested logs[].kind==='request' exports into per-call events", function () {
    // This mirrors the real ~/CopilotLogExports/*.json export shape produced by
    // the Copilot Chat export tooling: one entry per user prompt, with all
    // model requests nested inside .logs[] and usage on metadata.usage.
    const nested = JSON.stringify({
      exportedAt: "2026-05-26T08:33:05.464Z",
      totalPrompts: 1,
      prompts: [
        {
          prompt: "Refactor the cart code",
          promptId: "p1",
          logs: [
            { id: "t1", kind: "toolCall", tool: "read_file", args: {}, time: "2026-05-26T08:33:00Z" },
            {
              id: "r1",
              kind: "request",
              type: "ChatMLSuccess",
              name: "panel/editAgent",
              metadata: {
                model: "claude-sonnet-4.6",
                startTime: "2026-05-26T08:33:01Z",
                endTime: "2026-05-26T08:33:05Z",
                duration: 4000,
                usage: {
                  prompt_tokens: 12000,
                  completion_tokens: 800,
                  prompt_tokens_details: { cached_tokens: 10000, cache_creation_input_tokens: 200 },
                },
                tools: [{ name: "read_file", input_schema: { type: "object" } }],
              },
              requestMessages: { messages: [{ role: 0, content: ["sys"] }, { role: 1, content: ["x"] }] },
              response: { type: "ChatMLSuccess", message: { 0: "" } },
            },
            {
              id: "r2",
              kind: "request",
              type: "ChatMLSuccess",
              name: "panel/editAgent",
              metadata: {
                model: "claude-sonnet-4.6",
                duration: 3000,
                usage: { prompt_tokens: 13000, completion_tokens: 600 },
                tools: [],
              },
              requestMessages: { messages: [] },
              response: { type: "ChatMLSuccess", message: { 0: "" } },
            },
          ],
        },
      ],
    });
    expect(detectCopilotPrompts(nested)).toBe(true);
    const parsed = parseCopilotPromptsJSON(nested);
    expect(parsed).not.toBeNull();
    // Two request logs → two synthesized calls/events.
    expect(parsed!.events).toHaveLength(2);
    // User-facing prompt text is preserved on every synthesized call so
    // CostView's "user message" column doesn't show numeric-role gibberish.
    expect(parsed!.events[0].text).toBe("Refactor the cart code");
    expect(parsed!.events[1].text).toBe("Refactor the cart code");
    expect(parsed!.metadata.primaryModel).toBe("claude-sonnet-4.6");
    expect(parsed!.metadata.tokenUsage).toMatchObject({
      inputTokens: 25000,
      outputTokens: 1400,
      cacheRead: 10000,
      cacheWrite: 200,
    });
  });
});
