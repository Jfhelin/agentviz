/**
 * AGENTVIZ Design Tokens
 *
 * Mode-aware palette with dark, light, and system preferences.
 * Inspired by Linear, Raycast, Vercel -- tools that feel quiet and fast.
 */

var THEME_STORAGE_KEY = "agentviz:theme-mode";

var SHARED_THEME = {
  font: {
    mono: "'JetBrains Mono', monospace",
    ui: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
  },
  fontSize: {
    xs: 10,
    sm: 11,
    base: 12,
    md: 13,
    lg: 15,
    xl: 18,
    xxl: 24,
    hero: 32,
  },
  space: {
    xs: 2,
    sm: 4,
    md: 8,
    lg: 12,
    xl: 16,
    xxl: 24,
    xxxl: 32,
    huge: 40,
    giant: 56,
  },
  radius: {
    sm: 4,
    md: 6,
    lg: 8,
    xl: 10,
    xxl: 12,
    full: 9999,
  },
  transition: {
    fast: "80ms ease-out",
    base: "150ms ease-out",
    smooth: "200ms ease-out",
    slow: "300ms ease-out",
  },
  z: {
    base: 1,
    active: 2,
    playhead: 3,
    tooltip: 10,
    overlay: 50,
    modal: 100,
  },
  focus: {
    ring: "0 0 0 2px #6475e8",
  },
};

var DARK_THEME = {
  bg: {
    base: "#000000",
    surface: "#0f0f16",
    raised: "#1a1a24",
    overlay: "rgba(0, 0, 0, 0.7)",
    hover: "#20202e",
    active: "#26263a",
  },
  border: {
    subtle: "#1a1a24",
    default: "#232333",
    strong: "#2e2e42",
    focus: "#6475e8",
  },
  text: {
    primary: "#f0f0f2",
    secondary: "#a1a1a8",
    muted: "#717178",
    dim: "#585860",
    ghost: "#454548",
  },
  accent: {
    primary: "#6475e8",
    hover: "#7585f0",
    muted: "#6475e820",
  },
  semantic: {
    success: "#10d97a",
    warning: "#eab308",
    error: "#f43f5e",
    errorBg: "#f43f5e15",
    errorBorder: "#f43f5e30",
    errorText: "#fb7185",
    info: "#6475e8",
  },
  agent: {
    user: "#8b8b99",
    assistant: "#6475e8",
    system: "#a78bfa",
  },
  agentThread: {
    main: "#94a3b8",
    subA: "#3b9eff",
    subB: "#a78bfa",
    subC: "#10d97a",
    subD: "#f4b340",
  },
  agentType: {
    explore: "#3b9eff",
    task: "#10d97a",
    "general-purpose": "#a78bfa",
    "code-review": "#06b6d4",
    "configure-copilot": "#ec4899",
    default: "#06b6d4",
  },
  track: {
    reasoning: "#94a3b8",
    tool_call: "#3b9eff",
    context: "#a78bfa",
    output: "#10d97a",
    agent: "#06b6d4",
  },
  shadow: {
    sm: "0 1px 2px rgba(0,0,0,0.3)",
    md: "0 4px 12px rgba(0,0,0,0.25)",
    lg: "0 12px 32px rgba(0,0,0,0.35)",
    inset: "inset 0 1px 2px rgba(0,0,0,0.2)",
  },
  cost: {
    // Cumulative cost stack colors (token-type categorical)
    fresh:    "#56d364",
    cwrite:   "#f4b340",
    cached:   "#3DA9D4",
    output:   "#a371f7",
    // Per-call context-window stack colors (component categorical)
    ctxSystem:      "#7A8B9E",
    ctxToolDefs:    "#4A5568",
    ctxHistory:     "#E6A847",
    ctxToolResults: "#B8642F",
    ctxCurrent:     "#3DA9D4",
    ctxOutput:      "#2C7A99",
    ctxImages:      "#C77BC2",
    // Tool-group kind chips
    kindMcp:        "#a371f7",
    kindExtension:  "#f4b340",
    kindBuiltin:    "#3DA9D4",
    // Tinted chip backgrounds (paired with the kind* foreground colors)
    chipBgMcp:        "#a371f725",
    chipBgExtension:  "#f4b34025",
    chipBgBuiltin:    "#3DA9D425",
    chipBgAssistant:  "#6475e825",
    chipBgResult:     "#B8642F25",
    // Unexpected cache miss callout (error-tinted)
    missAccent:    "#f43f5e",
    missBg:        "#f43f5e12",
    missBorder:    "#f43f5e30",
    missText:      "#fb7185",
    missCodeBg:    "#f43f5e18",
    missCodeBorder:"#f43f5e40",
    missCodeText:  "#fda4af",
    // Healthy cache state (success-tinted)
    okBarTrack:    "#10d97a18",
    okBg:          "#10d97a12",
    okBorder:      "#10d97a30",
    // Cache recommit warning (cwrite/amber-tinted)
    recommitBg:    "#f4b34015",
    recommitBorder:"#f4b34035",
    // Run/model switch banner (info-tinted)
    switchBg:      "#6475e812",
    switchBorder:  "#6475e830",
    switchText:    "#7585f0",
  },
};

var LIGHT_THEME = {
  bg: {
    base: "#f6f7fb",
    surface: "#ffffff",
    raised: "#eef1f7",
    overlay: "rgba(17, 24, 39, 0.48)",
    hover: "#e5e9f2",
    active: "#d8deea",
  },
  border: {
    subtle: "#e4e8f0",
    default: "#d8deea",
    strong: "#c2cad8",
    focus: "#6475e8",
  },
  text: {
    primary: "#141824",
    secondary: "#4f5669",
    muted: "#70788d",
    dim: "#8a90a2",
    ghost: "#b0b6c8",
  },
  accent: {
    primary: "#6475e8",
    hover: "#5467e6",
    muted: "#6475e818",
  },
  semantic: {
    success: "#0ea86b",
    warning: "#ca8a04",
    error: "#e11d48",
    errorBg: "#e11d4814",
    errorBorder: "#e11d482a",
    errorText: "#be123c",
    info: "#6475e8",
  },
  agent: {
    user: "#70788d",
    assistant: "#6475e8",
    system: "#8b5cf6",
  },
  agentThread: {
    main: "#64748b",
    subA: "#2563eb",
    subB: "#8b5cf6",
    subC: "#0ea86b",
    subD: "#ca8a04",
  },
  agentType: {
    explore: "#2563eb",
    task: "#0ea86b",
    "general-purpose": "#8b5cf6",
    "code-review": "#0891b2",
    "configure-copilot": "#db2777",
    default: "#0891b2",
  },
  track: {
    reasoning: "#64748b",
    tool_call: "#2563eb",
    context: "#8b5cf6",
    output: "#0ea86b",
    agent: "#0891b2",
  },
  shadow: {
    sm: "0 1px 2px rgba(17,24,39,0.08)",
    md: "0 4px 12px rgba(17,24,39,0.08)",
    lg: "0 12px 32px rgba(17,24,39,0.10)",
    inset: "inset 0 1px 2px rgba(17,24,39,0.06)",
  },
  cost: {
    fresh:    "#0ea86b",
    cwrite:   "#ca8a04",
    cached:   "#1e88c4",
    output:   "#7c5ce6",
    ctxSystem:      "#5a6b80",
    ctxToolDefs:    "#2d3748",
    ctxHistory:     "#b87a1a",
    ctxToolResults: "#8a4a1f",
    ctxCurrent:     "#1e88c4",
    ctxOutput:      "#1c5f78",
    ctxImages:      "#9b4f97",
    kindMcp:        "#7c5ce6",
    kindExtension:  "#ca8a04",
    kindBuiltin:    "#1e88c4",
    chipBgMcp:        "#7c5ce620",
    chipBgExtension:  "#ca8a0420",
    chipBgBuiltin:    "#1e88c420",
    chipBgAssistant:  "#6475e820",
    chipBgResult:     "#8a4a1f20",
    missAccent:    "#e11d48",
    missBg:        "#e11d4810",
    missBorder:    "#e11d4828",
    missText:      "#be123c",
    missCodeBg:    "#e11d4818",
    missCodeBorder:"#e11d4838",
    missCodeText:  "#9f1239",
    okBarTrack:    "#0ea86b14",
    okBg:          "#0ea86b0e",
    okBorder:      "#0ea86b28",
    recommitBg:    "#ca8a0412",
    recommitBorder:"#ca8a0430",
    switchBg:      "#6475e80e",
    switchBorder:  "#6475e828",
    switchText:    "#4a5cd9",
  },
};

var themePreference = "dark";
var systemThemePreference = "dark";

function normalizeThemePreference(mode) {
  return mode === "light" || mode === "dark" ? mode : "system";
}

function normalizeResolvedMode(mode) {
  return mode === "light" ? "light" : "dark";
}

export function readStoredThemePreference() {
  if (typeof window === "undefined") return themePreference;
  try {
    var raw = window.localStorage.getItem(THEME_STORAGE_KEY);
    if (!raw) return themePreference;

    try {
      return normalizeThemePreference(JSON.parse(raw));
    } catch (parseError) {
      return normalizeThemePreference(raw);
    }
  } catch (error) {
    return themePreference;
  }
}

function readSystemThemePreference() {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return systemThemePreference;
  return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

function resolveThemeMode(mode, systemMode) {
  var preference = normalizeThemePreference(typeof mode === "undefined" ? themePreference : mode);
  var resolvedSystemMode = normalizeResolvedMode(typeof systemMode === "undefined" ? systemThemePreference : systemMode);
  return preference === "system" ? resolvedSystemMode : preference;
}

function getThemeTokens(mode, systemMode) {
  return resolveThemeMode(mode, systemMode) === "light"
    ? Object.assign({}, SHARED_THEME, LIGHT_THEME)
    : Object.assign({}, SHARED_THEME, DARK_THEME);
}

export function setThemePreference(mode) {
  themePreference = normalizeThemePreference(mode);
}

export function getThemePreference() {
  return themePreference;
}

export function setSystemThemePreference(mode) {
  systemThemePreference = normalizeResolvedMode(mode);
}

export function getSystemThemePreference() {
  return systemThemePreference;
}

export function getResolvedThemeMode(mode, systemMode) {
  return resolveThemeMode(mode, systemMode);
}

export function getThemeTokensForMode(mode, systemMode) {
  return getThemeTokens(mode, systemMode);
}

export function syncThemeState(mode, systemMode) {
  setThemePreference(mode);
  setSystemThemePreference(systemMode);
  return getThemeTokens(mode, systemMode);
}

export const THEME_MODES = [
  { id: "system", label: "System", icon: "monitor" },
  { id: "light", label: "Light", icon: "sun" },
  { id: "dark", label: "Dark", icon: "moon" },
];

function defineThemeSection(target, key) {
  Object.defineProperty(target, key, {
    enumerable: true,
    get: function () {
      return getThemeTokens()[key];
    },
  });
}

export var theme = {};
defineThemeSection(theme, "bg");
defineThemeSection(theme, "border");
defineThemeSection(theme, "text");
defineThemeSection(theme, "accent");
defineThemeSection(theme, "semantic");
defineThemeSection(theme, "agent");
defineThemeSection(theme, "agentType");
defineThemeSection(theme, "track");
defineThemeSection(theme, "shadow");
defineThemeSection(theme, "cost");
defineThemeSection(theme, "agentThread");
theme.font = SHARED_THEME.font;
theme.fontSize = SHARED_THEME.fontSize;
theme.space = SHARED_THEME.space;
theme.radius = SHARED_THEME.radius;
theme.focus = SHARED_THEME.focus;
theme.transition = SHARED_THEME.transition;
theme.z = SHARED_THEME.z;
Object.defineProperty(theme, "mode", {
  enumerable: true,
  get: function () {
    return resolveThemeMode();
  },
});

function createDynamicColorMap(keys) {
  var result = {};
  keys.forEach(function (key) {
    Object.defineProperty(result, key, {
      enumerable: true,
      get: function () {
        return getThemeTokens().agent[key];
      },
    });
  });
  return result;
}

export const AGENT_COLORS = createDynamicColorMap(["user", "assistant", "system"]);

function createTrackInfo(key, label, icon) {
  var result = { label: label, icon: icon };
  Object.defineProperty(result, "color", {
    enumerable: true,
    get: function () {
      return getThemeTokens().track[key];
    },
  });
  return result;
}

export const TRACK_TYPES = {
  reasoning: createTrackInfo("reasoning", "Reasoning", "reasoning"),
  tool_call: createTrackInfo("tool_call", "Tool Calls", "tool_call"),
  context: createTrackInfo("context", "Context", "context"),
  output: createTrackInfo("output", "Output", "output"),
  agent: createTrackInfo("agent", "Agents", "agent"),
};

// ── Opacity helper ──
export function alpha(hex, opacity) {
  if (hex.startsWith("rgba")) return hex;
  var h = hex.replace("#", "");
  var r = parseInt(h.substring(0, 2), 16);
  var g = parseInt(h.substring(2, 4), 16);
  var b = parseInt(h.substring(4, 6), 16);
  return "rgba(" + r + "," + g + "," + b + "," + opacity + ")";
}

setThemePreference(readStoredThemePreference());
setSystemThemePreference(readSystemThemePreference());
