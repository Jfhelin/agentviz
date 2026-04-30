import React, { useState, useMemo } from "react";
import { theme } from "../lib/theme.js";

// Cost type colors (specific to this view — not in the global theme tokens
// because these are categorical labels rather than UI surface roles).
var COST_COLORS = {
  fresh: "#56d364",
  cwrite: "#f4b340",
  cached: "#3DA9D4",
  output: "#a371f7",
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
  system: "#7A8B9E",
  tool_defs: "#4A5568",
  history: "#E6A847",
  tool_results: "#B8642F",
  current: "#3DA9D4",
  output: "#2C7A99",
};
var CTX_LABELS = {
  system: "System",
  tool_defs: "Tool defs",
  history: "History",
  tool_results: "Tool results",
  current: "Current prompt",
  output: "Response",
};
var KIND_COLORS = { mcp: "#a371f7", extension: "#f4b340", builtin: "#3DA9D4" };

function fmt$(n) {
  if (n == null || isNaN(n)) return "$0";
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
function buildCumStates(prompts) {
  var freshAcc = 0, cwriteAcc = 0, cachedAcc = 0, outputAcc = 0;
  var states = [];
  prompts.forEach(function (p) {
    p.events.forEach(function (ev) {
      if (ev.kind === "llm") {
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
        <span style={{ color: theme.text.ghost, fontSize: 10, fontStyle: "italic", paddingLeft: 6, lineHeight: "18px" }}>—</span>
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
          fontSize: 9.5,
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
              style={{ display: "grid", gridTemplateColumns: "1fr auto auto", gap: 10, fontSize: 10.5, padding: "3px 0", alignItems: "center", cursor: "pointer" }}>
              <div style={{ color: theme.text.primary }}>
                <span style={{
                  display: "inline-block", fontSize: 9, padding: "1px 5px", borderRadius: 9,
                  marginRight: 6, fontWeight: 600, letterSpacing: 0.4,
                  background: g.kind === "mcp" ? "#3a2f4d" : g.kind === "extension" ? "#3a3318" : "#1f2a3a",
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
              <div style={{ paddingLeft: 10, color: theme.text.muted, fontSize: 10, borderLeft: "1px solid " + theme.border.default, marginBottom: 4 }}>
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
  if (!msgs.length) return <div style={{ color: theme.text.ghost, fontSize: 10, fontStyle: "italic" }}>no prior conversation</div>;
  return (
    <div>
      {msgs.map(function (m, i) {
        return (
          <div key={i} style={{ display: "grid", gridTemplateColumns: "auto 1fr auto", gap: 8, fontSize: 10.5, padding: "3px 0", alignItems: "baseline", borderTop: i === 0 ? "none" : "1px solid " + theme.border.subtle }}>
            <span style={{
              fontSize: 9, padding: "1px 5px", borderRadius: 9, fontWeight: 600, letterSpacing: 0.4,
              background: m.role === "user" ? "#3a3318" : "#1f3a2c",
              color: m.role === "user" ? "#f4b340" : "#56d364",
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
  if (!msgs.length) return <div style={{ color: theme.text.ghost, fontSize: 10, fontStyle: "italic" }}>none in this call</div>;
  return (
    <div>
      {msgs.map(function (m, i) {
        return (
          <div key={i} style={{ display: "grid", gridTemplateColumns: "auto 1fr auto", gap: 8, fontSize: 10.5, padding: "3px 0", alignItems: "baseline", borderTop: i === 0 ? "none" : "1px solid " + theme.border.subtle }}>
            <span style={{ fontSize: 9, padding: "1px 5px", borderRadius: 9, fontWeight: 600, letterSpacing: 0.4, background: "#3a2418", color: "#B8642F" }}>result {i + 1}</span>
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
      background: "#0e1f14", border: "1px solid #163b22", borderRadius: 5,
      padding: "11px 13px", marginBottom: 14,
    }}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 8 }}>
        <div style={{ color: "#56d364", fontSize: 11, fontWeight: 600, letterSpacing: 0.4, textTransform: "uppercase" }}>
          ▲ Billed as new {label}: {fmtT(newTotal)} tok ({pct.toFixed(1)}% of input)
        </div>
        <div style={{ color: theme.text.secondary, fontSize: 10.5, fontVariantNumeric: "tabular-nums" }}>
          {(100 - pct).toFixed(1)}% reused from cache · {fmtT(totalIn - newTotal)} cached tok
        </div>
      </div>
      <div style={{ height: 14, background: "#0a1410", borderRadius: 2, overflow: "hidden", display: "flex", marginBottom: 8 }}>
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
      <div style={{ fontSize: 10.5, color: theme.text.secondary, lineHeight: 1.7 }}>
        {CTX_INPUT_KEYS.filter(function (k) { return (newPerBucket[k] || 0) > 0; })
          .sort(function (a, b) { return (newPerBucket[b] || 0) - (newPerBucket[a] || 0); })
          .map(function (k) {
            return (
              <div key={k} style={{ display: "grid", gridTemplateColumns: "auto 1fr auto", gap: 8, alignItems: "baseline" }}>
                <span>
                  <span style={{ display: "inline-block", width: 8, height: 8, borderRadius: 1, background: CTX_COLORS[k], marginRight: 6 }} />
                  <b style={{ color: theme.text.primary, fontWeight: 500 }}>{CTX_LABELS[k]}</b>
                </span>
                <span />
                <span style={{ color: "#56d364", fontVariantNumeric: "tabular-nums", fontWeight: 600 }}>+{fmtT(newPerBucket[k])} tok</span>
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
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 8, fontSize: 11 }}>
        <span style={{ color: theme.text.primary, fontWeight: 600 }}>
          <span style={{ display: "inline-block", width: 8, height: 8, borderRadius: 1, marginRight: 6, background: CTX_COLORS[props.bucket] }} />
          {CTX_LABELS[props.bucket]}
        </span>
        <span style={{ color: theme.text.secondary, fontVariantNumeric: "tabular-nums" }}>
          {fmtT(props.value)} tok · {props.pct.toFixed(1)}% of input
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
        return <code key={i} style={{ background: "#1a0d12", border: "1px solid #3a1820", padding: "1px 5px", borderRadius: 2, color: "#ffc4d4", fontSize: 10, marginRight: 4 }}>{n}</code>;
      })}{(d.changedSample || []).length < d.toolDefsChanged ? "…" : ""}</span>);
    }
    if ((d.added || []).length) reasons.push(<span key="r2">Tools added: {d.added.map(function (n, i) { return <code key={i} style={{ background: "#1a0d12", border: "1px solid #3a1820", padding: "1px 5px", borderRadius: 2, color: "#ffc4d4", fontSize: 10, marginRight: 4 }}>{n}</code>; })}</span>);
    if ((d.removed || []).length) reasons.push(<span key="r3">Tools removed: {d.removed.map(function (n, i) { return <code key={i} style={{ background: "#1a0d12", border: "1px solid #3a1820", padding: "1px 5px", borderRadius: 2, color: "#ffc4d4", fontSize: 10, marginRight: 4 }}>{n}</code>; })}</span>);
    if (reasons.length === 0) reasons.push(<span key="r4">Tools are identical to the previous call. The cache likely <b>expired</b> (Anthropic ephemeral cache TTL is ~5 min) or the cache_control breakpoint placement changed in the messages array.</span>);
    missCallout = (
      <div style={{
        background: "#2a141c", border: "1px solid #5a2030", color: "#fb8aa8",
        padding: "10px 13px", margin: "0 0 12px", borderRadius: 4, fontSize: 10.5, lineHeight: 1.6,
      }}>
        <div style={{ fontWeight: 600, color: "#ff9bb6", fontSize: 11.5, letterSpacing: 0.4, textTransform: "uppercase", marginBottom: 6, display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ background: "#5a2030", color: "#fff", padding: "2px 7px", borderRadius: 3, fontSize: 9.5, letterSpacing: 0.5 }}>⚠ Unexpected cache miss</span>
        </div>
        We expected this call to hit the cache (<b style={{ color: "#fff" }}>{fmtT(ev.prevPt || 0)} tok</b> were cached on this model just before), but the API returned <b style={{ color: "#fff" }}>0 cached tokens</b>. The full <b style={{ color: "#fff" }}>{fmtT(ev.promptTokens)} tok</b> prefix was re-billed at premium write rate (~<b style={{ color: "#fff" }}>{fmt$(ev.cost)}</b>). Likely cause:
        <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>
          {reasons.map(function (r, i) { return <li key={i} style={{ marginBottom: 2 }}>{r}</li>; })}
        </ul>
      </div>
    );
  }

  var recommitCallout = null;
  if (ev.modelSwitched) {
    recommitCallout = (
      <div style={{ background: "#0f1a22", border: "1px solid #1f3a4d", color: "#7dd3fc", padding: "8px 11px", margin: "0 0 12px", borderRadius: 4, fontSize: 10.5, lineHeight: 1.55 }}>
        ⇄ <b style={{ color: "#fff" }}>Model switch</b> — this call is on <b style={{ color: "#fff" }}>{ev.model}</b>, a different model than the previous call. The cache is per-model, so all <b style={{ color: "#fff" }}>{fmtT(ev.promptTokens)} tok</b> are genuinely new context for this model (no recommit possible — there was no prior cache to recommit from).
      </div>
    );
  } else if (ev.recommit > 100) {
    recommitCallout = (
      <div style={{ background: "#1a1d12", border: "1px solid #3a3318", color: "#f4b340", padding: "8px 11px", margin: "0 0 12px", borderRadius: 4, fontSize: 10.5, lineHeight: 1.55 }}>
        ↻ <b style={{ color: "#fff" }}>{fmtT(ev.recommit)} tok</b> of this call's billed-as-new content was actually <b>cache recommit</b> — material the agent already had, but the cache expired so it had to be re-sent at premium rate. Net new context this call vs the previous one: <b style={{ color: "#fff" }}>{fmtTSigned(ev.deltaVsPrev)} tok</b>.
      </div>
    );
  }

  return (
    <div style={{ gridColumn: "1 / -1", background: theme.bg.base, borderBottom: "1px solid " + theme.border.subtle, padding: "14px 22px" }}>
      <h4 style={{ margin: "0 0 8px", color: theme.text.primary, fontSize: 11.5, fontWeight: 600, letterSpacing: 0.4, textTransform: "uppercase" }}>
        What happened in this LLM call
      </h4>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10, marginBottom: 14 }}>
        <div style={{ background: theme.bg.surface, border: "1px solid #1f3a52", borderRadius: 5, padding: "10px 12px" }}>
          <div style={{ fontSize: 9.5, color: theme.text.muted, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 5 }}>Context window (this call)</div>
          <div style={{ fontSize: 15, color: "#7CC8E5", fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>{fmtT(ev.promptTokens)} tok</div>
          <div style={{ fontSize: 10, color: theme.text.secondary, marginTop: 3 }}>+ {fmtT(ev.output)} output</div>
        </div>
        <div style={{ background: theme.bg.surface, border: "1px solid #163b22", borderRadius: 5, padding: "10px 12px" }}>
          <div style={{ fontSize: 9.5, color: theme.text.muted, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 5 }}>▲ Net new vs previous call</div>
          <div style={{ fontSize: 15, color: "#7CDC85", fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>{fmtTSigned(ev.deltaVsPrev)} tok</div>
          <div style={{ fontSize: 10, color: theme.text.secondary, marginTop: 3 }}>{ev.modelSwitched ? "new model — cache reset" : (ev.prevPt ? "prev call had " + fmtT(ev.prevPt) + " ctx" : "first call in session")}</div>
        </div>
        <div style={{ background: theme.bg.surface, border: "1px solid #3a3318", borderRadius: 5, padding: "10px 12px" }}>
          <div style={{ fontSize: 9.5, color: theme.text.muted, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 5 }}>$ Billed as new (full + premium)</div>
          <div style={{ fontSize: 15, color: "#f4b340", fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>{fmtT(ev.newTotal)} tok</div>
          <div style={{ fontSize: 10, color: theme.text.secondary, marginTop: 3 }}>{ev.recommit > 100 ? "incl. " + fmtT(ev.recommit) + " cache recommit" : "minimal recommit"}</div>
        </div>
      </div>
      {missCallout}
      {recommitCallout}
      <NewBlock newPerBucket={ev.newPerBucket} newTotal={ev.newTotal} totalIn={ev.promptTokens} label="this call" />
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
        <DetailSection bucket="tool_defs" value={c.tool_defs} pct={pct("tool_defs")}>
          <div style={{ color: theme.text.secondary, fontSize: 10.5, marginBottom: 5 }}>{ev.totalTools} tools available, grouped by source</div>
          <ToolGroups groups={ev.toolGroups} />
        </DetailSection>
        <DetailSection bucket="history" value={c.history} pct={pct("history")}>
          <HistoryList msgs={ev.historyMsgs} />
        </DetailSection>
        <DetailSection bucket="tool_results" value={c.tool_results} pct={pct("tool_results")}>
          <ToolResultList msgs={ev.toolResultMsgs} />
        </DetailSection>
        <DetailSection bucket="system" value={c.system} pct={pct("system")}>
          <div style={textBlockStyle}>{ev.systemPreview}{ev.systemPreview && ev.systemPreview.length >= 300 ? "…" : ""}</div>
        </DetailSection>
        <DetailSection bucket="current" value={c.current} pct={pct("current")}>
          <div style={textBlockStyle}>{ev.currentText || "(empty)"}{ev.currentText && ev.currentText.length >= 400 ? "…" : ""}</div>
        </DetailSection>
      </div>
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
  fontSize: 10.5,
  lineHeight: 1.55,
  maxHeight: 120,
  overflow: "auto",
  whiteSpace: "pre-wrap",
};

function ToolDetail(props) {
  var ev = props.event;
  return (
    <div style={{ gridColumn: "1 / -1", background: theme.bg.base, borderBottom: "1px solid " + theme.border.subtle, padding: "14px 22px" }}>
      <h4 style={{ margin: "0 0 8px", color: theme.text.primary, fontSize: 11.5, fontWeight: 600, letterSpacing: 0.4, textTransform: "uppercase" }}>
        What this tool adds to the next LLM call's context
      </h4>
      <div style={{ background: theme.bg.surface, border: "1px solid " + theme.border.default, borderRadius: 4, padding: "10px 12px" }}>
        <div style={{ marginBottom: 6, color: theme.text.primary, fontWeight: 600, fontSize: 11 }}>{ev.name}</div>
        {ev.argsSummary && <div style={{ color: theme.text.secondary, fontSize: 10.5, margin: "4px 0", fontStyle: "italic" }}>{ev.argsSummary}</div>}
        <div style={{ color: theme.text.primary, fontSize: 11, margin: "6px 0", fontVariantNumeric: "tabular-nums" }}>
          → Adds <b style={{ color: "#E6A847" }}>{fmtT(ev.resultTokens || 0)} tokens</b> of <b style={{ color: "#E6A847" }}>tool results</b> to the next LLM call's context ({(ev.resultChars || 0).toLocaleString()} chars).
        </div>
        {ev.resultPreview && (
          <div style={textBlockStyle}>{ev.resultPreview}{ev.resultPreview.length >= 200 ? "…" : ""}</div>
        )}
        {ev.thinking && (
          <>
            <div style={{ marginTop: 8, color: theme.text.muted, fontSize: 10, textTransform: "uppercase", letterSpacing: 0.4 }}>
              Assistant reasoning before the call
            </div>
            <div style={Object.assign({}, textBlockStyle, { fontStyle: "italic" })}>
              {ev.thinking.slice(0, 400)}{ev.thinking.length > 400 ? "…" : ""}
            </div>
          </>
        )}
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
      <div style={{ fontSize: 9, color: theme.text.muted, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 4, display: "flex", justifyContent: "space-between" }}>
        <span>Billed as new this prompt</span>
        <b style={{ color: "#56d364" }}>{fmtT(pa.newTotal)}</b>
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
        <div style={{ fontSize: 9.5, color: "#fb8aa8", marginTop: 4, fontStyle: "italic", lineHeight: 1.3 }}>
          ⚠ {missCalls.length} unexpected cache miss{missCalls.length > 1 ? "es" : ""} — {fmtT(missTotal)} tok re-billed at premium (~{fmt$(missCost)})
        </div>
      )}
      {pa.modelSwitchedIn ? (
        <div style={{ fontSize: 9, color: "#7dd3fc", marginTop: 4, fontStyle: "italic", lineHeight: 1.3 }}>
          ⇄ Model switch — fresh cache, all context is genuinely new to this model
        </div>
      ) : (pa.cacheRecommit > 200 && (
        <div style={{ fontSize: 9, color: "#f4b340", marginTop: 4, fontStyle: "italic", lineHeight: 1.3 }}>
          ↻ {fmtT(pa.cacheRecommit)} of this is cache recommit (already in context, cache expired)
        </div>
      ))}
    </div>
  );
}

function Kpis(props) {
  var t = props.totals;
  var items = [
    { l: "Total cost", v: fmt$(t.cost) },
    { l: "Billed input", v: fmtT(t.promptTokens), d: fmtT(t.cached) + " cached (" + (100 * t.cacheHitRate).toFixed(0) + "%)" },
    { l: "Output", v: fmtT(t.output) },
    { l: "Cache write", v: fmtT(t.cacheWrite) },
    { l: "LLM calls", v: "" + t.llmCalls },
    { l: "Tool calls", v: "" + t.toolCalls },
  ];
  if (t.unexpectedMissCount > 0) {
    items.push({ l: "⚠ Unexpected misses", v: "" + t.unexpectedMissCount, d: "wasted ~" + fmt$(t.unexpectedMissCost), warn: true });
  }
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(" + items.length + ", 1fr)", gap: 12, marginBottom: 28 }}>
      {items.map(function (k, i) {
        return (
          <div key={i} style={{
            background: theme.bg.surface,
            border: "1px solid " + (k.warn ? "#5a2030" : theme.border.default),
            borderRadius: theme.radius.md, padding: "12px 14px",
          }}>
            <div style={{ color: theme.text.muted, fontSize: 10, textTransform: "uppercase", letterSpacing: 0.6 }}>{k.l}</div>
            <div style={{ fontSize: 18, fontWeight: 600, color: k.warn ? "#fb8aa8" : theme.text.primary, marginTop: 4, fontVariantNumeric: "tabular-nums" }}>{k.v}</div>
            {k.d && <div style={{ color: theme.semantic.success, fontSize: 10, marginTop: 2 }}>{k.d}</div>}
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
      borderRadius: 9, fontSize: 10, fontWeight: 600, letterSpacing: 0.4, marginRight: 4,
    };
  };
  return (
    <div style={{ background: theme.bg.base, border: "1px solid " + theme.border.default, borderRadius: 5, padding: "11px 14px", marginBottom: 20, fontSize: 11, color: theme.text.secondary, lineHeight: 1.7 }}>
      <span style={term("#56d364")}>CTX</span><b style={{ color: theme.text.primary }}>Context window</b> — actual size of one LLM call's input (= API <code>prompt_tokens</code>).
      &nbsp;&nbsp;<span style={term("#7CDC85")}>▲ NET</span><b style={{ color: theme.text.primary }}>Net new context</b> — how much working memory actually grew vs the previous call.
      &nbsp;&nbsp;<span style={term("#f4b340", "#3a3318")}>$ BILLED</span><b style={{ color: theme.text.primary }}>Billed input</b> — sum of <code>prompt_tokens</code> across calls (cache reads still cost; cache writes cost more).
      &nbsp;&nbsp;<span style={term("#f4b340", "#3a3318")}>↻ RECOMMIT</span><b style={{ color: theme.text.primary }}>Cache recommit</b> — content the agent already had to send again because the cache expired.
    </div>
  );
}

function Legend() {
  var swatchStyle = function (color) { return { display: "inline-block", width: 10, height: 10, marginRight: 5, borderRadius: 2, verticalAlign: "-1px", background: color }; };
  var groupStyle = { padding: "6px 10px", background: theme.bg.base, border: "1px solid " + theme.border.default, borderRadius: 4, display: "flex", flexWrap: "wrap", gap: 10 };
  var labelStyle = { color: theme.text.muted, textTransform: "uppercase", letterSpacing: 0.5, fontWeight: 600, fontSize: 10, marginRight: 4 };
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 14, margin: "8px 0 20px", fontSize: 11, color: theme.text.secondary }}>
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
  var cumStates = useMemo(function () { return buildCumStates(analysis.prompts); }, [analysis]);
  var maxCost = cumStates.length
    ? cumStates[cumStates.length - 1].fresh + cumStates[cumStates.length - 1].cached + cumStates[cumStates.length - 1].cwrite + cumStates[cumStates.length - 1].output
    : 0.0001;
  var allLLM = [];
  analysis.prompts.forEach(function (p) {
    p.events.forEach(function (e) { if (e.kind === "llm") allLLM.push(e); });
  });
  var maxCtx = Math.max.apply(null, allLLM.map(function (e) { return e.promptTokens + (e.output || 0); }).concat([1]));

  var rowKey = function (pi, ei) { return pi + ":" + ei; };
  var toggle = function (pi, ei) { var k = rowKey(pi, ei); setOpenRow(Object.assign({}, openRow, { [k]: !openRow[k] })); };

  var globalEventIdx = 0;

  return (
    <div style={{ maxWidth: 1700, margin: "0 auto", padding: "32px 28px 80px", fontFamily: theme.font.mono, fontSize: 13, color: theme.text.primary, background: theme.bg.base, minHeight: "100%" }}>
      <h1 style={{ fontSize: 20, fontWeight: 600, margin: "0 0 4px", color: theme.text.primary, letterSpacing: 0.4 }}>
        Token cost &amp; context buildup
      </h1>
      <div style={{ color: theme.text.muted, fontSize: 12, marginBottom: 24 }}>
        Three different lenses on "input": context size, growth, and billing.
      </div>

      <Kpis totals={analysis.totals} />
      <Glossary />
      <Legend />

      <div style={{
        display: "grid",
        gridTemplateColumns: "minmax(420px,1fr) 360px 360px",
        border: "1px solid " + theme.border.default, borderRadius: 6, overflow: "hidden", background: theme.bg.surface,
      }}>
        <div style={colHeadStyle}>Prompt &amp; steps</div>
        <div style={Object.assign({}, colHeadStyle, { borderLeft: "1px solid " + theme.border.default })}>Cumulative cost so far → max {fmt$(maxCost)}</div>
        <div style={Object.assign({}, colHeadStyle, { borderLeft: "1px solid " + theme.border.default })}>Context window for this call → max {fmtT(maxCtx)} tok</div>

        {analysis.prompts.map(function (p, pi) {
          var cachedPct = 100 * p.cacheHitRate;
          var pa = p.prompt;
          return (
            <React.Fragment key={pi}>
              {/* Prompt header spans all 3 columns */}
              <div style={{
                gridColumn: "1 / -1",
                background: "linear-gradient(180deg,#1a2230 0%,#141a22 100%)",
                borderTop: pi > 0 ? "1px solid " + theme.border.default : "none",
                borderBottom: "1px solid " + theme.border.default,
                padding: "14px 18px",
                display: "grid",
                gridTemplateColumns: "48px 1fr 220px auto",
                gap: 14,
                alignItems: "center",
              }}>
                <div style={{ fontSize: 10, color: theme.text.muted, textAlign: "center" }}>
                  <span style={{ fontSize: 22, color: theme.text.primary, fontWeight: 700, display: "block", lineHeight: 1 }}>{pi + 1}</span>
                  prompt
                </div>
                <div>
                  <div style={{ color: theme.text.primary, fontSize: 14, fontWeight: 500, lineHeight: 1.4 }}>{p.label || "(empty)"}</div>
                  <div style={{ color: theme.text.secondary, fontSize: 10.5, marginTop: 6, display: "grid", gap: 4 }}>
                    <div style={{ display: "flex", gap: 14, flexWrap: "wrap", alignItems: "baseline" }}>
                      <span style={{ color: "#3DA9D4" }}>⊞ Context: <b style={{ color: "#7CC8E5", fontWeight: 600 }}>{fmtT(pa.contextInitial)} → {fmtT(pa.contextFinal)}</b></span>
                      <span style={{ color: "#56d364", fontWeight: 600 }}>▲ {fmtTSigned(pa.contextGrowth)} tok net new this prompt</span>
                      <span><b style={{ color: theme.text.primary, fontWeight: 500 }}>{p.llmCount}</b> LLM</span>
                      <span><b style={{ color: theme.text.primary, fontWeight: 500 }}>{p.toolCount}</b> tools</span>
                    </div>
                    <div style={{ color: theme.text.muted, fontSize: 10, display: "flex", gap: 14, flexWrap: "wrap" }}>
                      <span>$ Billed: <b style={{ color: theme.text.secondary }}>{fmtT(p.promptTokens)}</b> input · <b style={{ color: theme.text.secondary }}>{fmtT(p.output)}</b> output · <b style={{ color: theme.text.secondary }}>{cachedPct.toFixed(0)}%</b> cached · <b style={{ color: theme.text.secondary }}>{fmtT(pa.newTotal)}</b> billed-as-new</span>
                      {pa.cacheRecommit > 200 && <span style={{ color: "#f4b340" }}>↻ <b>{fmtT(pa.cacheRecommit)}</b> recommit</span>}
                    </div>
                  </div>
                </div>
                <div><PromptNewMini prompt={p} /></div>
                <div style={{ fontSize: 16, fontWeight: 600, color: theme.text.primary, fontVariantNumeric: "tabular-nums", textAlign: "right" }}>{fmt$(p.cost)}</div>
              </div>

              {p.events.map(function (ev, ei) {
                var isLLM = ev.kind === "llm";
                var k = rowKey(pi, ei);
                var open = !!openRow[k];
                var cumState = cumStates[globalEventIdx];
                globalEventIdx += 1;
                var cellBg = isLLM ? theme.bg.surface : theme.bg.raised;
                var meta = isLLM ? (
                  <div style={{ color: theme.text.muted, fontSize: 10, marginTop: 3, display: "flex", gap: 10, flexWrap: "wrap" }}>
                    <span>{(ev.model || "").split("-").slice(0, 3).join("-")}</span>
                    <span style={{ color: "#3DA9D4" }}>⊞ <b style={{ color: "#7CC8E5" }}>{fmtT(ev.promptTokens)}</b> ctx</span>
                    <span style={{ color: "#56d364" }}>▲ <b style={{ color: "#7CDC85" }}>{fmtTSigned(ev.deltaVsPrev)}</b> net new</span>
                    <span><b style={{ color: theme.text.primary }}>{fmtT(ev.cached)}</b> cached</span>
                    <span style={{ color: "#f4b340" }}>$ <b>{fmtT(ev.newTotal)}</b> billed-new</span>
                    <span style={{ color: theme.text.secondary }}>{fmt$(ev.cost)}</span>
                    {ev.unexpectedMiss && (
                      <span style={{ color: "#fb8aa8", background: "#2a141c", border: "1px solid #5a2030", padding: "1px 6px", borderRadius: 3 }}>⚠ unexpected cache miss</span>
                    )}
                  </div>
                ) : (
                  <div style={{ color: theme.text.muted, fontSize: 10, marginTop: 3, display: "flex", gap: 10 }}>
                    <span>tool call</span>
                    {ev.resultTokens > 0 && <span>→ <b style={{ color: theme.text.primary }}>{fmtT(ev.resultTokens)}</b> tok of result</span>}
                  </div>
                );

                return (
                  <React.Fragment key={ei}>
                    <div onClick={function () { toggle(pi, ei); }}
                      style={{
                        padding: "8px 14px", borderBottom: "1px solid " + theme.border.subtle,
                        background: cellBg, display: "flex", alignItems: "center", minHeight: 38, cursor: "pointer",
                      }}>
                      <div style={{ display: "grid", gridTemplateColumns: "18px 18px 1fr", gap: 8, alignItems: "start", width: "100%" }}>
                        <div style={{ color: theme.text.muted, fontSize: 10, width: 14, textAlign: "center", marginTop: 3, transition: "transform .15s", transform: open ? "rotate(90deg)" : "none" }}>▶</div>
                        <div style={{
                          fontSize: 10, fontWeight: 600, width: 18, height: 18, borderRadius: 9,
                          display: "flex", alignItems: "center", justifyContent: "center", color: "#fff", marginTop: 1,
                          background: isLLM ? "#3DA9D4" : "#E6A847",
                        }}>{isLLM ? "L" : "T"}</div>
                        <div>
                          <div style={{ color: theme.text.primary, fontSize: 11.5, fontWeight: 500, lineHeight: 1.4 }}>
                            {isLLM ? (ev.model ? "panel/" + (ev.model.indexOf("claude") >= 0 ? "editAgent" : "request") : "request") : ev.name}
                            {ev.argsSummary && <span style={{ color: theme.text.muted, fontWeight: 400, marginLeft: 6 }}>{ev.argsSummary}</span>}
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
                        : <span style={{ color: theme.text.ghost, fontSize: 10, fontStyle: "italic" }}>→ result lands in next LLM call</span>}
                    </div>
                    {open && (isLLM ? <LLMDetail event={ev} /> : <ToolDetail event={ev} />)}
                  </React.Fragment>
                );
              })}
            </React.Fragment>
          );
        })}
      </div>
    </div>
  );
}

var colHeadStyle = {
  background: theme.bg.base,
  padding: "11px 14px",
  fontSize: 10,
  color: theme.text.muted,
  textTransform: "uppercase",
  letterSpacing: 0.6,
  borderBottom: "1px solid " + theme.border.default,
  fontWeight: 600,
};
