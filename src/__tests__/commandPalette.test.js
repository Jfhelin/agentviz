import { describe, expect, it } from "vitest";
import { buildCommandPaletteIndex, searchCommandPalette } from "../lib/commandPalette.js";

describe("command palette flow-aware items", function () {
  it("searches extra zone commands", function () {
    var index = buildCommandPaletteIndex([], [], {
      includeLegacyViews: false,
      includeDefaultActions: false,
      extraItems: [
        {
          id: "failed",
          type: "zone",
          label: "Go to failed tool calls",
          zoneId: "investigate",
          searchText: "failed tool calls errors investigate debug",
          priority: 48,
        },
      ],
    });

    var results = searchCommandPalette(index, "failed tool");

    expect(results.map(function (item) { return item.id; })).toEqual(["failed"]);
  });
});
