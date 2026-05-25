import fs from "node:fs";
import path from "node:path";
import { parseSession } from "../lib/parseSession";

export function loadFixture(name) {
  return fs.readFileSync(path.join(__dirname, "fixtures", name), "utf8");
}

export function loadExpected(name) {
  return JSON.parse(loadFixture(name));
}

export function loadGoldenSession(expectedFile) {
  var expected = loadExpected(expectedFile || "v2-golden-copilot.expected.json");
  var session = parseSession(loadFixture(expected.sourceFixture));
  return { session: session, expected: expected };
}

export function loadGoldenFormatCases() {
  return loadExpected("v2-golden-formats.expected.json").cases;
}

export function loadGoldenFormatSession(goldenCase) {
  return parseSession(loadFixture(goldenCase.sourceFixture));
}

export function getToolNames(session) {
  return session.events
    .filter(function (event) { return event.track === "tool_call" && event.toolName; })
    .map(function (event) { return event.toolName; });
}

export function getErrorEventIndexes(session) {
  return session.events
    .map(function (event, index) { return event.isError ? index : null; })
    .filter(function (index) { return index !== null; });
}

export function expectMaybeClose(expect, actual, expected) {
  if (typeof expected === "number" && !Number.isInteger(expected)) {
    expect(actual).toBeCloseTo(expected, 6);
  } else {
    expect(actual).toEqual(expected);
  }
}
