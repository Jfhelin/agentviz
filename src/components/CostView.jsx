import { useMemo, useState } from "react";
import { theme, alpha } from "../lib/theme.js";
import { buildCostAnalysis, formatTokens } from "../lib/costAnalysis.js";
import { formatCost } from "../lib/pricing.js";

// 1 credit = $0.01 (GitHub Copilot AI Credits)
function formatCredits(usd) {
  if (usd == null || isNaN(usd)) return "0 cr";
  var c = usd * 100;
  var abs = Math.abs(c);
  var sign = c < 0 ? "-" : "";
  if (abs < 0.01) return sign + abs.toFixed(3) + " cr";
  if (abs < 100) return sign + abs.toFixed(2) + " cr";
  return sign + Math.round(abs) + " cr";
}

function formatMoney(usd, unit) {
  return unit === "credits" ? formatCredits(usd) : formatCost(usd);
}

// Map VS Code Copilot Chat internal call names to friendly labels.
var CALL_NAME_LABELS = {
  "panel/editAgent":      "Chat turn (with tools)",
  "panel/request":        "Chat turn",
  "panel/explain":        "Explain",
  "panel/fix":            "Fix",
  "title":                "Generate chat title",
  "promptCategorization": "Categorize prompt",
  "summarization":        "Summarize",
  "followups":            "Suggest followups",
  "rename":               "Rename",
};
function friendlyCallName(name) {
  if (!name) return null;
  if (CALL_NAME_LABELS[name]) return CALL_NAME_LABELS[name];
  if (name.indexOf("panel/") === 0) return "Chat: " + name.slice(6);
  return name;
}

function panelStyle() {
  return {
    background: theme.bg.surface,
    border: "1px solid " + theme.border.default,
    borderRadius: theme.radius.xl,
    overflow: "hidden",
    minWidth: 0,
  };
}

function labelStyle() {
  return {
    fontSize: theme.fontSize.xs,
    color: theme.text.dim,
    textTransform: "uppercase",
    letterSpacing: "0.14em",
    fontWeight: 700,
  };
}

function SummaryCard({ label, value, sub, color, valueSize }) {
  return (
    <div style={Object.assign({}, panelStyle(), { padding: theme.space.lg + "px " + theme.space.xl + "px" })}>
      <div style={labelStyle()}>{label}</div>
      <div style={{ fontSize: valueSize || theme.fontSize.xxl, color: color || theme.text.primary, fontWeight: 800, marginTop: theme.space.md, whiteSpace: "nowrap" }}>{value}</div>
      {sub && <div style={{ color: theme.text.muted, fontSize: theme.fontSize.sm, marginTop: theme.space.sm, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{sub}</div>}
    </div>
  );
}

function Panel({ label, title, aside, children }) {
  return (
    <div style={Object.assign({}, panelStyle(), { display: "flex", flexDirection: "column", minHeight: 0 })}>
      <div style={{ minHeight: 48, borderBottom: "1px solid " + theme.border.default, padding: theme.space.md + "px " + theme.space.lg + "px", display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: theme.space.lg, flexShrink: 0 }}>
        <div style={{ minWidth: 0 }}>
          <div style={labelStyle()}>{label}</div>
          <div style={{ color: theme.text.primary, fontSize: theme.fontSize.base, fontWeight: 800, marginTop: theme.space.xs, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{title}</div>
        </div>
        {aside && <div style={{ color: theme.text.muted, fontSize: theme.fontSize.xs, flexShrink: 0 }}>{aside}</div>}
      </div>
      {children}
    </div>
  );
}

function Chip({ children, color, bg }) {
  return (
    <span style={{
      fontSize: theme.fontSize.xs,
      color: color || theme.text.secondary,
      border: "1px solid " + (color ? alpha(color, 0.45) : theme.border.default),
      background: bg || (color ? alpha(color, 0.10) : theme.bg.raised),
      padding: theme.space.xs + "px " + theme.space.md + "px",
      borderRadius: theme.radius.full,
      fontFamily: theme.font.mono,
      whiteSpace: "nowrap",
    }}>{children}</span>
  );
}

function BarSegments({ segments, max, height }) {
  var total = segments.reduce(function (s, seg) { return s + Math.max(0, seg.value || 0); }, 0);
  var width = Math.max(4, Math.min(100, (total / Math.max(max, 1)) * 100));
  return (
    <div style={{
      height: height || 32,
      border: "1px solid " + theme.border.default,
      borderRadius: theme.radius.lg,
      background: theme.bg.base,
      overflow: "hidden",
      display: "flex",
      width: width + "%",
      minWidth: theme.space.md,
    }}>
      {segments.map(function (segment) {
        var pct = total > 0 ? (Math.max(0, segment.value || 0) / total) * 100 : 0;
        if (pct <= 0) return null;
        return <div key={segment.key} title={segment.label + ": " + formatTokens(segment.value)} style={{ width: pct + "%", background: segment.color, minWidth: pct > 0 ? 2 : 0 }} />;
      })}
    </div>
  );
}

function Legend({ items }) {
  return (
    <div style={{ padding: theme.space.md + "px " + theme.space.lg + "px 0", color: theme.text.muted, fontSize: theme.fontSize.xs, display: "flex", gap: theme.space.lg, flexWrap: "wrap" }}>
      {items.map(function (item) {
        return (
          <span key={item.label} style={{ display: "inline-flex", alignItems: "center", gap: theme.space.sm }}>
            <span style={{ display: "inline-block", width: theme.space.md, height: theme.space.md, borderRadius: "50%", background: item.color }} />
            {item.label}
          </span>
        );
      })}
    </div>
  );
}

function ToggleGroup({ value, onChange, options, ariaLabel }) {
  return (
    <div role="group" aria-label={ariaLabel} style={{
      display: "inline-flex",
      border: "1px solid " + theme.border.default,
      borderRadius: theme.radius.lg,
      background: theme.bg.surface,
      padding: 2,
      gap: 2,
    }}>
      {options.map(function (opt) {
        var active = value === opt.value;
        return (
          <button
            key={opt.value}
            type="button"
            onClick={function () { onChange(opt.value); }}
            aria-pressed={active}
            style={{
              padding: theme.space.sm + "px " + theme.space.lg + "px",
              border: "none",
              borderRadius: theme.radius.md,
              background: active ? theme.accent.muted : "transparent",
              color: active ? theme.accent.primary : theme.text.secondary,
              fontFamily: theme.font.mono,
              fontSize: theme.fontSize.xs,
              fontWeight: 700,
              cursor: "pointer",
              letterSpacing: "0.06em",
            }}
          >{opt.label}</button>
        );
      })}
    </div>
  );
}

function ToggleSwitch({ checked, onChange, label, id }) {
  return (
    <label htmlFor={id} style={{
      display: "inline-flex",
      alignItems: "center",
      gap: theme.space.md,
      color: theme.text.secondary,
      fontSize: theme.fontSize.xs,
      cursor: "pointer",
      fontFamily: theme.font.mono,
      letterSpacing: "0.06em",
    }}>
      <input
        id={id}
        type="checkbox"
        checked={checked}
        onChange={function (e) { onChange(e.target.checked); }}
        style={{ cursor: "pointer" }}
      />
      {label}
    </label>
  );
}

function CallRow({ call, miss, unit, isOverhead }) {
  return (
    <div style={{
      border: "1px solid " + (miss ? alpha(theme.semantic.warning, 0.55) : theme.border.default),
      background: miss
        ? "linear-gradient(90deg," + alpha(theme.semantic.warning, 0.10) + "," + theme.bg.surface + " 32%)"
        : theme.bg.surface,
      borderRadius: theme.radius.lg,
      padding: theme.space.lg,
      display: "grid",
      gridTemplateColumns: "32px 1fr",
      gap: theme.space.md,
      minHeight: 80,
      opacity: isOverhead ? 0.72 : 1,
    }}>
      <div style={{ width: 28, height: 28, borderRadius: theme.radius.lg, background: theme.bg.raised, color: theme.text.secondary, display: "grid", placeItems: "center", fontFamily: theme.font.mono, fontSize: theme.fontSize.sm }}>{String(call.index + 1).padStart(2, "0")}</div>
      <div style={{ minWidth: 0 }}>
        <div title={call.title} style={{ color: theme.text.primary, fontSize: theme.fontSize.sm, fontWeight: 800, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{call.title}</div>
        <div style={{ display: "flex", gap: theme.space.sm, flexWrap: "wrap", marginTop: theme.space.md }}>
          <Chip>{call.model}</Chip>
          <Chip>{formatTokens(call.contextBreakdown.total || call.tokenUsage.inputTokens)} ctx</Chip>
          {isOverhead && <Chip color={theme.text.muted}>overhead</Chip>}
          {miss && <Chip color={theme.semantic.warning}>cache miss</Chip>}
          <Chip>{formatMoney(call.cost, unit)}</Chip>
        </div>
        <div style={{ color: theme.text.muted, fontSize: theme.fontSize.sm, marginTop: theme.space.md, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {formatTokens(call.freshInputTokens)} fresh · {formatTokens(call.cachedInputTokens)} cached · {formatTokens(call.outputTokens)} out
        </div>
      </div>
    </div>
  );
}

function CacheMissAnnotation({ call, miss, enhanced }) {
  var fromTokens = formatTokens(miss.previousFreshInputTokens);
  var toTokens = formatTokens(miss.freshInputTokens);
  var changes = [];
  if (miss.toolDiff) {
    if (miss.toolDiff.added && miss.toolDiff.added.length) changes.push("added " + miss.toolDiff.added.slice(0, 3).join(", "));
    if (miss.toolDiff.removed && miss.toolDiff.removed.length) changes.push("removed " + miss.toolDiff.removed.slice(0, 3).join(", "));
  }
  var diag = enhanced && enhanced.diag;
  var diagText = "";
  if (diag) {
    if (diag.likelyTtlExpiry) {
      diagText = " Tool defs unchanged - likely TTL expiry.";
    } else if (diag.toolDefsChanged > 0) {
      diagText = " " + diag.toolDefsChanged + " tool definition(s) changed: " + diag.changedSample.join(", ") + ".";
    }
  } else if (changes.length) {
    diagText = " Tool diff: " + changes.join("; ") + ".";
  }
  var message = "Unexpected cache miss on call #" + (miss.callIndex + 1) + ". Fresh input jumped from " + fromTokens + " to " + toTokens + "." + diagText;
  return (
    <div aria-label={message} style={{
      border: "1px solid " + alpha(theme.semantic.warning, 0.45),
      background: alpha(theme.semantic.warning, 0.08),
      borderRadius: theme.radius.lg,
      padding: theme.space.md + "px " + theme.space.lg + "px",
      color: theme.semantic.warning,
      fontSize: theme.fontSize.sm,
      fontWeight: 700,
      lineHeight: 1.35,
      marginTop: theme.space.sm,
    }}>
      <span>Unexpected cache miss on call #{miss.callIndex + 1}.</span>{" "}
      <span>Fresh input jumped from {fromTokens} to {toTokens}.</span>
      {diagText && <span>{diagText}</span>}
    </div>
  );
}

// Three lenses: BILLED (input+output billed), CTX (full context size), NET (truly-new tokens this call)
function pickLensSegments(call, perCall, lens) {
  if (lens === "ctx") {
    var b = call.contextBreakdown;
    return [
      { key: "system",       label: "System",        value: b.system,       color: theme.cost.ctxSystem },
      { key: "tools",        label: "Tool defs",     value: b.tools,        color: theme.cost.ctxToolDefs },
      { key: "history",      label: "History",       value: b.history,      color: theme.cost.ctxHistory },
      { key: "tool_results", label: "Tool results",  value: b.toolResults,  color: theme.cost.ctxToolResults },
      { key: "current",      label: "Current",       value: b.user,         color: theme.cost.ctxCurrent },
      { key: "output",       label: "Output",        value: call.outputTokens, color: theme.cost.ctxOutput },
    ];
  }
  if (lens === "net") {
    // Truly-new (uncached) tokens this call, from cacheAnalysis.
    if (perCall) {
      return [
        { key: "trulyNew", label: "Truly new",     value: perCall.trulyNew, color: theme.cost.fresh },
        { key: "recommit", label: "Cache recommit", value: perCall.recommit, color: theme.cost.cwrite },
        { key: "output",   label: "Output",         value: call.outputTokens, color: theme.cost.output },
      ];
    }
    return [{ key: "net", label: "Net", value: call.freshInputTokens + call.outputTokens, color: theme.cost.fresh }];
  }
  // billed (default)
  return [
    { key: "fresh",  label: "Fresh input",  value: call.freshInputTokens,  color: theme.cost.fresh },
    { key: "cwrite", label: "Cache write",  value: call.cacheWriteTokens,  color: theme.cost.cwrite },
    { key: "cached", label: "Cached read",  value: call.cachedInputTokens, color: theme.cost.cached },
    { key: "output", label: "Output",       value: call.outputTokens,      color: theme.cost.output },
  ];
}

function lensLegendItems(lens) {
  if (lens === "ctx") return [
    { label: "system",    color: theme.cost.ctxSystem },
    { label: "tools",     color: theme.cost.ctxToolDefs },
    { label: "history",   color: theme.cost.ctxHistory },
    { label: "results",   color: theme.cost.ctxToolResults },
    { label: "current",   color: theme.cost.ctxCurrent },
    { label: "output",    color: theme.cost.ctxOutput },
  ];
  if (lens === "net") return [
    { label: "truly new", color: theme.cost.fresh },
    { label: "recommit",  color: theme.cost.cwrite },
    { label: "output",    color: theme.cost.output },
  ];
  return [
    { label: "fresh",       color: theme.cost.fresh },
    { label: "cache write", color: theme.cost.cwrite },
    { label: "cached",      color: theme.cost.cached },
    { label: "output",      color: theme.cost.output },
  ];
}

function lensTitle(lens) {
  if (lens === "ctx") return "Context window per call";
  if (lens === "net") return "Net-new tokens per call";
  return "Billed input/output by call";
}

function maxForLens(calls, perCallAll, lens) {
  if (lens === "ctx") {
    return Math.max(1, ...calls.map(function (c) { return (c.contextBreakdown.total || c.tokenUsage.inputTokens || 0) + (c.outputTokens || 0); }));
  }
  if (lens === "net") {
    return Math.max(1, ...calls.map(function (c) {
      var pc = perCallAll[c.index];
      if (pc) return pc.trulyNew + pc.recommit + (c.outputTokens || 0);
      return c.freshInputTokens + (c.outputTokens || 0);
    }));
  }
  return Math.max(1, ...calls.map(function (c) {
    return c.freshInputTokens + c.cachedInputTokens + c.cacheWriteTokens + c.outputTokens;
  }));
}

function CallBars({ calls, perCallAll, missByIndex, missEnhancedByIndex, lens, unit }) {
  var max = maxForLens(calls, perCallAll, lens);
  var aside = (
    <span style={{
      color: theme.text.primary,
      fontSize: theme.fontSize.xs,
      fontFamily: theme.font.mono,
      border: "1px solid " + alpha(theme.accent.primary, 0.5),
      background: alpha(theme.accent.primary, 0.12),
      borderRadius: theme.radius.md,
      padding: theme.space.sm + "px " + theme.space.md + "px",
    }}>{lens.toUpperCase()}</span>
  );
  return (
    <Panel label="Per-call timeline" title={lensTitle(lens)} aside={aside}>
      <Legend items={lensLegendItems(lens)} />
      <div style={{ padding: theme.space.lg, overflow: "auto" }}>
        {calls.map(function (call) {
          var perCall = perCallAll[call.index];
          var segments = pickLensSegments(call, perCall, lens);
          return (
            <div key={call.index} style={{ minHeight: 56 }}>
              <div style={{ display: "grid", gridTemplateColumns: "56px 1fr 88px", gap: theme.space.md, alignItems: "center", height: theme.space.giant }}>
                <div style={{ color: theme.text.secondary, fontFamily: theme.font.mono, fontSize: theme.fontSize.sm }}>#{String(call.index + 1).padStart(2, "0")}</div>
                <BarSegments max={max} segments={segments} />
                <div style={{ textAlign: "right", color: theme.text.primary, fontFamily: theme.font.mono, fontSize: theme.fontSize.sm }}>{formatMoney(call.cumulativeCost, unit)}</div>
              </div>
              {missByIndex.has(call.index) && (
                <CacheMissAnnotation
                  call={call}
                  miss={missByIndex.get(call.index)}
                  enhanced={missEnhancedByIndex.get(call.index)}
                />
              )}
            </div>
          );
        })}
      </div>
    </Panel>
  );
}

function ContextBars({ calls, perCallAll }) {
  var max = Math.max(1, ...calls.map(function (c) { return c.contextBreakdown.total || c.tokenUsage.inputTokens || 0; }));
  return (
    <Panel label="Context window" title="What is filling the prompt" aside="tokens">
      <Legend items={[
        { label: "system",  color: theme.cost.ctxSystem },
        { label: "tools",   color: theme.cost.ctxToolDefs },
        { label: "history", color: theme.cost.ctxHistory },
        { label: "results", color: theme.cost.ctxToolResults },
        { label: "user",    color: theme.cost.ctxCurrent },
      ]} />
      <div style={{ padding: theme.space.lg, overflow: "auto" }}>
        {calls.map(function (call) {
          var b = call.contextBreakdown;
          var pc = perCallAll[call.index];
          var hint = pc && pc.recommit > 0
            ? " · " + formatTokens(pc.recommit) + " cache recommit"
            : "";
          return (
            <div key={call.index} style={{ display: "grid", gridTemplateColumns: "56px 1fr 48px", gap: theme.space.md, alignItems: "center", minHeight: 80 }}>
              <div title={"prompt" + hint} style={{ color: theme.text.secondary, fontFamily: theme.font.mono, fontSize: theme.fontSize.sm }}>
                {formatTokens(b.total || call.tokenUsage.inputTokens)}
              </div>
              <BarSegments max={max} segments={[
                { key: "system",  label: "System",       value: b.system,      color: theme.cost.ctxSystem },
                { key: "tools",   label: "Tools",        value: b.tools,       color: theme.cost.ctxToolDefs },
                { key: "history", label: "History",      value: b.history,     color: theme.cost.ctxHistory },
                { key: "results", label: "Tool results", value: b.toolResults, color: theme.cost.ctxToolResults },
                { key: "user",    label: "User",         value: b.user,        color: theme.cost.ctxCurrent },
              ]} />
              <div style={{ textAlign: "right", color: theme.text.primary, fontFamily: theme.font.mono, fontSize: theme.fontSize.sm }}>#{String(call.index + 1).padStart(2, "0")}</div>
            </div>
          );
        })}
        <div style={{ border: "1px solid " + theme.border.default, background: theme.bg.surface, borderRadius: theme.radius.lg, padding: theme.space.lg, marginTop: theme.space.sm }}>
          <div style={labelStyle()}>Context growth</div>
          <div style={{ color: theme.text.muted, fontSize: theme.fontSize.sm, marginTop: theme.space.md }}>Use cache-miss warnings to spot tool schema or prompt changes that force cache misses.</div>
        </div>
      </div>
    </Panel>
  );
}

function UnexpectedMissPanel({ unexpectedMisses, unexpectedMissCost, unit }) {
  if (!unexpectedMisses || unexpectedMisses.length === 0) return null;
  return (
    <div style={Object.assign({}, panelStyle(), {
      borderColor: alpha(theme.semantic.warning, 0.45),
      background: alpha(theme.semantic.warning, 0.06),
      padding: theme.space.lg + "px " + theme.space.xl + "px",
    })}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: theme.space.lg, flexWrap: "wrap" }}>
        <div>
          <div style={Object.assign({}, labelStyle(), { color: theme.semantic.warning })}>Unexpected cache misses</div>
          <div style={{ color: theme.text.primary, fontSize: theme.fontSize.base, fontWeight: 800, marginTop: theme.space.xs }}>
            {unexpectedMisses.length} call{unexpectedMisses.length === 1 ? "" : "s"} · ~{formatMoney(unexpectedMissCost, unit)} extra spend
          </div>
        </div>
        <div style={{ color: theme.text.muted, fontSize: theme.fontSize.sm, maxWidth: 520 }}>
          Each listed call billed full prompt tokens despite a prior same-model prefix being available. See the BILLED timeline below for per-call details and tool-defs diff diagnosis.
        </div>
      </div>
    </div>
  );
}

export default function CostView({ events, metadata }) {
  var analysis = useMemo(function () {
    return buildCostAnalysis(events || [], metadata || {});
  }, [events, metadata]);

  var [lens, setLens] = useState("billed");
  var [unit, setUnit] = useState("currency");
  var [hideOverhead, setHideOverhead] = useState(false);

  if (!analysis.hasCostData) {
    return (
      <div style={{ padding: theme.space.huge, color: theme.text.dim, fontSize: theme.fontSize.md, textAlign: "center" }}>
        <div style={{ fontSize: theme.fontSize.xl, color: theme.text.primary, fontWeight: 800, marginBottom: 8 }}>No token cost data found</div>
        <div>Load a Copilot prompt export or any session with token usage to inspect spend and context buildup.</div>
      </div>
    );
  }

  // perCall (from enhanced cacheAnalysis) is aligned 1:1 with analysis.calls by index.
  var perCallAll = (analysis.cacheAnalysis && analysis.cacheAnalysis.perCall) || [];
  var unexpectedMisses = (analysis.cacheAnalysis && analysis.cacheAnalysis.unexpectedMisses) || [];
  var unexpectedMissCost = (analysis.cacheAnalysis && analysis.cacheAnalysis.unexpectedMissCost) || 0;

  // Map each call's costPrompt.category if present (overhead vs primary).
  var categoryByIndex = new Map();
  for (var ci = 0; ci < analysis.calls.length; ci += 1) {
    var c = analysis.calls[ci];
    var cp = c.event && c.event.raw && c.event.raw.costPrompt;
    categoryByIndex.set(c.index, cp && cp.category === "overhead" ? "overhead" : "primary");
  }

  var visibleCalls = hideOverhead
    ? analysis.calls.filter(function (call) { return categoryByIndex.get(call.index) !== "overhead"; })
    : analysis.calls;

  var overheadCount = 0;
  var overheadCost = 0;
  for (var oi = 0; oi < analysis.calls.length; oi += 1) {
    if (categoryByIndex.get(analysis.calls[oi].index) === "overhead") {
      overheadCount += 1;
      overheadCost += analysis.calls[oi].cost || 0;
    }
  }

  var totals = analysis.totals;
  var cachePercent = totals.cacheHitRate ? Math.round(totals.cacheHitRate * 100) : 0;
  var missByIndex = new Map(analysis.cacheMisses.map(function (miss) { return [miss.callIndex, miss]; }));
  var missEnhancedByIndex = new Map(unexpectedMisses.map(function (m) { return [m.callIndex, m]; }));

  // Friendly title for the first non-overhead call's callName, when available
  var firstCallName = null;
  for (var fi = 0; fi < analysis.calls.length; fi += 1) {
    var fc = analysis.calls[fi];
    var fcp = fc.event && fc.event.raw && fc.event.raw.costPrompt;
    if (fcp && fcp.callName) { firstCallName = fcp.callName; break; }
  }
  void friendlyCallName(firstCallName);

  return (
    <div style={{
      padding: theme.space.xl,
      display: "flex",
      flexDirection: "column",
      gap: theme.space.lg,
      minHeight: 0,
      height: "100%",
      overflowY: "auto",
      fontFamily: theme.font.mono,
      fontSize: theme.fontSize.base,
    }}>
      {/* Controls bar: lens, unit, overhead filter */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: theme.space.lg, flexWrap: "wrap" }}>
        <div style={{ display: "flex", alignItems: "center", gap: theme.space.lg, flexWrap: "wrap" }}>
          <span style={labelStyle()}>Lens</span>
          <ToggleGroup
            ariaLabel="Cost lens"
            value={lens}
            onChange={setLens}
            options={[
              { value: "billed", label: "BILLED" },
              { value: "ctx",    label: "CTX" },
              { value: "net",    label: "NET" },
            ]}
          />
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: theme.space.lg, flexWrap: "wrap" }}>
          {overheadCount > 0 && (
            <ToggleSwitch
              id="cost-hide-overhead"
              checked={hideOverhead}
              onChange={setHideOverhead}
              label={"Hide overhead (" + overheadCount + ", " + formatMoney(overheadCost, unit) + ")"}
            />
          )}
          <span style={labelStyle()}>Show as</span>
          <ToggleGroup
            ariaLabel="Cost unit"
            value={unit}
            onChange={setUnit}
            options={[
              { value: "currency", label: "USD" },
              { value: "credits",  label: "AI Credits" },
            ]}
          />
        </div>
      </div>

      <UnexpectedMissPanel
        unexpectedMisses={unexpectedMisses}
        unexpectedMissCost={unexpectedMissCost}
        unit={unit}
      />

      <div style={{ display: "grid", gridTemplateColumns: "1.15fr repeat(4, minmax(150px, 0.6fr))", gap: theme.space.lg }}>
        <SummaryCard label="Cost view" value="Token spend & context buildup" valueSize={theme.fontSize.lg} sub="Full context, net-new tokens, and billed API usage." />
        <SummaryCard label="Total spend" value={formatMoney(totals.cost, unit)} sub={cachePercent + "% cached input"} />
        <SummaryCard label="Input tokens" value={formatTokens(totals.inputTokens)} sub={formatTokens(totals.freshInputTokens) + " fresh · " + formatTokens(totals.cacheRead) + " cached"} />
        <SummaryCard label="Peak context" value={formatTokens(totals.peakContext)} sub="tools + history dominate context" />
        <SummaryCard
          label="Cache misses"
          value={analysis.cacheMisses.length}
          sub={unexpectedMisses.length ? unexpectedMisses.length + " unexpected (diagnosed)" : "unexpected fresh-token spikes"}
          color={analysis.cacheMisses.length ? theme.semantic.warning : theme.text.primary}
        />
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "minmax(310px, 0.9fr) minmax(360px, 1fr) minmax(360px, 1fr)", gap: theme.space.lg, minHeight: 0, flex: 1 }}>
        <Panel label="Prompt & steps" title="Calls in session order" aside={hideOverhead ? "primary only" : "session order"}>
          <div style={{ padding: theme.space.md, overflow: "auto", display: "flex", flexDirection: "column", gap: theme.space.md }}>
            {visibleCalls.map(function (call) {
              return (
                <CallRow
                  key={call.index}
                  call={call}
                  miss={missByIndex.has(call.index)}
                  unit={unit}
                  isOverhead={categoryByIndex.get(call.index) === "overhead"}
                />
              );
            })}
          </div>
        </Panel>
        <CallBars
          calls={visibleCalls}
          perCallAll={perCallAll}
          missByIndex={missByIndex}
          missEnhancedByIndex={missEnhancedByIndex}
          lens={lens}
          unit={unit}
        />
        <ContextBars calls={visibleCalls} perCallAll={perCallAll} />
      </div>
    </div>
  );
}
