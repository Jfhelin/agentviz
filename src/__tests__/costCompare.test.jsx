// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import CostCompare from "../components/CostCompare.jsx";

function findByText(container, text) {
  return Array.from(container.querySelectorAll("*")).find(function (node) {
    return node.textContent && node.textContent.includes(text);
  }) || null;
}

function makeSession(label, totalCost, llmCallCount, finalAnswer) {
  return {
    file: label,
    metadata: {
      costAnalysis: {
        prompts: Array.from({ length: llmCallCount }, function (_, i) {
          var promptTokens = 1000;
          var fresh = i === 0 ? 1000 : 50;
          var cached = i === 0 ? 0 : 950;
          var output = 100;
          var cost = totalCost / llmCallCount;
          return {
            index: i,
            cost: cost,
            output: output,
            cached: cached,
            fresh: fresh,
            cacheWrite: i === 0 ? 1000 : 0,
            promptTokens: promptTokens,
            llmCount: 1,
            label: i === 0 ? "user prompt" : "follow up",
            events: [{
              name: "panel/editAgent",
              model: "claude-sonnet-4.5",
              cost: cost,
              output: output,
              cached: cached,
              fresh: fresh,
              cacheWrite: i === 0 ? 1000 : 0,
              promptTokens: promptTokens,
              components: { system: 500, tool_defs: 400, history: 0, tool_results: 0, current: 100, output: output },
              responsePreview: finalAnswer,
              currentText: "do the thing",
              systemPreview: "You are a helpful assistant.",
              systemChars: "You are a helpful assistant.".length,
              systemHash: "abc12345",
              category: "primary",
              kind: "llm",
            }],
          };
        }),
        totals: {
          promptTokens: 1000 * llmCallCount,
          output: 100 * llmCallCount,
          cached: llmCallCount > 1 ? 950 * (llmCallCount - 1) : 0,
          fresh: 1000 + 50 * (llmCallCount - 1),
          cacheWrite: 1000,
          cost: totalCost,
          llmCalls: llmCallCount,
          toolCalls: 0,
          cacheHitRate: 0.5,
        },
      },
    },
  };
}

describe("CostCompare", function () {
  beforeEach(function () {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    document.body.innerHTML = "";
  });
  afterEach(function () { document.body.innerHTML = ""; });

  it("renders header strip, behavioral KPIs, and divergence split", async function () {
    var container = document.createElement("div");
    document.body.appendChild(container);
    var root = createRoot(container);
    var a = makeSession("run-a.json", 0.04, 3, "Paris.");
    var b = makeSession("run-b.json", 0.05, 3, "Paris.");

    await act(async function () { root.render(<CostCompare sessionA={a} sessionB={b} />); });

    expect(findByText(container, "run-a")).not.toBeNull();
    expect(findByText(container, "run-b")).not.toBeNull();
    expect(findByText(container, "Behavioral KPIs")).not.toBeNull();
    expect(findByText(container, "Pre- vs post-divergence")).not.toBeNull();
    expect(findByText(container, "Per-call breakdown")).not.toBeNull();
    expect(findByText(container, "Input vs. output, side by side")).not.toBeNull();

    await act(async function () { root.unmount(); });
  });

  it("renders an empty-state message when either session lacks costAnalysis", async function () {
    var container = document.createElement("div");
    document.body.appendChild(container);
    var root = createRoot(container);
    var a = { file: "no-cost.json", metadata: {} };
    var b = makeSession("run-b.json", 0.05, 3, "Paris.");

    await act(async function () { root.render(<CostCompare sessionA={a} sessionB={b} />); });

    expect(findByText(container, "Cost data not available")).not.toBeNull();
    expect(findByText(container, "copilot_all_prompts_")).not.toBeNull();

    await act(async function () { root.unmount(); });
  });

  it("exposes the LLM-analysis export button", async function () {
    var container = document.createElement("div");
    document.body.appendChild(container);
    var root = createRoot(container);
    var a = makeSession("run-a.json", 0.04, 3, "Paris.");
    var b = makeSession("run-b.json", 0.05, 3, "Paris.");

    await act(async function () { root.render(<CostCompare sessionA={a} sessionB={b} />); });

    expect(findByText(container, "Copy for LLM analysis")).not.toBeNull();

    await act(async function () { root.unmount(); });
  });
});
