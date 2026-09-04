import { describe, it, expect } from "vitest";
import {
  theme,
  alpha,
  TRACK_TYPES,
  AGENT_COLORS,
} from "../lib/theme.js";

describe("alpha", function () {
  it("converts hex + opacity to rgba string", function () {
    expect(alpha("#ff0000", 0.5)).toBe("rgba(255,0,0,0.5)");
    expect(alpha("#00ff00", 1)).toBe("rgba(0,255,0,1)");
    expect(alpha("#000000", 0)).toBe("rgba(0,0,0,0)");
  });

  it("passes through existing rgba strings unchanged", function () {
    var input = "rgba(100,200,50,0.8)";
    expect(alpha(input, 0.3)).toBe(input);
  });
});

describe("theme proxy object", function () {
  it("exposes static shared tokens directly", function () {
    expect(theme.font.mono).toContain("JetBrains Mono");
    expect(theme.fontSize.base).toBe(12);
    expect(theme.space.md).toBe(8);
    expect(theme.radius).toBeDefined();
    expect(theme.z).toBeDefined();
  });

  it("exposes palette sections", function () {
    expect(theme.bg).toBeDefined();
    expect(theme.text).toBeDefined();
    expect(theme.border).toBeDefined();
    expect(theme.accent).toBeDefined();
    expect(theme.semantic).toBeDefined();
    expect(theme.track).toBeDefined();
  });

  it("uses light mode", function () {
    expect(theme.mode).toBe("light");
    expect(theme.bg.base).toBe("#f6f7fb");
  });
});

describe("TRACK_TYPES", function () {
  it("defines all expected track types", function () {
    expect(TRACK_TYPES.reasoning).toBeDefined();
    expect(TRACK_TYPES.tool_call).toBeDefined();
    expect(TRACK_TYPES.context).toBeDefined();
    expect(TRACK_TYPES.output).toBeDefined();
  });

  it("each track has label, icon, and dynamic color", function () {
    Object.values(TRACK_TYPES).forEach(function (track) {
      expect(track.label).toBeTruthy();
      expect(track.icon).toBeTruthy();
      expect(track.color).toBeTruthy();
    });
  });
});

describe("AGENT_COLORS", function () {
  it("provides colors for known agent types", function () {
    expect(AGENT_COLORS.user).toBeTruthy();
    expect(AGENT_COLORS.assistant).toBeTruthy();
    expect(AGENT_COLORS.system).toBeTruthy();
  });
});
