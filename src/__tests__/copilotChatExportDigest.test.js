import { describe, expect, it } from "vitest";
import {
  buildDigest,
  reconcileOutputAttribution,
} from "../../.github/skills/copilot-chat-export/scripts/digest.mjs";

function request({
  id,
  name = "panel/editAgent",
  model = "claude-sonnet-5",
  promptTokens,
  completionTokens,
  cachedTokens = 0,
  cacheWriteTokens = 0,
  reasoningTokens = 0,
  tools = [],
  response = ["done"],
  time,
}) {
  return {
    id,
    kind: "request",
    name,
    time,
    metadata: {
      model,
      duration: 100,
      usage: {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        cache_creation_input_tokens: cacheWriteTokens,
        prompt_tokens_details: { cached_tokens: cachedTokens },
        completion_tokens_details: { reasoning_tokens: reasoningTokens },
      },
      tools,
    },
    response: { type: "success", message: response },
  };
}

describe("Copilot Chat export digest", () => {
  it("keeps measured usage authoritative and reconciles output exactly", () => {
    const raw = {
      exportedAt: "2026-09-04T12:00:00Z",
      prompts: [{
        prompt: "Edit the file",
        promptId: "parent",
        logs: [
          request({
            id: "r1",
            promptTokens: 2000,
            completionTokens: 20,
            cacheWriteTokens: 1500,
            reasoningTokens: 4,
            response: ["Visible reply"],
            tools: [{ name: "apply_patch", schema: { type: "object" } }],
          }),
          {
            id: "t1",
            kind: "toolCall",
            tool: "apply_patch",
            args: { patch: "abcdefgh" },
            thinking: { text: "reasoning text" },
            response: "ok",
          },
        ],
      }],
    };

    const digest = buildDigest(raw);
    expect(digest.rollups.measuredUsage).toEqual({
      promptTokens: 2000,
      completionTokens: 20,
      cachedTokens: 0,
      cacheWriteTokens: 1500,
      freshTokens: 500,
      totalTokens: 2020,
    });
    const attribution = digest.rollups.outputAttribution;
    expect(Object.values(attribution.reconciled).reduce((a, b) => a + b, 0)).toBe(20);
    expect(attribution.exactTotalMatches).toBe(true);
    expect(attribution.rawApprox.visible).toBeGreaterThan(0);
    expect(attribution.rawApprox.reasoning).toBe(4);
    expect(attribution.rawApprox.toolArguments).toBeGreaterThan(0);
  });

  it("proportionally reconciles over-attribution to the measured total", () => {
    const result = reconcileOutputAttribution(2, {
      visible: 10,
      reasoning: 10,
      toolArguments: 10,
    });
    expect(Object.values(result).reduce((a, b) => a + b, 0)).toBe(2);
    expect(result.unattributedResidual).toBe(0);
  });

  it("preserves measured reasoning while reconciling estimated categories", () => {
    const result = reconcileOutputAttribution(100, {
      visible: 30,
      reasoning: 80,
      toolArguments: 20,
    }, 80);
    expect(result.reasoning).toBe(80);
    expect(Object.values(result).reduce((a, b) => a + b, 0)).toBe(100);
  });

  it("uses per-model cache baselines and diagnoses same-model misses", () => {
    const raw = {
      prompts: [{
        prompt: "First",
        logs: [request({
          id: "r1",
          promptTokens: 2000,
          completionTokens: 5,
          tools: [{ name: "read_file", schema: { version: 1 } }],
          time: "2026-09-04T12:00:00Z",
        })],
      }, {
        prompt: "Second",
        logs: [request({
          id: "r2",
          promptTokens: 2100,
          completionTokens: 5,
          tools: [{ name: "read_file", schema: { version: 2 } }],
          time: "2026-09-04T12:01:00Z",
        })],
      }],
    };

    const digest = buildDigest(raw);
    expect(digest.rollups.cache.unexpectedMissCount).toBe(1);
    expect(digest.rollups.cache.unexpectedMisses[0].cause).toBe("tool-definitions-changed");
    expect(digest.rollups.cache.unexpectedMisses[0].toolDiff.changed).toEqual(["read_file"]);
  });

  it.each(["filePath", "file_path", "filepath", "target_file"])(
    "records file activity from %s tool arguments",
    (pathKey) => {
      const digest = buildDigest({
        prompts: [{
          prompt: "Read a file",
          logs: [{
            kind: "toolCall",
            tool: "read_file",
            args: { [pathKey]: "src/example.js" },
            response: "contents",
          }],
        }],
      });
      expect(digest.files).toEqual([{ path: "src/example.js", calls: 1 }]);
    },
  );

  it("links subagent threads while excluding parent estimates from headlines", () => {
    const childPrompt = "Inspect the parser in detail";
    const raw = {
      prompts: [{
        prompt: "Audit the parser",
        promptId: "parent",
        logs: [
          request({ id: "parent-r", promptTokens: 1000, completionTokens: 10 }),
          {
            id: "spawn-1",
            kind: "toolCall",
            tool: "runSubagent",
            args: { description: "Parser audit", prompt: childPrompt },
            response: "Subagent summary",
            toolMetadata: { modelName: "claude-sonnet-5" },
          },
        ],
      }, {
        prompt: childPrompt,
        promptId: "child",
        logs: [
          request({
            id: "child-r",
            name: "tool/runSubagent",
            promptTokens: 500,
            completionTokens: 8,
          }),
        ],
      }],
    };

    const digest = buildDigest(raw);
    expect(digest.rollups.measuredUsage.promptTokens).toBe(1500);
    expect(digest.rollups.measuredUsage.completionTokens).toBe(18);
    expect(digest.rollups.threads).toEqual({
      rootPrompts: 1,
      subagentPrompts: 1,
      linkedSubagents: 1,
      unresolvedRunSubagentCalls: 0,
    });
    const supplemental = digest.rollups.supplemental.runSubagent;
    expect(supplemental.excludedFromHeadline).toBe(true);
    expect(supplemental.calls[0].accounting).toBe("supplemental-estimate-excluded-from-headline");
    expect(supplemental.calls[0].measuredChildRef).toBe("p1");
    expect(digest.prompts[1].spawnedBy).toBe("p0.l1");
  });
});
