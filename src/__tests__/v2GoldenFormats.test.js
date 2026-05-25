import { describe, expect, it } from "vitest";
import { buildAutonomyMetrics } from "../lib/autonomyMetrics.js";
import { buildCostAnalysis } from "../lib/costAnalysis.js";
import { buildReviewInsights, buildReviewSummary } from "../components/v2/ReviewHub.jsx";
import {
  expectMaybeClose,
  getErrorEventIndexes,
  getToolNames,
  loadGoldenFormatCases,
  loadGoldenFormatSession,
} from "./v2GoldenHelpers.js";

function expectObjectSubset(actual, expected) {
  if (expected === null) {
    expect(actual).toBeNull();
    return;
  }
  Object.keys(expected || {}).forEach(function (key) {
    if (key === "insightIds" || key === "callCount") return;
    if (expected[key] && typeof expected[key] === "object" && !Array.isArray(expected[key])) {
      expectObjectSubset(actual && actual[key], expected[key]);
    } else {
      expectMaybeClose(expect, actual && actual[key], expected[key]);
    }
  });
}

describe("v2 golden format coverage", function () {
  loadGoldenFormatCases().forEach(function (goldenCase) {
    it("keeps " + goldenCase.id + " parser and v2 summary data deterministic", function () {
      var session = loadGoldenFormatSession(goldenCase);
      var metadata = session.metadata;
      var autonomy = buildAutonomyMetrics(session.events, session.turns, metadata);
      var review = buildReviewSummary(session, autonomy);
      var insights = buildReviewInsights(session, autonomy);
      var cost = buildCostAnalysis(session.events, metadata);

      expectObjectSubset(metadata, goldenCase.metadata);
      if (goldenCase.events.firstText) {
        expect(session.events[0].text).toBe(goldenCase.events.firstText);
      }
      if (goldenCase.events.toolNames) {
        expect(getToolNames(session)).toEqual(goldenCase.events.toolNames);
      }
      if (goldenCase.events.mustIncludeToolNames) {
        goldenCase.events.mustIncludeToolNames.forEach(function (toolName) {
          expect(getToolNames(session)).toContain(toolName);
        });
      }
      if (goldenCase.events.errorEventIndexes) {
        expect(getErrorEventIndexes(session)).toEqual(goldenCase.events.errorEventIndexes);
      }
      if (goldenCase.events.mustIncludeErrorText) {
        var errorText = session.events.filter(function (event) { return event.isError; }).map(function (event) { return event.text; }).join("\n");
        goldenCase.events.mustIncludeErrorText.forEach(function (text) {
          expect(errorText).toContain(text);
        });
      }

      expectObjectSubset(review, goldenCase.review);
      if (goldenCase.review && goldenCase.review.insightIds) {
        expect(insights.map(function (insight) { return insight.id; })).toEqual(goldenCase.review.insightIds);
      }
      if (goldenCase.cost) {
        expectObjectSubset(cost.totals, goldenCase.cost);
        if (goldenCase.cost.callCount != null) expect(cost.calls).toHaveLength(goldenCase.cost.callCount);
      }
    });
  });
});
