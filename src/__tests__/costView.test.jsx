// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import CostView from "../components/CostView.jsx";

function findByText(container, text) {
  return Array.from(container.querySelectorAll("*")).find(function (node) {
    return node.textContent && node.textContent.includes(text);
  }) || null;
}

function buildEvent(index, usage, contextTotal) {
  return {
    t: index,
    agent: "assistant",
    track: "output",
    text: "Call " + (index + 1),
    duration: 1,
    intensity: 0.5,
    isError: false,
    model: "gpt-4.1",
    tokenUsage: usage,
    raw: {
      costPrompt: {
        toolNames: ["read_file"],
        contextBreakdown: {
          system: 100,
          tools: 200,
          history: Math.max(contextTotal - 350, 0),
          toolResults: 25,
          user: 25,
          total: contextTotal,
        },
      },
    },
  };
}

describe("CostView", function () {
  beforeEach(function () {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    document.body.innerHTML = "";
  });

  afterEach(function () {
    document.body.innerHTML = "";
  });

  it("renders empty state when no token usage exists", async function () {
    var container = document.createElement("div");
    document.body.appendChild(container);
    var root = createRoot(container);

    await act(async function () {
      root.render(<CostView events={[]} metadata={{}} />);
    });

    expect(findByText(container, "No token cost data found")).not.toBeNull();
    await act(async function () {
      root.unmount();
    });
  });

  it("renders summaries and cache miss warnings for tokenized sessions", async function () {
    var container = document.createElement("div");
    document.body.appendChild(container);
    var root = createRoot(container);
    var events = [
      buildEvent(0, { inputTokens: 4000, outputTokens: 100, cacheRead: 3000, cacheWrite: 0 }, 4000),
      buildEvent(1, { inputTokens: 9000, outputTokens: 120, cacheRead: 200, cacheWrite: 0 }, 9000),
    ];

    await act(async function () {
      root.render(<CostView events={events} metadata={{ primaryModel: "gpt-4.1" }} />);
    });

    expect(findByText(container, "Token spend & context buildup")).not.toBeNull();
    expect(findByText(container, "Unexpected cache miss on call #2.")).not.toBeNull();
    expect(findByText(container, "Cache misses")).not.toBeNull();

    await act(async function () {
      root.unmount();
    });
  });

  it("renders the lens toggle and unit toggle controls", async function () {
    var container = document.createElement("div");
    document.body.appendChild(container);
    var root = createRoot(container);
    var events = [
      buildEvent(0, { inputTokens: 1000, outputTokens: 50, cacheRead: 0, cacheWrite: 1000 }, 1000),
      buildEvent(1, { inputTokens: 1500, outputTokens: 80, cacheRead: 500, cacheWrite: 0 }, 1500),
    ];

    await act(async function () {
      root.render(<CostView events={events} metadata={{ primaryModel: "gpt-4.1" }} />);
    });

    expect(findByText(container, "BILLED")).not.toBeNull();
    expect(findByText(container, "CTX")).not.toBeNull();
    expect(findByText(container, "NET")).not.toBeNull();
    expect(findByText(container, "USD")).not.toBeNull();
    expect(findByText(container, "AI Credits")).not.toBeNull();

    await act(async function () {
      root.unmount();
    });
  });

  it("switches the lens to NET when the user clicks the NET toggle", async function () {
    var container = document.createElement("div");
    document.body.appendChild(container);
    var root = createRoot(container);
    var events = [
      buildEvent(0, { inputTokens: 1000, outputTokens: 50, cacheRead: 0, cacheWrite: 1000 }, 1000),
      buildEvent(1, { inputTokens: 1500, outputTokens: 80, cacheRead: 500, cacheWrite: 0 }, 1500),
    ];

    await act(async function () {
      root.render(<CostView events={events} metadata={{ primaryModel: "gpt-4.1" }} />);
    });

    var netButton = Array.from(container.querySelectorAll("button")).find(function (btn) {
      return btn.textContent === "NET";
    });
    expect(netButton).not.toBeUndefined();
    await act(async function () {
      netButton.click();
    });
    expect(netButton.getAttribute("aria-pressed")).toBe("true");
    expect(findByText(container, "Net-new tokens per call")).not.toBeNull();

    await act(async function () {
      root.unmount();
    });
  });

  it("shows the hide-overhead toggle and filters overhead calls when checked", async function () {
    var container = document.createElement("div");
    document.body.appendChild(container);
    var root = createRoot(container);
    var primary = buildEvent(0, { inputTokens: 4000, outputTokens: 100, cacheRead: 0, cacheWrite: 4000 }, 4000);
    var overhead = buildEvent(1, { inputTokens: 200, outputTokens: 10, cacheRead: 0, cacheWrite: 0 }, 200);
    overhead.raw.costPrompt.category = "overhead";
    overhead.raw.costPrompt.callName = "title";

    await act(async function () {
      root.render(<CostView events={[primary, overhead]} metadata={{}} />);
    });

    var hideToggle = container.querySelector("#cost-hide-overhead");
    expect(hideToggle).not.toBeNull();
    expect(findByText(container, "overhead")).not.toBeNull();

    await act(async function () {
      hideToggle.click();
    });
    expect(hideToggle.checked).toBe(true);

    await act(async function () {
      root.unmount();
    });
  });

  it("formats spend in AI Credits when the unit toggle switches to credits", async function () {
    var container = document.createElement("div");
    document.body.appendChild(container);
    var root = createRoot(container);
    var events = [
      buildEvent(0, { inputTokens: 100000, outputTokens: 5000, cacheRead: 0, cacheWrite: 100000 }, 100000),
    ];

    await act(async function () {
      root.render(<CostView events={events} metadata={{ primaryModel: "gpt-4.1" }} />);
    });

    var creditsButton = Array.from(container.querySelectorAll("button")).find(function (btn) {
      return btn.textContent === "AI Credits";
    });
    expect(creditsButton).not.toBeUndefined();
    await act(async function () {
      creditsButton.click();
    });
    expect(findByText(container, "cr")).not.toBeNull();

    await act(async function () {
      root.unmount();
    });
  });
});
