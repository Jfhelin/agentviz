/**
 * AGENTVIZ Design Tokens
 *
 * Single light palette shared by every view.
 * Inspired by Linear, Raycast, Vercel -- tools that feel quiet and fast.
 */

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
    kindMcp:        "#7c5ce6",
    kindExtension:  "#ca8a04",
    kindBuiltin:    "#1e88c4",
    chipBgMcp:        "#ede8fa",
    chipBgExtension:  "#fdf3d4",
    chipBgBuiltin:    "#dceffb",
    chipBgUser:       "#fdf3d4",
    chipBgAssistant:  "#dcf2e2",
    chipBgResult:     "#fbe5d4",
    chipFgUser:       "#a36b08",
    chipFgAssistant:  "#0e7c4d",
    chipFgResult:     "#8a4a1f",
    missBg:           "#fde7ec",
    missBorder:       "#f5b9c5",
    missText:         "#a8203b",
    missAccent:       "#8a162e",
    missBadgeBg:      "#c0263e",
    missCodeBg:       "#fdf0f3",
    missCodeBorder:   "#f5d0d8",
    missCodeText:     "#8a162e",
    recommitBg:       "#fdf6e0",
    recommitBorder:   "#e8d28a",
    recommitText:     "#7a5b10",
    switchBg:         "#e0edfa",
    switchBorder:     "#a8c8ec",
    switchText:       "#1c4f88",
    okBg:             "#dcf2e2",
    okBorder:         "#a6dfb8",
    okBarTrack:       "#eaf6ee",
  },
};

export var theme = Object.assign({ mode: "light" }, SHARED_THEME, LIGHT_THEME);

export const AGENT_COLORS = theme.agent;

function createTrackInfo(key, label, icon) {
  return { label: label, icon: icon, color: theme.track[key] };
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
