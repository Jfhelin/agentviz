import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { parseSession, detectFormat } from "../lib/parseSession";

// Minimal in-tree fixture (committed). Always available.
const minimalPath = resolve(
  __dirname,
  "fixtures/copilot-chat-export-minimal.json",
);

// Optional larger real-world fixture (gitignored, local only). Tests that
// reference this skip when missing.
const realFixturePath = resolve(
  __dirname,
  "../../test/fixtures/copilot-chat-export/sample.json",
);

describe("copilot chat export parser (minimal fixture)", () => {
  const text = readFileSync(minimalPath, "utf8");

  it("detects the export format", () => {
    expect(detectFormat(text)).toBe("copilot-chat-export");
  });

  it("parses prompts, calls, and cost analysis", () => {
    const parsed = parseSession(text);
    expect(parsed).not.toBeNull();
    const ca = (parsed as any).metadata.costAnalysis;
    expect(ca).toBeDefined();
    expect(ca.prompts.length).toBe(2);
    expect(ca.totals.llmCalls).toBe(2);
  });

  it("flags a tool-defs change as an unexpected cache miss", () => {
    const parsed = parseSession(text);
    const ca = (parsed as any).metadata.costAnalysis;
    // Second call has the same model and a non-trivial prior cache, but
    // tool_search's cache_control marker was dropped — should flag a miss.
    const p2 = ca.prompts[1];
    const llm2 = p2.events.find((e: any) => e.kind === "llm");
    expect(llm2.unexpectedMiss).toBe(true);
    expect(llm2.cacheMissDiag).toBeTruthy();
    expect(llm2.cacheMissDiag.toolDefsChanged).toBeGreaterThanOrEqual(1);
  });
});

describe("copilot chat export parser (real-world fixture)", () => {
  if (!existsSync(realFixturePath)) {
    it.skip("real-world fixture not present (gitignored)", () => {});
    return;
  }

  const text = readFileSync(realFixturePath, "utf8");

  it("detects the export format", () => {
    expect(detectFormat(text)).toBe("copilot-chat-export");
  });

  it("flags model switches and unexpected cache misses", () => {
    const parsed = parseSession(text);
    const ca = (parsed as any).metadata.costAnalysis;
    const anyModelSwitch = ca.prompts.some(
      (p: any) => p.prompt.modelSwitchedIn,
    );
    const anyMiss = ca.prompts.some(
      (p: any) => p.prompt.unexpectedMissCount > 0,
    );
    expect(anyModelSwitch).toBe(true);
    expect(anyMiss).toBe(true);
  });

});

describe("overhead call categorization", () => {
  function buildExport(): string {
    const baseUsage = {
      prompt_tokens: 100,
      completion_tokens: 5,
      cache_creation_input_tokens: 0,
      prompt_tokens_details: { cached_tokens: 0 },
    };
    return JSON.stringify({
      exportedAt: "2026-04-29T14:41:16Z",
      totalPrompts: 1,
      totalLogEntries: 3,
      prompts: [
        {
          prompt: "Hello",
          promptId: "prompt-0",
          logCount: 3,
          logs: [
            {
              id: "req-main",
              kind: "request",
              name: "panel/editAgent",
              metadata: { model: "claude-sonnet-4.6", duration: 1000, usage: baseUsage, tools: [] },
              requestMessages: { messages: [{ role: 1, content: "Hello" }] },
              response: { type: "success", message: ["Hi there"] },
            },
            {
              id: "req-title",
              kind: "request",
              name: "title",
              metadata: { model: "gpt-4o-mini", duration: 200, usage: baseUsage, tools: [] },
              requestMessages: { messages: [{ role: 1, content: "Hello" }] },
              response: { type: "success", message: ["General greeting"] },
            },
            {
              id: "req-cat",
              kind: "request",
              name: "promptCategorization",
              metadata: { model: "gpt-4o-mini", duration: 150, usage: baseUsage, tools: [] },
              requestMessages: { messages: [{ role: 1, content: "Hello" }] },
              response: { type: "success", message: [""] },
            },
          ],
        },
      ],
    });
  }

  it("tags title and promptCategorization as overhead, panel/editAgent as primary", () => {
    const parsed = parseSession(buildExport());
    expect(parsed).not.toBeNull();
    const events = (parsed as any).metadata.costAnalysis.prompts[0].events;
    const llm = events.filter((e: any) => e.kind === "llm");
    expect(llm).toHaveLength(3);
    expect(llm[0].name).toBe("panel/editAgent");
    expect(llm[0].category).toBe("primary");
    expect(llm[1].name).toBe("title");
    expect(llm[1].category).toBe("overhead");
    expect(llm[2].name).toBe("promptCategorization");
    expect(llm[2].category).toBe("overhead");
  });

  it("captures a response preview from the standard message[] shape", () => {
    const parsed = parseSession(buildExport());
    const events = (parsed as any).metadata.costAnalysis.prompts[0].events;
    const llm = events.filter((e: any) => e.kind === "llm");
    expect(llm[0].responsePreview).toBe("Hi there");
    expect(llm[1].responsePreview).toBe("General greeting");
    // empty-message responses produce a JSON fallback rather than empty string,
    // so the inspector still has something to render.
    expect(llm[2].responsePreview.length).toBeGreaterThan(0);
  });

  it("counts all overhead calls in totals (filtering is purely a UI concern)", () => {
    const parsed = parseSession(buildExport());
    const totals = (parsed as any).metadata.costAnalysis.totals;
    expect(totals.llmCalls).toBe(3);
  });
});

describe("output attribution and tool-result linkage", () => {
  it("uses reported reasoning and keeps output buckets equal to reported output", () => {
    const parsed = parseSession(JSON.stringify({
      totalPrompts: 1,
      totalLogEntries: 2,
      prompts: [{
        prompt: "Update the file",
        promptId: "p-output",
        logs: [
          {
            id: "req-output",
            kind: "request",
            name: "panel/editAgent",
            metadata: {
              model: "claude-sonnet-4.6",
              usage: {
                prompt_tokens: 100,
                completion_tokens: 10,
                prompt_tokens_details: { cached_tokens: 0 },
                completion_tokens_details: { reasoning_tokens: 4 },
              },
              tools: [],
            },
            requestMessages: { messages: [{ role: 1, content: "Update the file" }] },
            response: { type: "success", message: ["Done"] },
          },
          {
            id: "toolu_1",
            kind: "toolCall",
            tool: "replace_string_in_file",
            args: { filePath: "src/a.ts", oldString: "a", newString: "b" },
            thinking: { text: "I should make the smallest edit." },
          },
        ],
      }],
    }));
    const call = (parsed as any).metadata.costAnalysis.prompts[0].events[0];
    const parts = call.outputAttribution;
    expect(parts.reasoning).toBe(4);
    expect(parts.reasoningSource).toBe("reported");
    expect(parts.visible + parts.reasoning + parts.toolArguments + parts.unattributed).toBe(10);
    expect(call.reasoningBlocks[0].text).toContain("smallest edit");
    expect(call.producedToolCalls[0].rawArgs).toContain("src/a.ts");
    expect((parsed as any).metadata.costAnalysis.totals.outputAttribution).toEqual(parts);
  });

  it("pairs reversed tool results by normalized tool-call id", () => {
    const parsed = parseSession(JSON.stringify({
      totalPrompts: 1,
      totalLogEntries: 3,
      prompts: [{
        prompt: "Read both files",
        promptId: "p-tools",
        logs: [
          { id: "toolu_1__vscode-abc", kind: "toolCall", tool: "read_file", args: { filePath: "a.ts" } },
          { id: "toolu_2", kind: "toolCall", tool: "read_file", args: { filePath: "b.ts" } },
          {
            id: "req-after-tools",
            kind: "request",
            name: "panel/editAgent",
            metadata: {
              model: "claude-sonnet-4.6",
              usage: {
                prompt_tokens: 200,
                completion_tokens: 5,
                prompt_tokens_details: { cached_tokens: 0 },
              },
              tools: [],
            },
            requestMessages: {
              messages: [
                {
                  role: 2,
                  content: "",
                  toolCalls: [
                    { id: "toolu_1", function: { name: "read_file", arguments: "{\"filePath\":\"a.ts\"}" } },
                    { id: "toolu_2", function: { name: "read_file", arguments: "{\"filePath\":\"b.ts\"}" } },
                  ],
                },
                { role: 3, toolCallId: "toolu_2", content: "contents of b" },
                { role: 3, toolCallId: "toolu_1", content: "contents of a" },
              ],
            },
            response: { type: "success", message: ["Finished"] },
          },
        ],
      }],
    }));
    const tools = (parsed as any).metadata.costAnalysis.prompts[0].events.filter(
      (event: any) => event.kind === "tool",
    );
    expect(tools[0].resultPreview).toBe("contents of a");
    expect(tools[1].resultPreview).toBe("contents of b");
  });

  it("does not attach stale cumulative results to newer tool calls", () => {
    const request = (id: string, messages: any[]) => ({
      id,
      kind: "request",
      name: "panel/editAgent",
      metadata: {
        model: "claude-sonnet-4.6",
        usage: {
          prompt_tokens: 200,
          completion_tokens: 5,
          prompt_tokens_details: { cached_tokens: 0 },
        },
        tools: [],
      },
      requestMessages: { messages },
      response: { type: "success", message: ["Finished"] },
    });
    const oldResult = { role: 3, toolCallId: "toolu_old", content: "old result" };
    const newResult = { role: 3, toolCallId: "toolu_new", content: "new result" };
    const parsed = parseSession(JSON.stringify({
      totalPrompts: 1,
      totalLogEntries: 5,
      prompts: [{
        prompt: "Read files",
        promptId: "p-stale-results",
        logs: [
          request("req-1", []),
          { id: "toolu_old", kind: "toolCall", tool: "read_file", args: { filePath: "old.ts" } },
          request("req-2", [oldResult]),
          { id: "toolu_new", kind: "toolCall", tool: "read_file", args: { filePath: "new.ts" } },
          request("req-3", [oldResult, newResult]),
        ],
      }],
    }));
    const tools = (parsed as any).metadata.costAnalysis.prompts[0].events.filter(
      (event: any) => event.kind === "tool",
    );
    expect(tools[0].resultPreview).toBe("old result");
    expect(tools[1].resultPreview).toBe("new result");
  });

  it("marks aggregate reasoning provenance as mixed", () => {
    const parsed = parseSession(JSON.stringify({
      totalPrompts: 1,
      totalLogEntries: 3,
      prompts: [{
        prompt: "Use a tool",
        promptId: "p-mixed-reasoning",
        logs: [
          {
            id: "req-estimated",
            kind: "request",
            name: "panel/editAgent",
            metadata: {
              model: "claude-sonnet-4.6",
              usage: { prompt_tokens: 100, completion_tokens: 8, prompt_tokens_details: { cached_tokens: 0 } },
              tools: [],
            },
            requestMessages: { messages: [] },
            response: { type: "success", message: ["Working"] },
          },
          {
            id: "toolu_reasoning",
            kind: "toolCall",
            tool: "read_file",
            args: { filePath: "a.ts" },
            thinking: { text: "Inspect the file first." },
          },
          {
            id: "req-reported",
            kind: "request",
            name: "panel/editAgent",
            metadata: {
              model: "claude-sonnet-4.6",
              usage: {
                prompt_tokens: 120,
                completion_tokens: 6,
                prompt_tokens_details: { cached_tokens: 100 },
                completion_tokens_details: { reasoning_tokens: 2 },
              },
              tools: [],
            },
            requestMessages: { messages: [] },
            response: { type: "success", message: ["Done"] },
          },
        ],
      }],
    }));
    const attribution = (parsed as any).metadata.costAnalysis.totals.outputAttribution;
    expect(attribution.reasoningSource).toBe("mixed");
    expect(
      attribution.visible + attribution.reasoning +
      attribution.toolArguments + attribution.unattributed,
    ).toBe(14);
  });
});
