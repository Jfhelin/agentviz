import React, { useState, useMemo, useEffect } from "react";
import { theme } from "../lib/theme.js";
import { estimateCost, hasModelPricing, getModelPrice } from "../lib/pricing.js";
import { estimateImageTokens, imageDollarCost } from "../lib/imageTokenEstimate.js";
import usePersistentState from "../hooks/usePersistentState.js";

// Display unit for $ amounts. Module-level so the dozens of fmt$ call sites
// don't all need a context/prop. The CostView root keeps it in sync with the
// persistent toggle via setCostUnit() in a useEffect.
//   currency:  "$0.0123"     (USD)
//   credits:   "1.23 cr"     (1 credit = $0.01, per GitHub Copilot AI Credits)
var _costUnit = "credits";
function setCostUnit(u) { _costUnit = u === "currency" ? "currency" : "credits"; }
function isCredits() { return _costUnit === "credits"; }

// Cost view uses theme.cost.* tokens (defined in src/lib/theme.js).
// These are categorical color roles that change with light/dark mode.
var COST_COLORS = {
  fresh:  theme.cost.fresh,
  cwrite: theme.cost.cwrite,
  cached: theme.cost.cached,
  output: theme.cost.output,
};
var COST_LABELS = {
  fresh: "Fresh input",
  cwrite: "Cache write",
  cached: "Cached read",
  output: "Output",
};
var CTX_KEYS = ["system", "tool_defs", "history", "tool_results", "current", "output"];
var CTX_INPUT_KEYS = ["system", "tool_defs", "history", "tool_results", "current"];
var CTX_COLORS = {
  system:       theme.cost.ctxSystem,
  tool_defs:    theme.cost.ctxToolDefs,
  history:      theme.cost.ctxHistory,
  tool_results: theme.cost.ctxToolResults,
  current:      theme.cost.ctxCurrent,
  output:       theme.cost.ctxOutput,
};
var CTX_LABELS = {
  system: "System",
  tool_defs: "Tool defs",
  history: "History",
  tool_results: "Tool results",
  current: "Current prompt",
  output: "Response",
};
var KIND_COLORS = {
  mcp:       theme.cost.kindMcp,
  extension: theme.cost.kindExtension,
  builtin:   theme.cost.kindBuiltin,
};

// Map VS Code Copilot Chat's internal call names to friendly labels.
// The raw name is still shown as a small subtitle for power users.
var CALL_NAME_LABELS = {
  "panel/editAgent":      "Chat turn (with tools)",
  "panel/request":        "Chat turn",
  "panel/explain":        "Explain",
  "panel/fix":            "Fix",
  "title":                "Generate chat title",
  "promptCategorization": "Categorize prompt",
};
function friendlyCallName(name) {
  if (!name) return "Request";
  if (CALL_NAME_LABELS[name]) return CALL_NAME_LABELS[name];
  // panel/<something> → "Chat: something"
  if (name.indexOf("panel/") === 0) return "Chat: " + name.slice(6);
  return name;
}

function fmt$(n) {
  if (n == null || isNaN(n)) return isCredits() ? "0 cr" : "$0";
  if (isCredits()) {
    var c = n * 100; // 100 credits = $1
    var a = Math.abs(c);
    var sign = c < 0 ? "-" : "";
    if (a < 0.01) return sign + a.toFixed(3) + " cr";
    if (a < 1) return sign + a.toFixed(2) + " cr";
    if (a < 10) return sign + a.toFixed(2) + " cr";
    if (a < 100) return sign + a.toFixed(1) + " cr";
    return sign + Math.round(a).toLocaleString() + " cr";
  }
  return n < 0.01 ? "$" + n.toFixed(5) : "$" + n.toFixed(4);
}
function fmtT(n) {
  if (n == null || isNaN(n)) return "0";
  var a = Math.abs(n);
  var sign = n < 0 ? "-" : "";
  return sign + (a >= 1000 ? (a / 1000).toFixed(1) + "k" : "" + Math.round(a));
}
function fmtTSigned(n) {
  if (n == null || isNaN(n)) return "+0";
  var a = Math.abs(n);
  var sign = n >= 0 ? "+" : "-";
  return sign + (a >= 1000 ? (a / 1000).toFixed(2) + "k" : "" + Math.round(a));
}

// Map cacheAnalysis field names (camelCase) to mockup field names.
function eventCumParts(ev, cumState) {
  return {
    fresh: cumState.fresh,
    cwrite: cumState.cwrite,
    cached: cumState.cached,
    output: cumState.output,
  };
}

// Build cumulative cost timeline for stacked bars.
// When includeOverhead is false, overhead LLM calls (e.g. `title`,
// `promptCategorization`) contribute zero so the cum bars on visible rows
// reflect only the user-facing chat flow.
function buildCumStates(prompts, includeOverhead) {
  var freshAcc = 0, cwriteAcc = 0, cachedAcc = 0, outputAcc = 0;
  var states = [];
  prompts.forEach(function (p) {
    p.events.forEach(function (ev) {
      if (ev.kind === "llm" && (includeOverhead || ev.category !== "overhead")) {
        // Decompose this call's cost into its 4 cost components for the stacked
        // cum bar. We approximate by calling the same per-token rates.
        // Use the raw counts from the event (they sum to ev.cost).
        // Per-call cost split = fresh + cached_read + cache_write + output.
        // We don't know exact per-component prices here; approximate from totals.
        // The component values themselves come from cost analysis.
        // For visual proportions, scale each by their token counts.
        var totalToks = ev.fresh + ev.cached + ev.cacheWrite + ev.output;
        if (totalToks > 0 && ev.cost > 0) {
          // crude weights per token type (Anthropic-like ratios)
          var weights = {
            fresh: ev.fresh * 1.0,
            cached: ev.cached * 0.1,
            cwrite: ev.cacheWrite * 1.25,
            output: ev.output * 5.0,
          };
          var wSum = weights.fresh + weights.cached + weights.cwrite + weights.output || 1;
          freshAcc += ev.cost * (weights.fresh / wSum);
          cachedAcc += ev.cost * (weights.cached / wSum);
          cwriteAcc += ev.cost * (weights.cwrite / wSum);
          outputAcc += ev.cost * (weights.output / wSum);
        }
      }
      states.push({
        fresh: freshAcc,
        cached: cachedAcc,
        cwrite: cwriteAcc,
        output: outputAcc,
      });
    });
  });
  return states;
}

function StackBar(props) {
  var parts = props.parts;
  var keys = props.keys;
  var colors = props.colors;
  var labels = props.labels;
  var maxVal = props.maxVal;
  var withLabel = props.withLabel;
  var sum = keys.reduce(function (a, k) { return a + (parts[k] || 0); }, 0);
  if (sum === 0) {
    return (
      <div style={{ position: "relative", width: "100%", height: 18, background: theme.bg.base, borderRadius: 2, overflow: "hidden" }}>
        <span style={{ color: theme.text.ghost, fontSize: theme.fontSize.xs, fontStyle: "italic", paddingLeft: 6, lineHeight: "18px" }}>--</span>
      </div>
    );
  }
  var fillPct = 100 * sum / maxVal;
  var lab = (maxVal < 1) ? fmt$(sum) : fmtT(sum);
  return (
    <div style={{ position: "relative", width: "100%", height: 18, background: theme.bg.base, borderRadius: 2, overflow: "hidden" }}>
      <div style={{ display: "flex", height: "100%", width: fillPct + "%" }}>
        {keys.map(function (k) {
          var v = parts[k] || 0;
          if (v === 0) return null;
          var w = 100 * v / sum;
          var valStr = (maxVal < 1) ? fmt$(v) : fmtT(v);
          return (
            <div key={k}
              title={labels[k] + " · " + valStr + " (" + (100 * v / sum).toFixed(1) + "% of bar)"}
              style={{ height: "100%", background: colors[k], width: w + "%" }} />
          );
        })}
      </div>
      {withLabel && (
        <div style={{
          position: "absolute",
          right: fillPct < 35 ? "auto" : 6,
          left: fillPct < 35 ? (fillPct + 1) + "%" : "auto",
          top: "50%",
          transform: "translateY(-50%)",
          fontSize: theme.fontSize.xs,
          color: theme.text.primary,
          fontVariantNumeric: "tabular-nums",
          textShadow: "0 0 3px " + theme.bg.base + ",0 0 6px " + theme.bg.base,
          pointerEvents: "none",
        }}>{lab}</div>
      )}
    </div>
  );
}

function ToolGroups(props) {
  var groups = props.groups || [];
  var [expanded, setExpanded] = useState({});
  // Map parser group `source` → kind
  var grouped = groups.map(function (g) {
    var name = g.source || g.label || "Built-in";
    var lower = name.toLowerCase();
    var kind = lower.indexOf("mcp") >= 0 ? "mcp"
      : (lower.indexOf("ext") >= 0 || lower.indexOf("extension") >= 0) ? "extension"
      : "builtin";
    return {
      label: name,
      kind: kind,
      count: g.tools ? g.tools.length : (g.count || 0),
      tokens: g.tokens || g.scaled_tokens || 0,
      top: (g.tools || g.top || []).slice(0, 5).map(function (t) {
        if (Array.isArray(t)) return { name: t[0], tokens: t[1] };
        return { name: t.name, tokens: t.tokens };
      }),
      total: g.tools ? g.tools.length : (g.count || 0),
    };
  });
  var byKind = { mcp: 0, extension: 0, builtin: 0 };
  grouped.forEach(function (g) { byKind[g.kind] += g.tokens; });
  var totalKind = byKind.mcp + byKind.extension + byKind.builtin || 1;
  return (
    <div>
      <div style={{ display: "flex", height: 6, borderRadius: 1, overflow: "hidden", marginTop: 6, marginBottom: 6 }}>
        {["mcp", "extension", "builtin"].map(function (k) {
          if (!byKind[k]) return null;
          return <div key={k} title={k + ": " + fmtT(byKind[k]) + " tok"} style={{ height: "100%", background: KIND_COLORS[k], width: (100 * byKind[k] / totalKind) + "%" }} />;
        })}
      </div>
      {grouped.map(function (g, i) {
        var open = expanded[i];
        return (
          <div key={i}>
            <div onClick={function () { setExpanded(Object.assign({}, expanded, { [i]: !open })); }}
              style={{ display: "grid", gridTemplateColumns: "1fr auto auto", gap: 10, fontSize: theme.fontSize.sm, padding: "3px 0", alignItems: "center", cursor: "pointer" }}>
              <div style={{ color: theme.text.primary }}>
                <span style={{
                  display: "inline-block", fontSize: theme.fontSize.xs, padding: "1px 5px", borderRadius: 9,
                  marginRight: 6, fontWeight: 600, letterSpacing: 0.4,
                  background: g.kind === "mcp" ? theme.cost.chipBgMcp : g.kind === "extension" ? theme.cost.chipBgExtension : theme.cost.chipBgBuiltin,
                  color: KIND_COLORS[g.kind],
                }}>{g.kind.toUpperCase()}</span>
                {g.label}
              </div>
              <div style={{ color: theme.text.muted, fontVariantNumeric: "tabular-nums", textAlign: "right" }}>
                {g.count} tool{g.count === 1 ? "" : "s"}
              </div>
              <div style={{ color: theme.text.primary, fontVariantNumeric: "tabular-nums", textAlign: "right", fontWeight: 500 }}>
                {fmtT(g.tokens)} tok
              </div>
            </div>
            {open && (
              <div style={{ paddingLeft: 10, color: theme.text.muted, fontSize: theme.fontSize.xs, borderLeft: "1px solid " + theme.border.default, marginBottom: 4 }}>
                {g.top.map(function (t, j) {
                  return (
                    <div key={j} style={{ padding: "2px 0", display: "grid", gridTemplateColumns: "1fr auto", gap: 6, fontVariantNumeric: "tabular-nums" }}>
                      <span style={{ color: theme.text.secondary, overflow: "hidden", textOverflow: "ellipsis" }}>{t.name}</span>
                      <span>{fmtT(t.tokens)} tok</span>
                    </div>
                  );
                })}
                {g.count > g.top.length && (
                  <div style={{ padding: "2px 0", opacity: 0.6 }}>+{g.count - g.top.length} more</div>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function HistoryList(props) {
  var msgs = props.msgs || [];
  if (!msgs.length) return <div style={{ color: theme.text.ghost, fontSize: theme.fontSize.xs, fontStyle: "italic" }}>no prior conversation</div>;
  return (
    <div>
      {msgs.map(function (m, i) {
        return (
          <div key={i} style={{ display: "grid", gridTemplateColumns: "auto 1fr auto", gap: 8, fontSize: theme.fontSize.sm, padding: "3px 0", alignItems: "baseline", borderTop: i === 0 ? "none" : "1px solid " + theme.border.subtle }}>
            <span style={{
              fontSize: theme.fontSize.xs, padding: "1px 5px", borderRadius: 9, fontWeight: 600, letterSpacing: 0.4,
              background: m.role === "user" ? theme.cost.chipBgExtension : theme.cost.chipBgAssistant,
              color: m.role === "user" ? theme.cost.cwrite : theme.cost.fresh,
            }}>{m.role}</span>
            <span style={{ color: theme.text.secondary, fontStyle: "italic", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{m.preview}</span>
            <span style={{ color: theme.text.primary, fontVariantNumeric: "tabular-nums", textAlign: "right" }}>{fmtT(m.tokens || 0)}</span>
          </div>
        );
      })}
    </div>
  );
}

function ToolResultList(props) {
  var msgs = props.msgs || [];
  if (!msgs.length) return <div style={{ color: theme.text.ghost, fontSize: theme.fontSize.xs, fontStyle: "italic" }}>none in this call</div>;
  return (
    <div>
      {msgs.map(function (m, i) {
        var label = m.label || ("result " + (i + 1));
        return (
          <div key={i} style={{ display: "grid", gridTemplateColumns: "minmax(0, auto) 1fr auto", gap: 8, fontSize: theme.fontSize.sm, padding: "3px 0", alignItems: "baseline", borderTop: i === 0 ? "none" : "1px solid " + theme.border.subtle }}>
            <span
              title={label}
              style={{ fontSize: theme.fontSize.xs, padding: "1px 6px", borderRadius: 9, fontWeight: 600, letterSpacing: 0.2, background: theme.cost.chipBgResult, color: theme.cost.ctxToolResults, maxWidth: 280, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
            >{label}</span>
            <span style={{ color: theme.text.secondary, fontStyle: "italic", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{m.preview}</span>
            <span style={{ color: theme.text.primary, fontVariantNumeric: "tabular-nums", textAlign: "right" }}>{fmtT(m.tokens || 0)}</span>
          </div>
        );
      })}
    </div>
  );
}

function NewBlock(props) {
  var newPerBucket = props.newPerBucket || {};
  var newTotal = props.newTotal || 0;
  var totalIn = props.totalIn || 0;
  var label = props.label || "this call";
  var sum = CTX_INPUT_KEYS.reduce(function (a, k) { return a + (newPerBucket[k] || 0); }, 0) || 1;
  var pct = totalIn ? 100 * newTotal / totalIn : 0;
  return (
    <div style={{
      background: theme.cost.okBg, border: "1px solid " + theme.cost.okBorder, borderRadius: 5,
      padding: "11px 13px", marginBottom: 14,
    }}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 8 }}>
        <div style={{ color: theme.cost.fresh, fontSize: theme.fontSize.sm, fontWeight: 600, letterSpacing: 0.4, textTransform: "uppercase" }}>
          ▲ Billed as new {label}: {fmtT(newTotal)} tok ({pct.toFixed(1)}% of input)
        </div>
        <div style={{ color: theme.text.secondary, fontSize: theme.fontSize.sm, fontVariantNumeric: "tabular-nums" }}>
          {(100 - pct).toFixed(1)}% reused from cache · {fmtT(totalIn - newTotal)} cached tok
        </div>
      </div>
      <div style={{ height: 14, background: theme.cost.okBarTrack, borderRadius: 2, overflow: "hidden", display: "flex", marginBottom: 8 }}>
        {CTX_INPUT_KEYS.map(function (k) {
          var v = newPerBucket[k] || 0;
          if (v === 0) return null;
          var w = 100 * v / sum;
          return (
            <div key={k}
              title={CTX_LABELS[k] + " · " + fmtT(v) + " new tok · " + (100 * v / sum).toFixed(1) + "% of new content"}
              style={{ height: "100%", background: CTX_COLORS[k], width: w + "%" }} />
          );
        })}
        {!sum && <div style={{ height: "100%", background: theme.bg.raised, width: "100%" }} />}
      </div>
      <div style={{ fontSize: theme.fontSize.sm, color: theme.text.secondary, lineHeight: 1.7 }}>
        {CTX_INPUT_KEYS.filter(function (k) { return (newPerBucket[k] || 0) > 0; })
          .map(function (k) {
            return (
              <div key={k} style={{ display: "grid", gridTemplateColumns: "auto 1fr auto", gap: 8, alignItems: "baseline" }}>
                <span>
                  <span style={{ display: "inline-block", width: 8, height: 8, borderRadius: 1, background: CTX_COLORS[k], marginRight: 6 }} />
                  <b style={{ color: theme.text.primary, fontWeight: 500 }}>{CTX_LABELS[k]}</b>
                </span>
                <span />
                <span style={{ color: theme.cost.fresh, fontVariantNumeric: "tabular-nums", fontWeight: 600 }}>+{fmtT(newPerBucket[k])} tok</span>
              </div>
            );
          })}
        {!sum && <div style={{ opacity: 0.6 }}>No new content this call (everything cached)</div>}
      </div>
    </div>
  );
}

function DetailSection(props) {
  return (
    <div style={{ background: theme.bg.surface, border: "1px solid " + theme.border.default, borderRadius: 4, padding: "10px 12px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 8, fontSize: theme.fontSize.sm }}>
        <span style={{ color: theme.text.primary, fontWeight: 600 }}>
          <span style={{ display: "inline-block", width: 8, height: 8, borderRadius: 1, marginRight: 6, background: CTX_COLORS[props.bucket] }} />
          {CTX_LABELS[props.bucket]}
        </span>
        <span style={{ color: theme.text.secondary, fontVariantNumeric: "tabular-nums" }}>
          {props.valuePrefix || ""}{fmtT(props.value)} tok{props.pctLabel ? " · " + props.pct.toFixed(1) + "% " + props.pctLabel : ""}
        </span>
      </div>
      {props.children}
    </div>
  );
}

function LLMDetail(props) {
  var ev = props.event;
  var c = ev.components || {};
  var totalIn = CTX_INPUT_KEYS.reduce(function (a, k) { return a + (c[k] || 0); }, 0);
  var pct = function (k) { return 100 * (c[k] || 0) / Math.max(1, totalIn); };

  var missCallout = null;
  if (ev.unexpectedMiss && ev.cacheMissDiag) {
    var d = ev.cacheMissDiag;
    var reasons = [];
    if (d.toolDefsChanged > 0) {
      reasons.push(<span key="r1"><b>{d.toolDefsChanged} of {d.totalToolDefs || d.n_total} tool definitions changed</b> since the previous call. Even one byte difference invalidates the cached prefix. Changed: {(d.changedSample || []).map(function (n, i) {
        return <code key={i} style={{ background: theme.cost.missCodeBg, border: "1px solid " + theme.cost.missCodeBorder, padding: "1px 5px", borderRadius: 2, color: theme.cost.missCodeText, fontSize: theme.fontSize.xs, marginRight: 4 }}>{n}</code>;
      })}{(d.changedSample || []).length < d.toolDefsChanged ? "…" : ""}</span>);
    }
    if ((d.added || []).length) reasons.push(<span key="r2">Tools added: {d.added.map(function (n, i) { return <code key={i} style={{ background: theme.cost.missCodeBg, border: "1px solid " + theme.cost.missCodeBorder, padding: "1px 5px", borderRadius: 2, color: theme.cost.missCodeText, fontSize: theme.fontSize.xs, marginRight: 4 }}>{n}</code>; })}</span>);
    if ((d.removed || []).length) reasons.push(<span key="r3">Tools removed: {d.removed.map(function (n, i) { return <code key={i} style={{ background: theme.cost.missCodeBg, border: "1px solid " + theme.cost.missCodeBorder, padding: "1px 5px", borderRadius: 2, color: theme.cost.missCodeText, fontSize: theme.fontSize.xs, marginRight: 4 }}>{n}</code>; })}</span>);
    if (reasons.length === 0) reasons.push(<span key="r4">Tools are identical to the previous call. The cache likely <b>expired</b> (Anthropic ephemeral cache TTL is ~5 min) or the cache_control breakpoint placement changed in the messages array.</span>);
    missCallout = (
      <div style={{
        background: theme.cost.missBg, border: "1px solid " + theme.cost.missBorder, color: theme.cost.missText,
        padding: "10px 13px", margin: "0 0 12px", borderRadius: 4, fontSize: theme.fontSize.sm, lineHeight: 1.6,
      }}>
        <div style={{ fontWeight: 600, color: theme.cost.missAccent, fontSize: theme.fontSize.base, letterSpacing: 0.4, textTransform: "uppercase", marginBottom: 6, display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ background: theme.cost.missBorder, color: theme.text.primary, padding: "2px 7px", borderRadius: 3, fontSize: theme.fontSize.xs, letterSpacing: 0.5 }}>⚠ Unexpected cache miss</span>
        </div>
        We expected this call to hit the cache (<b style={{ color: theme.text.primary }}>{fmtT(ev.prevPt || 0)} tok</b> were cached on this model just before), but the API returned <b style={{ color: theme.text.primary }}>0 cached tokens</b>. The full <b style={{ color: theme.text.primary }}>{fmtT(ev.promptTokens)} tok</b> prefix was re-billed at premium write rate (~<b style={{ color: theme.text.primary }}>{fmt$(ev.cost)}</b>). Likely cause:
        <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>
          {reasons.map(function (r, i) { return <li key={i} style={{ marginBottom: 2 }}>{r}</li>; })}
        </ul>
      </div>
    );
  }

  var recommitCallout = null;
  if (ev.modelSwitched) {
    var fresh = Math.max(0, ev.promptTokens - (ev.cached || 0));
    var hasServiceCache = (ev.cached || 0) > 0;
    var isSubagent = (ev.name || "").indexOf("runSubagent") !== -1;
    var hadPriorSameModel = (ev.priorSameModelPt || 0) > 0;

    var headline, body;
    if (isSubagent) {
      headline = <>⇄ <b style={{ color: theme.text.primary }}>Subagent invocation</b></>;
      body = <>this is a fresh conversation thread spawned by a tool call. Subagents do <b>not</b> inherit the parent agent's per-session cache, even when they run on the same model ({ev.model}).</>;
    } else if (hadPriorSameModel) {
      headline = <>↺ <b style={{ color: theme.text.primary }}>Cache reset</b></>;
      body = <>your previous call on <b style={{ color: theme.text.primary }}>{ev.model}</b> had <b style={{ color: theme.text.primary }}>{fmtT(ev.priorSameModelPt)} tok</b> of context, but the immediately prior LLM call used a different model (typically a small overhead call like <code>title</code> or <code>promptCategorization</code>). Per-session cache is short-lived across model bounces, so most of it was evicted.</>;
    } else {
      headline = <>⇄ <b style={{ color: theme.text.primary }}>Model switch</b></>;
      body = <>this call is on <b style={{ color: theme.text.primary }}>{ev.model}</b>, which has not been used in this session before. Per-session cache from prior models does not carry over.</>;
    }

    recommitCallout = (
      <div style={{ background: theme.cost.switchBg, border: "1px solid " + theme.cost.switchBorder, color: theme.cost.switchText, padding: "8px 11px", margin: "0 0 12px", borderRadius: 4, fontSize: theme.fontSize.sm, lineHeight: 1.55 }}>
        {headline} -- {body}
        {hasServiceCache ? (
          <> Of the <b style={{ color: theme.text.primary }}>{fmtT(ev.promptTokens)} tok</b> sent, <b style={{ color: theme.text.primary }}>{fmtT(ev.cached)} tok</b> still hit cache -- these come from Copilot's <b>shared service-side cache</b> (common system prompt and tool defs that are warm across sessions and users). The remaining <b style={{ color: theme.text.primary }}>{fmtT(fresh)} tok</b> are billed as new.</>
        ) : (
          <> All <b style={{ color: theme.text.primary }}>{fmtT(ev.promptTokens)} tok</b> are billed as new for this call.</>
        )}
      </div>
    );
  } else if (ev.recommit > 100) {
    recommitCallout = (
      <div style={{ background: theme.cost.recommitBg, border: "1px solid " + theme.cost.recommitBorder, color: theme.cost.cwrite, padding: "8px 11px", margin: "0 0 12px", borderRadius: 4, fontSize: theme.fontSize.sm, lineHeight: 1.55 }}>
        ↻ <b style={{ color: theme.text.primary }}>{fmtT(ev.recommit)} tok</b> of this call's billed-as-new content was actually <b>cache recommit</b> -- material the agent already had, but the cache expired so it had to be re-sent at premium rate. Net new context this call vs the previous one: <b style={{ color: theme.text.primary }}>{fmtTSigned(ev.deltaVsPrev)} tok</b>.
      </div>
    );
  }

  return (
    <div style={{ gridColumn: "1 / -1", background: theme.bg.base, borderBottom: "1px solid " + theme.border.subtle, padding: "14px 22px" }}>
      <h4 style={{ margin: "0 0 8px", color: theme.text.primary, fontSize: theme.fontSize.base, fontWeight: 600, letterSpacing: 0.4, textTransform: "uppercase" }}>
        What happened in this LLM call
      </h4>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 10, marginBottom: 14 }}>
        {(function () {
          var hasPx = ev.model && hasModelPricing(ev.model);
          // Granular cost components -- estimateCost handles the per-model
          // ratios (cache-read at ~10% of input for Anthropic / 50% for GPT,
          // cache-write at 125% / 100%, etc.). Decomposing lets us label each
          // KPI card with the dollars it contributed.
          var cachedCost = hasPx ? estimateCost({ inputTokens: 0, outputTokens: 0, cacheRead: ev.cached || 0, cacheWrite: 0 }, ev.model) : 0;
          var freshCost  = hasPx ? estimateCost({ inputTokens: ev.fresh || 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0 }, ev.model) : 0;
          var cwriteCost = hasPx ? estimateCost({ inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: ev.cacheWrite || 0 }, ev.model) : 0;
          var newBillCost = freshCost + cwriteCost;
          var inputCost = cachedCost + newBillCost;
          var outputCost = hasPx ? estimateCost({ inputTokens: 0, outputTokens: ev.output || 0, cacheRead: 0, cacheWrite: 0 }, ev.model) : 0;
          var pctNew = inputCost > 0 ? Math.round(100 * newBillCost / inputCost) : 0;
          var pctCache = 100 - pctNew;
          return (
          <>
        <div style={{ background: theme.bg.surface, border: "1px solid " + theme.cost.switchBorder, borderRadius: 5, padding: "10px 12px" }}
             title={hasPx ? "Total input cost = cache-read + billed-as-new (fresh + cache-write). Cache reads are charged at the model's discounted cache rate." : ""}>
          <div style={{ fontSize: theme.fontSize.xs, color: theme.text.muted, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 5 }}>▶ Input (context window)</div>
          <div style={{ fontSize: theme.fontSize.lg, color: theme.cost.cached, fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>{fmtT(ev.promptTokens)} tok</div>
          <div style={{ fontSize: theme.fontSize.xs, color: theme.text.secondary, marginTop: 3, fontVariantNumeric: "tabular-nums" }}>
            {hasPx
              ? fmt$(cachedCost) + " cached + " + fmt$(newBillCost) + " new = " + fmt$(inputCost)
              : "cache + new combined"}
          </div>
        </div>
        <div style={{ background: theme.bg.surface, border: "1px solid " + theme.cost.okBorder, borderRadius: 5, padding: "10px 12px" }}
             title="Net new = how much the context grew vs the previous call on this model (in tokens). The cost split shows what share of this call's input dollars went to cache reads vs billed-as-new content.">
          <div style={{ fontSize: theme.fontSize.xs, color: theme.text.muted, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 5 }}>▲ Net new vs previous call</div>
          <div style={{ fontSize: theme.fontSize.lg, color: theme.cost.fresh, fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>{fmtTSigned(ev.deltaVsPrev)} tok</div>
          <div style={{ fontSize: theme.fontSize.xs, color: theme.text.secondary, marginTop: 3, fontVariantNumeric: "tabular-nums" }}>
            {hasPx && inputCost > 0
              ? pctCache + "% from cache · " + pctNew + "% billed-new"
              : (ev.modelSwitched ? "new model -- cache reset" : (ev.prevPt ? "prev call had " + fmtT(ev.prevPt) + " ctx" : "first call in session"))}
          </div>
        </div>
        <div style={{ background: theme.bg.surface, border: "1px solid " + theme.cost.recommitBorder, borderRadius: 5, padding: "10px 12px" }}
             title="Tokens the API treated as new this call: fresh content plus any cache-write tokens (re-committed at premium rate). The cost shown is a SUBSET of input cost (already counted there).">
          <div style={{ fontSize: theme.fontSize.xs, color: theme.text.muted, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 5 }}>$ Billed as new (full + premium)</div>
          <div style={{ fontSize: theme.fontSize.lg, color: theme.cost.cwrite, fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>{fmtT(ev.newTotal)} tok</div>
          <div style={{ fontSize: theme.fontSize.xs, color: theme.text.secondary, marginTop: 3, fontVariantNumeric: "tabular-nums" }}>
            {hasPx
              ? fmt$(newBillCost) + " (subset of input)" + (ev.recommit > 100 ? " · incl. " + fmtT(ev.recommit) + " recommit" : "")
              : (ev.recommit > 100 ? "incl. " + fmtT(ev.recommit) + " cache recommit" : "minimal recommit")}
          </div>
        </div>
        <div style={{ background: theme.bg.surface, border: "1px solid " + theme.border.default, borderRadius: 5, padding: "10px 12px" }}
             title={hasPx ? "Output is billed at the model's output rate (typically ~5x input). Input + Output = the row total." : "Pricing unknown for this model"}>
          <div style={{ fontSize: theme.fontSize.xs, color: theme.text.muted, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 5 }}>◀ Output (model wrote)</div>
          <div style={{ fontSize: theme.fontSize.lg, color: theme.text.primary, fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>{fmtT(ev.output)} tok</div>
          <div style={{ fontSize: theme.fontSize.xs, color: theme.text.secondary, marginTop: 3, fontVariantNumeric: "tabular-nums" }}>
            {hasPx ? fmt$(outputCost) + " · input + output = " + fmt$(inputCost + outputCost) : "this call: " + fmt$(ev.cost) + " total"}
          </div>
        </div>
          </>
          );
        })()}
      </div>
      {missCallout}
      {recommitCallout}
      {ev.newImages && ev.newImages.length > 0 && (() => {
        var price = ev.model ? getModelPrice(ev.model) : null;
        var imgRows = ev.newImages.map(function (img) {
          var tok = estimateImageTokens(ev.model, img.detail);
          var dollars = imageDollarCost(price, tok);
          return { img: img, tok: tok, dollars: dollars };
        });
        var totalTok = imgRows.reduce(function (s, r) { return s + r.tok; }, 0);
        var totalDollars = imgRows.reduce(function (s, r) { return s + r.dollars; }, 0);
        var anyKnown = imgRows.some(function (r) { return r.tok > 0; });
        return (
        <div style={{
          background: theme.bg.surface, border: "1px solid " + theme.border.default,
          borderRadius: 5, padding: "9px 12px", marginBottom: 12,
          fontSize: theme.fontSize.sm, color: theme.text.secondary, lineHeight: 1.5,
        }}>
          <div style={{ fontSize: theme.fontSize.xs, color: theme.text.muted, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 5, fontWeight: 600 }}>
            📎 New image attachment{ev.newImages.length === 1 ? "" : "s"} ({ev.newImages.length})
            {ev.images.length > ev.newImages.length && (
              <span style={{ color: theme.text.muted, fontWeight: 400, textTransform: "none", letterSpacing: 0, marginLeft: 8 }}>
                · {ev.images.length - ev.newImages.length} more carried from cache
              </span>
            )}
          </div>
          {imgRows.map(function (r, i) {
            return (
              <div key={i} style={{ display: "flex", gap: 10, alignItems: "baseline", fontFamily: theme.font.mono, fontSize: theme.fontSize.xs }}>
                <span style={{ color: theme.text.primary }}>{r.img.mediaType}</span>
                {r.img.detail && <span style={{ color: theme.text.muted }}>· detail: {r.img.detail}</span>}
                {r.tok > 0 && (
                  <span style={{ color: theme.text.muted }} title="Estimated from model + detail field. The export does not report image token usage; this is a documented vendor approximation.">
                    · ~{fmtT(r.tok)} tok{r.dollars > 0 ? " (~" + fmt$(r.dollars) + ")" : ""}
                  </span>
                )}
                <a href={r.img.url} target="_blank" rel="noreferrer" style={{ color: theme.text.muted, textDecoration: "underline", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={r.img.url}>
                  {r.img.url.replace(/^https?:\/\//, "")}
                </a>
              </div>
            );
          })}
          <div style={{ fontStyle: "italic", color: theme.text.muted, fontSize: theme.fontSize.xs, marginTop: 6 }}>
            {anyKnown
              ? "Total est. ~" + fmtT(totalTok) + " tok" + (totalDollars > 0 ? " (~" + fmt$(totalDollars) + ")" : "") + " -- estimated from model + detail field; the export does not report exact image tokens."
              : "Token cost not estimated -- no documented image cost rule for this model."}
          </div>
        </div>
        );
      })()}
      <NewBlock newPerBucket={ev.newPerBucket} newTotal={ev.newTotal} totalIn={ev.promptTokens} label="this call" />
      {(function () {
        var npb = ev.newPerBucket || {};
        var newSum = CTX_INPUT_KEYS.reduce(function (a, k) { return a + (npb[k] || 0); }, 0) || 1;
        var newPct = function (k) { return 100 * (npb[k] || 0) / newSum; };
        var visible = CTX_INPUT_KEYS.filter(function (k) { return (npb[k] || 0) > 0; });
        if (visible.length === 0) {
          return (
            <div style={{ fontSize: theme.fontSize.sm, color: theme.text.muted, fontStyle: "italic", padding: "8px 0" }}>
              Nothing new in this call -- 100% of the input was served from cache.
            </div>
          );
        }
        var bodyForBucket = function (k) {
          if (k === "system") return <div style={textBlockStyle}>{ev.systemPreview}{ev.systemPreview && ev.systemPreview.length >= 300 ? "…" : ""}</div>;
          if (k === "tool_defs") return (
            <>
              <div style={{ color: theme.text.secondary, fontSize: theme.fontSize.sm, marginBottom: 5 }}>{ev.totalTools} tools available, grouped by source</div>
              <ToolGroups groups={ev.toolGroups} />
            </>
          );
          if (k === "history") return (
            <>
              <div style={{ fontSize: theme.fontSize.xs, color: theme.text.muted, marginBottom: 4 }}>
                {ev.newHistoryMsgs.length} new message{ev.newHistoryMsgs.length === 1 ? "" : "s"} appended (of {ev.historyMsgs.length} total in history)
              </div>
              <HistoryList msgs={ev.newHistoryMsgs} />
            </>
          );
          if (k === "tool_results") return (
            <>
              <div style={{ fontSize: theme.fontSize.xs, color: theme.text.muted, marginBottom: 4 }}>
                {ev.newToolResultMsgs.length} new tool result{ev.newToolResultMsgs.length === 1 ? "" : "s"} appended (of {ev.toolResultMsgs.length} total)
              </div>
              <ToolResultList msgs={ev.newToolResultMsgs} />
            </>
          );
          if (k === "current") return (
            <>
              <div style={textBlockStyle}>{ev.currentText || "(empty)"}{ev.currentText && ev.currentText.length >= 400 ? "…" : ""}</div>
              {ev.imageTokensEst > 0 && (
                <div style={{ marginTop: 6, fontSize: theme.fontSize.xs, color: theme.text.muted, fontStyle: "italic" }}>
                  Includes ~{fmtT(ev.imageTokensEst)} estimated image tokens (see 📎 attachment block above for per-image breakdown).
                </div>
              )}
            </>
          );
          return null;
        };
        return (
          <>
            <div style={{ fontSize: theme.fontSize.xs, color: theme.text.muted, textTransform: "uppercase", letterSpacing: 0.5, margin: "4px 0 8px", fontWeight: 600 }}>
              What's new in this call ({fmtT(ev.newTotal)} tok across {visible.length} bucket{visible.length === 1 ? "" : "s"})
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
              {visible.map(function (k) {
                return (
                  <DetailSection key={k} bucket={k} value={npb[k]} pct={newPct(k)} pctLabel="of new" valuePrefix="+">
                    {bodyForBucket(k)}
                  </DetailSection>
                );
              })}
            </div>
          </>
        );
      })()}
      {(function () {
        var hasText = ev.responsePreview && ev.responsePreview.trim().length > 0;
        var calls = ev.producedToolCalls || [];
        if (!hasText && calls.length === 0) return null;
        return (
          <div style={{ marginTop: 14 }}>
            <div style={{ fontSize: theme.fontSize.xs, color: theme.text.muted, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 5, fontWeight: 600 }}>
              Response ({fmtT(ev.output)} output tok)
            </div>
            {hasText && <div style={textBlockStyle}>{ev.responsePreview}</div>}
            {!hasText && calls.length > 0 && (
              <div style={{ ...textBlockStyle, color: theme.text.secondary, fontStyle: "italic", marginBottom: 6 }}>
                No text content -- the model spent its {fmtT(ev.output)} output tokens emitting {calls.length} tool call{calls.length === 1 ? "" : "s"}:
              </div>
            )}
            {calls.length > 0 && (
              <div style={{
                background: theme.bg.base, border: "1px dashed " + theme.border.default,
                borderRadius: 3, padding: "6px 10px", marginTop: hasText ? 6 : 0,
              }}>
                {calls.map(function (tc, i) {
                  return (
                    <div key={i} style={{ display: "flex", gap: 8, alignItems: "baseline", fontFamily: theme.font.mono, fontSize: theme.fontSize.xs, lineHeight: 1.7 }}>
                      <span style={{ color: theme.text.muted }}>→</span>
                      <span style={{ color: theme.text.primary, fontWeight: 600 }}>{tc.name || "(unnamed tool)"}</span>
                      {tc.argsSummary && <span style={{ color: theme.text.muted, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{tc.argsSummary}</span>}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })()}
    </div>
  );
}

var textBlockStyle = {
  background: theme.bg.base,
  border: "1px dashed " + theme.border.default,
  borderRadius: 3,
  padding: "8px 10px",
  marginTop: 6,
  color: theme.text.primary,
  fontSize: theme.fontSize.sm,
  lineHeight: 1.55,
  maxHeight: 120,
  overflow: "auto",
  whiteSpace: "pre-wrap",
};

function detectResponseShape(preview) {
  if (!preview) return "empty";
  var s = preview.trimStart();
  if (s.startsWith("{")) return "JSON object";
  if (s.startsWith("[")) return "JSON array";
  if (s.indexOf("```") >= 0) return "Markdown";
  return "Text";
}

function ToolDetail(props) {
  var ev = props.event;
  var sectionLabelStyle = {
    fontSize: theme.fontSize.xs,
    color: theme.text.muted,
    textTransform: "uppercase",
    letterSpacing: 0.6,
    fontWeight: 600,
    marginBottom: 5,
    display: "flex",
    alignItems: "center",
    gap: 6,
  };
  var arrowChip = function (color, label) {
    return (
      <span style={{
        background: theme.bg.raised,
        color: color,
        padding: "1px 6px",
        borderRadius: 3,
        fontSize: theme.fontSize.xs,
        fontWeight: 700,
        letterSpacing: 0.4,
      }}>{label}</span>
    );
  };
  var blockStyle = function (accentColor) {
    return Object.assign({}, textBlockStyle, {
      borderLeft: "3px solid " + accentColor,
      borderTop: "1px solid " + theme.border.subtle,
      borderRight: "1px solid " + theme.border.subtle,
      borderBottom: "1px solid " + theme.border.subtle,
      borderStyle: "solid",
      maxHeight: 200,
    });
  };
  var shape = detectResponseShape(ev.resultPreview);
  return (
    <div style={{ gridColumn: "1 / -1", background: theme.bg.base, borderBottom: "1px solid " + theme.border.subtle, padding: "14px 22px" }}>
      <h4 style={{ margin: "0 0 10px", color: theme.text.primary, fontSize: theme.fontSize.base, fontWeight: 600, letterSpacing: 0.4, textTransform: "uppercase" }}>
        Tool call · {ev.name}
      </h4>

      {/* 1. Thinking */}
      {ev.thinking && (
        <div style={{ marginBottom: 12 }}>
          <div style={sectionLabelStyle}>
            {arrowChip(theme.text.muted, "1 · think")}
            <span>Assistant thinking before the call</span>
          </div>
          <div style={Object.assign({}, blockStyle(theme.text.muted), { fontStyle: "italic" })}>
            {ev.thinking.slice(0, 400)}{ev.thinking.length > 400 ? "…" : ""}
          </div>
        </div>
      )}

      {/* 2. Input */}
      <div style={{ marginBottom: 12 }}>
        <div style={sectionLabelStyle}>
          {arrowChip(theme.cost.fresh, "2 · input →")}
          <span>Arguments sent to <code style={{ color: theme.text.primary }}>{ev.name}</code></span>
        </div>
        {ev.argsSummary
          ? <div style={blockStyle(theme.cost.fresh)}>{ev.argsSummary}</div>
          : <div style={{ color: theme.text.ghost, fontStyle: "italic", fontSize: theme.fontSize.sm }}>(no arguments)</div>}
      </div>

      {/* 3. Output */}
      <div>
        <div style={sectionLabelStyle}>
          {arrowChip(theme.cost.ctxHistory, "3 · ← output")}
          <span>Result returned by <code style={{ color: theme.text.primary }}>{ev.name}</code></span>
          <span style={{
            marginLeft: "auto",
            background: theme.bg.raised,
            color: theme.text.secondary,
            padding: "1px 6px",
            borderRadius: 3,
            fontSize: theme.fontSize.xs,
            fontWeight: 600,
            border: "1px solid " + theme.border.subtle,
          }}>
            {shape} · {fmtT(ev.resultTokens || 0)} tok · {(ev.resultChars || 0).toLocaleString()} chars
          </span>
        </div>
        <div style={{ color: theme.text.muted, fontSize: theme.fontSize.xs, marginBottom: 4 }}>
          → Will be folded into the <b style={{ color: theme.cost.ctxHistory }}>tool_results</b> bucket of the next LLM call's context.
        </div>
        {ev.resultPreview
          ? <div style={blockStyle(theme.cost.ctxHistory)}>{ev.resultPreview}{ev.resultPreview.length >= 200 ? "\n\n…(truncated preview)" : ""}</div>
          : <div style={{ color: theme.text.ghost, fontStyle: "italic", fontSize: theme.fontSize.sm }}>(no preview captured)</div>}
      </div>
    </div>
  );
}

function PromptNewMini(props) {
  var p = props.prompt;
  var pa = p.prompt; // PromptAnalysis
  var newPerBucket = pa.newPerBucket || {};
  var sum = CTX_INPUT_KEYS.reduce(function (a, k) { return a + (newPerBucket[k] || 0); }, 0) || 1;
  var missCalls = (p.events || []).filter(function (e) { return e.kind === "llm" && e.unexpectedMiss; });
  var missTotal = missCalls.reduce(function (a, e) { return a + (e.promptTokens || 0); }, 0);
  var missCost = missCalls.reduce(function (a, e) { return a + (e.cost || 0); }, 0);
  return (
    <div style={{ background: theme.bg.base, border: "1px solid " + theme.border.default, borderRadius: 4, padding: "6px 9px" }}>
      <div style={{ fontSize: theme.fontSize.xs, color: theme.text.muted, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 4, display: "flex", justifyContent: "space-between" }}>
        <span>Billed as new this prompt</span>
        <b style={{ color: theme.cost.fresh }}>{fmtT(pa.newTotal)}</b>
      </div>
      <div style={{ height: 10, background: theme.bg.surface, borderRadius: 1, overflow: "hidden", display: "flex" }}>
        {sum > 1 ? CTX_INPUT_KEYS.map(function (k) {
          var v = newPerBucket[k] || 0;
          if (v === 0) return null;
          var w = 100 * v / sum;
          return <div key={k} title={CTX_LABELS[k] + ": " + fmtT(v) + " new tok"} style={{ height: "100%", background: CTX_COLORS[k], width: w + "%" }} />;
        }) : <div style={{ height: "100%", background: theme.border.default, width: "100%" }} />}
      </div>
      {missCalls.length > 0 && (
        <div style={{ fontSize: theme.fontSize.xs, color: theme.cost.missText, marginTop: 4, fontStyle: "italic", lineHeight: 1.3 }}>
          ⚠ {missCalls.length} unexpected cache miss{missCalls.length > 1 ? "es" : ""} -- {fmtT(missTotal)} tok re-billed at premium (~{fmt$(missCost)})
        </div>
      )}
      {pa.modelSwitchedIn ? (
        <div style={{ fontSize: theme.fontSize.xs, color: theme.cost.switchText, marginTop: 4, fontStyle: "italic", lineHeight: 1.3 }}>
          ⇄ Model switch -- fresh cache, all context is genuinely new to this model
        </div>
      ) : (pa.cacheRecommit > 200 && (
        <div style={{ fontSize: theme.fontSize.xs, color: theme.cost.cwrite, marginTop: 4, fontStyle: "italic", lineHeight: 1.3 }}>
          ↻ {fmtT(pa.cacheRecommit)} of this is cache recommit (already in context, cache expired)
        </div>
      ))}
    </div>
  );
}

function Kpis(props) {
  var t = props.totals;
  var sa = props.subagentEst || {};
  var notes = [];
  if (sa.overheadCount > 0) {
    notes.push({
      text: "incl. " + fmt$(sa.overheadCost) + " overhead (" + sa.overheadCount + " " + (sa.overheadCount === 1 ? "call" : "calls") + ")",
      title: "Overhead calls (title generation, prompt categorization) are already counted in this total. Toggle 'Show overhead calls' above to filter them from the visualization.",
      color: theme.text.muted,
    });
  }
  if (sa.count > 0) {
    notes.push({
      text: "+ ~" + fmt$(sa.cost) + " est. subagent (" + sa.count + " " + (sa.count === 1 ? "call" : "calls") + ")",
      title: "VS Code's export does not report subagent token usage. This is estimated from each subagent's args.prompt length (~4 chars/token) and its model price.",
      color: theme.text.secondary,
    });
  }
  if (sa.imageCount > 0) {
    if (sa.imageCost > 0) {
      notes.push({
        text: "+ ~" + fmt$(sa.imageCost) + " est. images (" + sa.imageCount + " " + (sa.imageCount === 1 ? "image" : "images") + ", ~" + fmtT(sa.imageTokens) + " tok)",
        title: "Image input tokens are estimated from each attachment's `detail` field and the model's documented vision pricing rule. The export does not report exact image tokens, so this is an approximation that is NOT included in the headline Total cost.",
        color: theme.text.secondary,
      });
    } else {
      notes.push({
        text: "+ image cost not measured (" + sa.imageCount + " " + (sa.imageCount === 1 ? "image" : "images") + ")",
        title: "Images are attached but no documented vision-pricing rule is available for this model, so token cost can't be estimated.",
        color: theme.text.muted,
      });
    }
  }
  var totalCostItem = { l: "Total cost", v: fmt$(t.cost), notes: notes };
  var items = [
    totalCostItem,
    { l: "Billed input", v: fmtT(t.promptTokens), d: fmtT(t.cached) + " cached (" + (100 * t.cacheHitRate).toFixed(0) + "%)" },
    { l: "Output", v: fmtT(t.output) },
    { l: "LLM calls", v: "" + t.llmCalls },
    { l: "Tool calls", v: "" + t.toolCalls },
  ];
  if (t.cacheWrite > 0) {
    items.splice(3, 0, { l: "Cache write", v: fmtT(t.cacheWrite) });
  }
  if (t.unexpectedMissCount > 0) {
    items.push({ l: "⚠ Unexpected misses", v: "" + t.unexpectedMissCount, d: "wasted ~" + fmt$(t.unexpectedMissCost), warn: true });
  }
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(" + items.length + ", 1fr)", gap: 12, marginBottom: 28 }}>
      {items.map(function (k, i) {
        return (
          <div key={i} style={{
            background: theme.bg.surface,
            border: "1px solid " + (k.warn ? theme.cost.missBorder : theme.border.default),
            borderRadius: theme.radius.md, padding: "12px 14px",
          }}>
            <div style={{ color: theme.text.muted, fontSize: theme.fontSize.xs, textTransform: "uppercase", letterSpacing: 0.6 }}>{k.l}</div>
            <div style={{ fontSize: theme.fontSize.xl, fontWeight: 600, color: k.warn ? theme.cost.missText : theme.text.primary, marginTop: 4, fontVariantNumeric: "tabular-nums" }}>{k.v}</div>
            {k.d && <div style={{ color: theme.semantic.success, fontSize: theme.fontSize.xs, marginTop: 2 }}>{k.d}</div>}
            {k.notes && k.notes.map(function (n, ni) {
              return (
                <div key={ni} title={n.title} style={{ color: n.color, fontSize: theme.fontSize.xs, marginTop: 2, cursor: n.title ? "help" : "default", lineHeight: 1.35 }}>
                  {n.text}
                </div>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}

function Glossary() {
  var term = function (color, bg) {
    return {
      display: "inline-block", background: bg || theme.bg.surface, color: color, padding: "1px 7px",
      borderRadius: 9, fontSize: theme.fontSize.xs, fontWeight: 600, letterSpacing: 0.4, marginRight: 4,
    };
  };
  return (
    <div style={{ background: theme.bg.base, border: "1px solid " + theme.border.default, borderRadius: 5, padding: "11px 14px", marginBottom: 20, fontSize: theme.fontSize.sm, color: theme.text.secondary, lineHeight: 1.7 }}>
      <span style={term(theme.cost.fresh)}>CTX</span><b style={{ color: theme.text.primary }}>Context window</b> -- actual size of one LLM call's input (= API <code>prompt_tokens</code>).
      &nbsp;&nbsp;<span style={term(theme.cost.fresh)}>▲ NET</span><b style={{ color: theme.text.primary }}>Net new context</b> -- how much working memory actually grew vs the previous call.
      &nbsp;&nbsp;<span style={term(theme.cost.cwrite, theme.cost.chipBgExtension)}>$ BILLED</span><b style={{ color: theme.text.primary }}>Billed input</b> -- sum of <code>prompt_tokens</code> across calls (cache reads still cost; cache writes cost more).
      &nbsp;&nbsp;<span style={term(theme.cost.cwrite, theme.cost.chipBgExtension)}>↻ RECOMMIT</span><b style={{ color: theme.text.primary }}>Cache recommit</b> -- content the agent already had to send again because the cache expired.
    </div>
  );
}

function Legend() {
  var swatchStyle = function (color) { return { display: "inline-block", width: 10, height: 10, marginRight: 5, borderRadius: 2, verticalAlign: "-1px", background: color }; };
  var groupStyle = { padding: "6px 10px", background: theme.bg.base, border: "1px solid " + theme.border.default, borderRadius: 4, display: "flex", flexWrap: "wrap", gap: 10 };
  var labelStyle = { color: theme.text.muted, textTransform: "uppercase", letterSpacing: 0.5, fontWeight: 600, fontSize: theme.fontSize.xs, marginRight: 4 };
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 14, margin: "8px 0 20px", fontSize: theme.fontSize.sm, color: theme.text.secondary }}>
      <div style={groupStyle}>
        <b style={labelStyle}>cost type</b>
        <span><span style={swatchStyle(COST_COLORS.fresh)} />fresh input</span>
        <span><span style={swatchStyle(COST_COLORS.cwrite)} />cache write</span>
        <span><span style={swatchStyle(COST_COLORS.cached)} />cached read</span>
        <span><span style={swatchStyle(COST_COLORS.output)} />output</span>
      </div>
      <div style={groupStyle}>
        <b style={labelStyle}>context part</b>
        {CTX_KEYS.map(function (k) { return <span key={k}><span style={swatchStyle(CTX_COLORS[k])} />{CTX_LABELS[k]}</span>; })}
      </div>
    </div>
  );
}

export default function CostView(props) {
  var analysis = props.analysis;
  var [openRow, setOpenRow] = useState({});
  var [showOverhead, setShowOverhead] = useState(false);
  var [unit, setUnit] = usePersistentState("agentviz.cost.unit", "credits");
  // Keep the module-level fmt$ helper in sync. Use a layout-time effect so the
  // very first render after a unit change already formats with the new unit.
  setCostUnit(unit);
  useEffect(function () { setCostUnit(unit); }, [unit]);

  if (!analysis || !analysis.prompts || !analysis.prompts.length) {
    return (
      <div style={{ padding: 40, color: theme.text.secondary, textAlign: "center", fontFamily: theme.font.mono }}>
        Cost analysis isn't available for this session format.
        <br />
        Load a VS Code Copilot Chat <code>copilot_all_prompts_*.json</code> export to see the cost breakdown.
      </div>
    );
  }

  // Pre-compute cumulative cost states (one per event in document order).
  var cumStates = useMemo(function () { return buildCumStates(analysis.prompts, showOverhead); }, [analysis, showOverhead]);
  var maxCost = cumStates.length
    ? cumStates[cumStates.length - 1].fresh + cumStates[cumStates.length - 1].cached + cumStates[cumStates.length - 1].cwrite + cumStates[cumStates.length - 1].output
    : 0.0001;
  var allLLM = [];
  analysis.prompts.forEach(function (p) {
    p.events.forEach(function (e) { if (e.kind === "llm") allLLM.push(e); });
  });
  var maxCtx = Math.max.apply(null, allLLM.map(function (e) { return e.promptTokens + (e.output || 0); }).concat([1]));

  // Sum estimated subagent cost across the session. Estimates only apply to
  // runSubagent calls when we know the subagent's model; others are skipped
  // so the number stays honest.
  // Also sum overhead-call cost (already included in totals) and count
  // images (not measured at all -- export carries no token usage for them).
  var subagentEst = useMemo(function () {
    var saCount = 0, saCost = 0;
    var ohCount = 0, ohCost = 0;
    var imgCount = 0, imgCost = 0, imgTokens = 0;
    analysis.prompts.forEach(function (p) {
      p.events.forEach(function (e) {
        if (e.kind === "tool" && e.subagent) {
          saCount += 1;
          if (e.subagent.modelName && hasModelPricing(e.subagent.modelName)) {
            saCost += estimateCost({
              inputTokens: e.subagent.promptTokensEst || 0,
              outputTokens: e.resultTokens || 0,
              cacheRead: 0, cacheWrite: 0,
            }, e.subagent.modelName);
          }
        } else if (e.kind === "llm") {
          if (e.category === "overhead") {
            ohCount += 1;
            ohCost += e.cost || 0;
          }
          if (e.newImages && e.newImages.length > 0) {
            imgCount += e.newImages.length;
            var price = e.model ? getModelPrice(e.model) : null;
            for (var ii = 0; ii < e.newImages.length; ii++) {
              var tok = estimateImageTokens(e.model, e.newImages[ii].detail);
              imgCost += imageDollarCost(price, tok);
              imgTokens += tok;
            }
          }
        }
      });
    });
    return { count: saCount, cost: saCost, overheadCount: ohCount, overheadCost: ohCost, imageCount: imgCount, imageCost: imgCost, imageTokens: imgTokens };
  }, [analysis]);

  var rowKey = function (pi, ei) { return pi + ":" + ei; };
  var toggle = function (pi, ei) { var k = rowKey(pi, ei); setOpenRow(Object.assign({}, openRow, { [k]: !openRow[k] })); };

  // Count overhead calls across the whole session for the toolbar label.
  var overheadCount = 0, overheadCost = 0;
  analysis.prompts.forEach(function (p) {
    p.events.forEach(function (e) {
      if (e.kind === "llm" && e.category === "overhead") {
        overheadCount += 1;
        overheadCost += e.cost || 0;
      }
    });
  });

  var globalEventIdx = 0;

  return (
    <div style={{ height: "100%", overflowY: "auto", overflowX: "hidden", background: theme.bg.base }}>
    <div style={{ maxWidth: 1700, margin: "0 auto", padding: "32px 28px 80px", fontFamily: theme.font.mono, fontSize: theme.fontSize.md, color: theme.text.primary }}>
      <h1 style={{ fontSize: theme.fontSize.xl, fontWeight: 600, margin: "0 0 4px", color: theme.text.primary, letterSpacing: 0.4 }}>
        Token cost &amp; context buildup
      </h1>
      <div style={{ color: theme.text.muted, fontSize: theme.fontSize.base, marginBottom: 24 }}>
        Three different lenses on "input": context size, growth, and billing.
      </div>

      <Kpis totals={analysis.totals} subagentEst={subagentEst} />
      <Glossary />
      <Legend />

      <div style={{
        display: "flex", alignItems: "center", gap: 12, margin: "0 0 12px",
        padding: "8px 12px", background: theme.bg.surface,
        border: "1px solid " + theme.border.default, borderRadius: 5,
        fontSize: theme.fontSize.sm, color: theme.text.secondary,
      }}>
        <span style={{ color: theme.text.muted }}>Show costs as:</span>
        <div role="radiogroup" aria-label="Cost display unit" style={{
          display: "inline-flex", border: "1px solid " + theme.border.default,
          borderRadius: 4, overflow: "hidden",
        }}>
          {[
            { id: "credits", label: "AI Credits", title: "1 credit = $0.01 (GitHub Copilot AI Credits)" },
            { id: "currency", label: "USD ($)", title: "Raw provider $ rates from pricing.js" },
          ].map(function (opt) {
            var active = unit === opt.id;
            return (
              <button
                key={opt.id}
                type="button"
                role="radio"
                aria-checked={active}
                title={opt.title}
                onClick={function () { setUnit(opt.id); }}
                style={{
                  padding: "4px 10px", border: "none", cursor: "pointer",
                  background: active ? theme.cost.fresh : "transparent",
                  color: active ? theme.bg.base : theme.text.secondary,
                  fontFamily: theme.font.mono, fontSize: theme.fontSize.sm,
                  fontWeight: active ? 600 : 400,
                }}
              >{opt.label}</button>
            );
          })}
        </div>
        <span style={{ color: theme.text.muted, fontSize: theme.fontSize.xs }}>
          {unit === "credits"
            ? "100 cr = $1. Persists across sessions."
            : "Raw USD from per-token rates. Persists across sessions."}
        </span>
      </div>

      {overheadCount > 0 && (
        <div style={{
          display: "flex", alignItems: "center", gap: 8, margin: "0 0 12px",
          padding: "8px 12px", background: theme.bg.surface,
          border: "1px solid " + theme.border.default, borderRadius: 5,
          fontSize: theme.fontSize.sm, color: theme.text.secondary,
        }}>
          <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
            <input
              type="checkbox"
              checked={showOverhead}
              onChange={function (e) { setShowOverhead(e.target.checked); }}
              style={{ cursor: "pointer" }}
            />
            <span>
              Show overhead LLM calls
              <span style={{ color: theme.text.muted, marginLeft: 6 }}>
                ({overheadCount} {overheadCount === 1 ? "call" : "calls"} ·{" "}
                {fmt$(overheadCost)} · e.g. <code>title</code>, <code>promptCategorization</code>)
              </span>
            </span>
          </label>
          <span style={{ marginLeft: "auto", color: theme.text.muted, fontSize: theme.fontSize.xs }}>
            Totals always include all calls.
          </span>
        </div>
      )}

      <div style={{
        display: "grid",
        gridTemplateColumns: "minmax(420px,1fr) 360px 360px",
        border: "1px solid " + theme.border.default, borderRadius: 6, overflow: "hidden", background: theme.bg.surface,
      }}>
        <div style={colHeadStyle}>Prompt &amp; steps</div>
        <div style={Object.assign({}, colHeadStyle, { borderLeft: "1px solid " + theme.border.default })}>Cumulative cost so far → max {fmt$(maxCost)}</div>
        <div style={Object.assign({}, colHeadStyle, { borderLeft: "1px solid " + theme.border.default })}>Context window for this call → max {fmtT(maxCtx)} tok</div>

        {(function () {
          var visiblePromptOrdinal = 0;
          return analysis.prompts.map(function (p, pi) {
          var cachedPct = 100 * p.cacheHitRate;
          var pa = p.prompt;
          // When hiding overhead calls, prompts whose only LLM activity is
          // overhead (e.g. background `title` / `promptCategorization` calls)
          // become empty. Skip rendering them entirely, but advance the
          // cumulative-state cursor so other prompts stay aligned.
          if (!showOverhead) {
            var visible = 0;
            p.events.forEach(function (e) {
              if (e.kind === "llm") {
                if (e.category !== "overhead") visible += 1;
              } else {
                visible += 1;
              }
            });
            if (visible === 0) {
              globalEventIdx += p.events.length;
              return null;
            }
          }
          visiblePromptOrdinal += 1;
          var displayOrdinal = visiblePromptOrdinal;
          return (
            <React.Fragment key={pi}>
              {/* Prompt header spans all 3 columns */}
              <div style={{
                gridColumn: "1 / -1",
                background: theme.bg.raised,
                borderTop: pi > 0 ? "1px solid " + theme.border.default : "none",
                borderBottom: "1px solid " + theme.border.default,
                padding: "14px 18px",
                display: "grid",
                gridTemplateColumns: "48px 1fr 220px auto",
                gap: 14,
                alignItems: "center",
              }}>
                <div style={{ fontSize: theme.fontSize.xs, color: theme.text.muted, textAlign: "center" }}>
                  <span style={{ fontSize: theme.fontSize.xxl, color: theme.text.primary, fontWeight: 700, display: "block", lineHeight: 1 }}>{displayOrdinal}</span>
                  prompt
                </div>
                <div>
                  <div style={{ color: theme.text.primary, fontSize: theme.fontSize.md, fontWeight: 500, lineHeight: 1.4 }}>{p.label || "(empty)"}</div>
                  <div style={{ color: theme.text.secondary, fontSize: theme.fontSize.sm, marginTop: 6, display: "grid", gap: 4 }}>
                    <div style={{ display: "flex", gap: 14, flexWrap: "wrap", alignItems: "baseline" }}>
                      <span style={{ color: theme.cost.cached }}>⊞ Context: <b style={{ color: theme.cost.cached, fontWeight: 600 }}>{fmtT(pa.contextInitial)} → {fmtT(pa.contextFinal)}</b></span>
                      <span style={{ color: theme.cost.fresh, fontWeight: 600 }}>▲ {fmtTSigned(pa.contextGrowth)} tok net new this prompt</span>
                      <span><b style={{ color: theme.text.primary, fontWeight: 500 }}>{p.llmCount}</b> LLM</span>
                      <span><b style={{ color: theme.text.primary, fontWeight: 500 }}>{p.toolCount}</b> tools</span>
                    </div>
                    <div style={{ color: theme.text.muted, fontSize: theme.fontSize.xs, display: "flex", gap: 14, flexWrap: "wrap" }}>
                      <span>$ Billed: <b style={{ color: theme.text.secondary }}>{fmtT(p.promptTokens)}</b> input · <b style={{ color: theme.text.secondary }}>{fmtT(p.output)}</b> output · <b style={{ color: theme.text.secondary }}>{cachedPct.toFixed(0)}%</b> cached · <b style={{ color: theme.text.secondary }}>{fmtT(pa.newTotal)}</b> billed-as-new</span>
                      {pa.cacheRecommit > 200 && <span style={{ color: theme.cost.cwrite }}>↻ <b>{fmtT(pa.cacheRecommit)}</b> recommit</span>}
                    </div>
                  </div>
                </div>
                <div><PromptNewMini prompt={p} /></div>
                <div style={{ fontSize: theme.fontSize.lg, fontWeight: 600, color: theme.text.primary, fontVariantNumeric: "tabular-nums", textAlign: "right" }}>{fmt$(p.cost)}</div>
              </div>

              {p.events.map(function (ev, ei) {
                var isLLM = ev.kind === "llm";
                var k = rowKey(pi, ei);
                var open = !!openRow[k];
                var cumState = cumStates[globalEventIdx];
                globalEventIdx += 1;
                // Hide overhead LLM rows when toggle is off, but keep
                // cumulative bars and totals correct (we already incremented
                // globalEventIdx above).
                if (isLLM && ev.category === "overhead" && !showOverhead) {
                  return null;
                }
                var cellBg = isLLM ? theme.bg.surface : theme.bg.raised;
                var meta = isLLM ? (
                  <div style={{ color: theme.text.muted, fontSize: theme.fontSize.xs, marginTop: 3, display: "flex", gap: 10, flexWrap: "wrap" }}>
                    <span>{(ev.model || "").split("-").slice(0, 3).join("-")}</span>
                    <span style={{ color: theme.cost.cached, cursor: "help" }}
                          title="Total input sent to the LLM this call (the full prompt). = cached + billed-new.">
                      ⊞ <b style={{ color: theme.cost.cached }}>{fmtT(ev.promptTokens)}</b> ctx
                    </span>
                    <span style={{ color: theme.cost.fresh, cursor: "help" }}
                          title="How much the prompt grew vs the previous call's prompt size. Independent of caching -- just measures growth. On the first call this equals the full context.">
                      ▲ <b style={{ color: theme.cost.fresh }}>{fmtTSigned(ev.deltaVsPrev)}</b> net new
                    </span>
                    <span style={{ cursor: "help" }}
                          title="Tokens served from prompt cache at ~10% of the input rate. Copilot caches at the GitHub service layer (not just per-session), so even the first call in a session can hit cache for stable prefixes like the system prompt and tool defs.">
                      <b style={{ color: theme.text.primary }}>{fmtT(ev.cached)}</b> cached
                    </span>
                    <span style={{ color: theme.cost.cwrite, cursor: "help" }}
                          title="Tokens NOT served from cache, billed at full input rate (or cache-write rate ~1.25x). = ctx - cached.">
                      $ <b>{fmtT(ev.newTotal)}</b> billed-new
                    </span>
                    <span style={{ color: theme.text.secondary }}>{fmt$(ev.cost)}</span>
                    {ev.unexpectedMiss && (
                      <span style={{ color: theme.cost.missText, background: theme.cost.missBg, border: "1px solid " + theme.cost.missBorder, padding: "1px 6px", borderRadius: 3 }}>⚠ unexpected cache miss</span>
                    )}
                  </div>
                ) : (
                  (function () {
                    if (ev.subagent) {
                      var sa = ev.subagent;
                      var inputTok = sa.promptTokensEst || 0;
                      var outputTok = ev.resultTokens || 0;
                      var costEst = (sa.modelName && hasModelPricing(sa.modelName))
                        ? estimateCost({ inputTokens: inputTok, outputTokens: outputTok, cacheRead: 0, cacheWrite: 0 }, sa.modelName)
                        : null;
                      return (
                        <div style={{ color: theme.text.muted, fontSize: theme.fontSize.xs, marginTop: 3, display: "flex", gap: 10, flexWrap: "wrap", alignItems: "baseline" }}>
                          <span>subagent</span>
                          {sa.modelName && <span style={{ color: theme.text.secondary }}>{sa.modelName}</span>}
                          <span title="Estimated from args.prompt length (~4 chars/token); the export does not include subagent token usage">
                            ▶ <b style={{ color: theme.cost.fresh }}>~{fmtT(inputTok)}</b> in
                          </span>
                          <span>◀ <b style={{ color: theme.cost.ctxHistory }}>{fmtT(outputTok)}</b> out</span>
                          {costEst != null
                            ? <span style={{ color: theme.text.secondary }} title="Estimated cost based on input/output token estimates and the subagent model price; not reported by VS Code">~{fmt$(costEst)}</span>
                            : <span style={{ color: theme.text.ghost, fontStyle: "italic" }} title="Subagent cost is not reported in the Copilot Chat export">cost n/a</span>}
                        </div>
                      );
                    }
                    return (
                      <div style={{ color: theme.text.muted, fontSize: theme.fontSize.xs, marginTop: 3, display: "flex", gap: 10 }}>
                        <span>tool call</span>
                        {ev.resultTokens > 0 && <span>→ <b style={{ color: theme.text.primary }}>{fmtT(ev.resultTokens)}</b> tok of result</span>}
                      </div>
                    );
                  })()
                );

                return (
                  <React.Fragment key={ei}>
                    <div onClick={function () { toggle(pi, ei); }}
                      style={{
                        padding: "8px 14px", borderBottom: "1px solid " + theme.border.subtle,
                        background: cellBg, display: "flex", alignItems: "center", minHeight: 38, cursor: "pointer",
                      }}>
                      <div style={{ display: "grid", gridTemplateColumns: "18px 18px 1fr", gap: 8, alignItems: "start", width: "100%" }}>
                        <div style={{ color: theme.text.muted, fontSize: theme.fontSize.xs, width: 14, textAlign: "center", marginTop: 3, transition: "transform .15s", transform: open ? "rotate(90deg)" : "none" }}>▶</div>
                        <div style={{
                          fontSize: theme.fontSize.xs, fontWeight: 600, width: 18, height: 18, borderRadius: 9,
                          display: "flex", alignItems: "center", justifyContent: "center", color: theme.text.primary, marginTop: 1,
                          background: isLLM ? theme.cost.cached : theme.cost.ctxHistory,
                        }}>{isLLM ? "L" : "T"}</div>
                        <div>
                          <div style={{ color: theme.text.primary, fontSize: theme.fontSize.base, fontWeight: 500, lineHeight: 1.4, display: "flex", alignItems: "baseline", gap: 6, flexWrap: "wrap" }}>
                            <span title={isLLM ? ev.name : undefined}>{isLLM ? friendlyCallName(ev.name) : ev.name}</span>
                            {isLLM && ev.name && friendlyCallName(ev.name) !== ev.name && (
                              <span style={{ color: theme.text.ghost, fontWeight: 400, fontSize: theme.fontSize.xs, fontFamily: theme.font.mono }}>
                                {ev.name}
                              </span>
                            )}
                            {isLLM && ev.category === "overhead" && (
                              <span style={{
                                fontSize: theme.fontSize.xs, fontWeight: 600, letterSpacing: 0.4,
                                textTransform: "uppercase", padding: "1px 6px", borderRadius: 3,
                                background: theme.bg.raised, color: theme.text.muted,
                                border: "1px solid " + theme.border.subtle,
                              }} title="UI/telemetry call, not the user-facing chat turn">overhead</span>
                            )}
                            {ev.subagent
                              ? (ev.subagent.description && <span style={{ color: theme.text.secondary, fontWeight: 400, marginLeft: 4 }}>· {ev.subagent.description}</span>)
                              : (ev.argsSummary && <span style={{ color: theme.text.muted, fontWeight: 400 }}>{ev.argsSummary}</span>)}
                          </div>
                          {meta}
                        </div>
                      </div>
                    </div>
                    <div style={{ padding: "8px 12px", borderBottom: "1px solid " + theme.border.subtle, background: cellBg, borderLeft: "1px solid " + theme.border.default, display: "flex", alignItems: "center" }}>
                      <StackBar parts={cumState} keys={["fresh", "cwrite", "cached", "output"]} colors={COST_COLORS} labels={COST_LABELS} maxVal={maxCost} withLabel />
                    </div>
                    <div style={{ padding: "8px 12px", borderBottom: "1px solid " + theme.border.subtle, background: cellBg, borderLeft: "1px solid " + theme.border.default, display: "flex", alignItems: "center" }}>
                      {isLLM
                        ? <StackBar parts={ev.components} keys={CTX_KEYS} colors={CTX_COLORS} labels={CTX_LABELS} maxVal={maxCtx} withLabel />
                        : <span style={{ color: theme.text.ghost, fontSize: theme.fontSize.xs, fontStyle: "italic" }}>→ result lands in next LLM call</span>}
                    </div>
                    {open && (isLLM ? <LLMDetail event={ev} /> : <ToolDetail event={ev} />)}
                  </React.Fragment>
                );
              })}
            </React.Fragment>
          );
          });
        })()}
      </div>
    </div>
    </div>
  );
}

var colHeadStyle = {
  background: theme.bg.base,
  padding: "11px 14px",
  fontSize: theme.fontSize.xs,
  color: theme.text.muted,
  textTransform: "uppercase",
  letterSpacing: 0.6,
  borderBottom: "1px solid " + theme.border.default,
  fontWeight: 600,
};
