// @vitest-environment jsdom

import React from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildAutonomyMetrics, buildAutonomySummary } from "../lib/autonomyMetrics.js";
import { PlaybackProvider } from "../contexts/PlaybackContext.jsx";
import AnalyzeShell from "../components/v2/AnalyzeShell.jsx";
import ImproveView from "../components/v2/ImproveView.jsx";
import InlineCompare from "../components/v2/InlineCompare.jsx";
import InvestigateView from "../components/v2/InvestigateView.jsx";
import ReviewHub from "../components/v2/ReviewHub.jsx";
import { loadExpected, loadGoldenSession } from "./v2GoldenHelpers.js";

vi.mock("../components/DebriefView.jsx", function () {
  return {
    default: function MockDebriefView() {
      return null;
    },
  };
});

function makeSession(file) {
  var parsed = loadGoldenSession().session;
  return {
    file: file || "golden-a.jsonl",
    events: parsed.events,
    turns: parsed.turns,
    metadata: parsed.metadata,
    total: parsed.metadata.duration,
    isLive: false,
  };
}

function makeAutonomy(session) {
  return buildAutonomyMetrics(session.events, session.turns, session.metadata);
}

function findExactText(container, text) {
  return Array.from(container.querySelectorAll("*")).find(function (node) {
    return node.textContent && node.textContent.trim() === text;
  }) || null;
}

async function renderNode(node) {
  var container = document.createElement("div");
  document.body.appendChild(container);
  var root = createRoot(container);

  await act(async function () {
    root.render(node);
  });

  return {
    container: container,
    unmount: async function () {
      await act(async function () {
        root.unmount();
      });
      container.remove();
    },
  };
}

async function clickButton(container, text) {
  var button = Array.from(container.querySelectorAll("button")).find(function (node) {
    return node.textContent && node.textContent.trim() === text;
  });
  expect(button).toBeTruthy();
  await act(async function () {
    button.click();
  });
}

beforeEach(function () {
  var storage = {};
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  global.fetch = vi.fn(async function () {
    return { ok: false, json: async function () { return []; } };
  });
  global.localStorage = {
    getItem: function (key) { return Object.prototype.hasOwnProperty.call(storage, key) ? storage[key] : null; },
    setItem: function (key, value) { storage[key] = String(value); },
    removeItem: function (key) { delete storage[key]; },
    clear: function () { storage = {}; },
  };
});

afterEach(function () {
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

describe("v2 golden UI data wiring", function () {
  it("renders Review with exact golden summary values", async function () {
    var expected = loadExpected("v2-golden-copilot.expected.json");
    var session = makeSession();
    var autonomy = makeAutonomy(session);
    var app = await renderNode(
      <ReviewHub session={session} autonomyMetrics={autonomy} onNavigate={vi.fn()} />,
    );

    expect(findExactText(app.container, expected.ui.reviewScoreText)).toBeTruthy();
    expect(findExactText(app.container, expected.ui.reviewLabelText)).toBeTruthy();
    expect(findExactText(app.container, String(expected.review.totalEvents))).toBeTruthy();
    expect(findExactText(app.container, String(expected.review.totalToolCalls))).toBeTruthy();
    expect(findExactText(app.container, expected.ui.costText)).toBeTruthy();
    expect(findExactText(app.container, expected.ui.autonomyText)).toBeTruthy();

    await app.unmount();
  });

  it("renders Analyze panel navigation against the golden session", async function () {
    var expected = loadExpected("v2-golden-copilot.expected.json");
    var session = makeSession();
    var app = await renderNode(
      <PlaybackProvider session={session}>
        <AnalyzeShell session={session} autonomyMetrics={makeAutonomy(session)} onNavigate={vi.fn()} />
      </PlaybackProvider>,
    );

    expect(findExactText(app.container, "Analysis panels")).toBeTruthy();
    expected.ui.analyzePanels.forEach(function (panelLabel) {
      expect(Array.from(app.container.querySelectorAll("button")).some(function (button) {
        return button.textContent && button.textContent.trim() === panelLabel;
      })).toBe(true);
    });

    await clickButton(app.container, "Cost");
    expect(app.container.textContent).toContain("Token spend");

    await app.unmount();
  });

  it("renders Investigate evidence text and Compare golden session names", async function () {
    var expected = loadExpected("v2-golden-copilot.expected.json");
    var sessionA = makeSession("golden-a.jsonl");
    var sessionB = makeSession("golden-b.jsonl");
    var investigate = await renderNode(
      <PlaybackProvider session={sessionA}>
        <InvestigateView session={sessionA} onNavigate={vi.fn()} />
      </PlaybackProvider>,
    );

    expect(findExactText(investigate.container, "Evidence stream")).toBeTruthy();
    expect(investigate.container.textContent).toContain(expected.ui.investigateEventText);
    await investigate.unmount();

    var compare = await renderNode(
      <InlineCompare
        sessionA={sessionA}
        sessionB={sessionB}
        compareReady={true}
        exportState="idle"
        onNavigate={vi.fn()}
        onOpenSessionA={vi.fn()}
        onOpenSessionB={vi.fn()}
      />,
    );

    expect(compare.container.textContent).toContain(expected.ui.compareTitle);
    expect(findExactText(compare.container, "Scorecard")).toBeTruthy();
    await compare.unmount();
  });

  it("renders Improve with the golden session and Q&A action", async function () {
    var session = makeSession();
    var autonomy = makeAutonomy(session);
    var app = await renderNode(
      <PlaybackProvider session={session}>
        <ImproveView
          session={session}
          autonomyMetrics={autonomy}
          debrief={{ summary: buildAutonomySummary(autonomy) }}
          onNavigate={vi.fn()}
        />
      </PlaybackProvider>,
    );

    expect(findExactText(app.container, "Coach and Q&A")).toBeTruthy();
    expect(findExactText(app.container, "Ask about session")).toBeTruthy();

    await app.unmount();
  });
});
