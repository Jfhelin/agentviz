import { useMemo, useState } from "react";
import { theme, alpha } from "../lib/theme.js";
import { compareRunsCost, BUCKETS } from "../lib/compareCost";
import { formatComparisonAsMarkdown } from "../lib/exportComparison";
import { prettifyRunName } from "../lib/runDisplayName";

// A = primary blue, B = system purple. Matches CompareView's A/B accent
// convention for the Scorecard and Tools tabs.
const COLOR_A = theme.accent.primary;
const COLOR_B = theme.agent.system;

const BUCKET_COLOR = {
  system: theme.cost.ctxSystem,
  tool_defs: theme.cost.ctxToolDefs,
  history: theme.cost.ctxHistory,
  tool_results: theme.cost.ctxToolResults,
  current: theme.cost.ctxCurrent,
  output: theme.cost.ctxOutput,
};
const BUCKET_LABEL = {
  system: "System",
  tool_defs: "Tool defs",
  history: "History",
  tool_results: "Tool results",
  current: "Current prompt",
  output: "Response",
};

function fmtUsd(n) {
  if (n == null || !isFinite(n)) return "--";
  if (n === 0) return "$0.00";
  if (Math.abs(n) < 0.001) return "$" + n.toFixed(5);
  if (Math.abs(n) < 0.01) return "$" + n.toFixed(4);
  if (Math.abs(n) < 1) return "$" + n.toFixed(3);
  return "$" + n.toFixed(2);
}
function fmtCr(n) {
  if (n == null || !isFinite(n)) return "--";
  var cr = n * 100;
  if (cr === 0) return "0 cr";
  if (Math.abs(cr) < 0.01) return cr.toFixed(3) + " cr";
  if (Math.abs(cr) < 10) return cr.toFixed(2) + " cr";
  if (Math.abs(cr) < 100) return cr.toFixed(1) + " cr";
  return Math.round(cr).toLocaleString() + " cr";
}
function fmtPctSigned(n) {
  if (n == null || !isFinite(n)) return "--";
  var sign = n < 0 ? "" : "+";
  return sign + (n * 100).toFixed(Math.abs(n) < 0.01 ? 2 : 1) + "%";
}
function fmtTok(n) {
  if (!n) return "0";
  if (n < 1000) return String(n);
  if (n < 10000) return (n / 1000).toFixed(1) + "k";
  return Math.round(n / 1000).toLocaleString() + "k";
}

function makeFormatter(unit) {
  return unit === "credits" ? fmtCr : fmtUsd;
}

function VerdictBanner({ verdict }) {
  var toneColor = ({
    success: theme.semantic.success,
    warning: theme.semantic.warning,
    error: theme.semantic.error,
    neutral: theme.text.secondary,
  })[verdict.tone] || theme.text.secondary;
  var bg = ({
    success: alpha(theme.semantic.success, 0.08),
    warning: alpha(theme.semantic.warning, 0.08),
    error: alpha(theme.semantic.error, 0.08),
    neutral: theme.bg.raised,
  })[verdict.tone] || theme.bg.raised;
  return (
    <div style={{
      background: bg,
      border: "1px solid " + alpha(toneColor, 0.30),
      borderLeft: "3px solid " + toneColor,
      borderRadius: theme.radius.md,
      padding: "14px 16px",
    }}>
      <div style={{ fontSize: theme.fontSize.lg, fontWeight: 600, color: theme.text.primary, marginBottom: 4 }}>
        {verdict.headline}
      </div>
      <div style={{ fontSize: theme.fontSize.sm, color: theme.text.secondary, lineHeight: 1.5 }}>
        {verdict.detail}
      </div>
    </div>
  );
}

function HeadlineCards({ cmp, fmt, nameA, nameB }) {
  var delta = cmp.b.totalCost - cmp.a.totalCost;
  var deltaPct = cmp.a.totalCost > 0 ? delta / cmp.a.totalCost : null;
  var deltaColor = delta < -1e-9 ? theme.semantic.success : (delta > 1e-9 ? theme.semantic.warning : theme.text.secondary);
  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
      <Card label={nameA} value={fmt(cmp.a.totalCost)} accent={COLOR_A}>
        <Sub>{cmp.a.llmCallCount} calls / {fmtTok(cmp.a.totalInput + cmp.a.totalOutput)} tok</Sub>
      </Card>
      <Card label={nameB} value={fmt(cmp.b.totalCost)} accent={COLOR_B}>
        <Sub>{cmp.b.llmCallCount} calls / {fmtTok(cmp.b.totalInput + cmp.b.totalOutput)} tok</Sub>
      </Card>
      <Card label="B - A" value={(delta >= 0 ? "+" : "") + fmt(delta)} accent={deltaColor}>
        <Sub>{deltaPct != null ? fmtPctSigned(deltaPct) : "--"}</Sub>
      </Card>
    </div>
  );
}

function Card({ label, value, accent, children }) {
  return (
    <div style={{
      background: theme.bg.raised,
      border: "1px solid " + theme.border.default,
      borderTop: "3px solid " + accent,
      borderRadius: theme.radius.md,
      padding: "12px 14px",
    }}>
      <div style={{ fontSize: theme.fontSize.xs, color: theme.text.muted, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 6 }}>{label}</div>
      <div style={{ fontSize: theme.fontSize.xxl, fontWeight: 600, color: theme.text.primary }}>{value}</div>
      <div style={{ marginTop: 4 }}>{children}</div>
    </div>
  );
}
function Sub({ children }) {
  return <div style={{ fontSize: theme.fontSize.xs, color: theme.text.muted }}>{children}</div>;
}

function BucketWaterfall({ deltas, fmt }) {
  if (!deltas || deltas.length === 0) return null;
  var maxAbs = deltas.reduce(function (m, d) { return Math.max(m, Math.abs(d.deltaCost)); }, 0) || 1;
  return (
    <Section title="Bucket cost delta (B - A)">
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {deltas.map(function (d) {
          var pct = Math.abs(d.deltaCost) / maxAbs;
          var positive = d.deltaCost >= 0;
          return (
            <div key={d.bucket} style={{ display: "grid", gridTemplateColumns: "140px 1fr 110px", gap: 12, alignItems: "center" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: theme.fontSize.sm, color: theme.text.secondary }}>
                <span style={{ width: 10, height: 10, borderRadius: 2, background: BUCKET_COLOR[d.bucket] || theme.text.muted }} />
                {BUCKET_LABEL[d.bucket] || d.bucket}
              </div>
              <div style={{ position: "relative", height: 14, background: theme.bg.surface, borderRadius: 2 }}>
                <div style={{
                  position: "absolute",
                  left: positive ? "50%" : (50 - pct * 50) + "%",
                  width: (pct * 50) + "%",
                  top: 0, bottom: 0,
                  background: positive ? alpha(theme.semantic.warning, 0.55) : alpha(theme.semantic.success, 0.55),
                  borderRadius: 2,
                }} />
                <div style={{ position: "absolute", left: "50%", top: -2, bottom: -2, width: 1, background: theme.border.default }} />
              </div>
              <div style={{ textAlign: "right", fontSize: theme.fontSize.sm, color: positive ? theme.semantic.warning : theme.semantic.success, fontVariantNumeric: "tabular-nums" }}>
                {(d.deltaCost >= 0 ? "+" : "") + fmt(d.deltaCost)}
              </div>
            </div>
          );
        })}
      </div>
    </Section>
  );
}

function KpiPanel({ kpis, fmt }) {
  if (!kpis || kpis.length === 0) return null;
  return (
    <Section title="Key metrics">
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", gap: 8 }}>
        {kpis.map(function (k) {
          var format = k.kind === "currency" ? fmt : (k.kind === "tokens" ? fmtTok : function (v) { return String(v); });
          var delta = (k.b || 0) - (k.a || 0);
          var deltaColor = delta < -1e-9
            ? (k.lowerIsBetter ? theme.semantic.success : theme.semantic.warning)
            : (delta > 1e-9 ? (k.lowerIsBetter ? theme.semantic.warning : theme.semantic.success) : theme.text.muted);
          return (
            <div key={k.label} style={{
              background: theme.bg.raised,
              border: "1px solid " + theme.border.default,
              borderRadius: theme.radius.md,
              padding: "8px 10px",
            }}>
              <div style={{ fontSize: theme.fontSize.xs, color: theme.text.muted, textTransform: "uppercase", letterSpacing: 0.4 }}>{k.label}</div>
              <div style={{ display: "flex", justifyContent: "space-between", marginTop: 4, fontSize: theme.fontSize.sm, color: theme.text.primary }}>
                <span><span style={{ color: COLOR_A }}>A</span> {format(k.a || 0)}</span>
                <span><span style={{ color: COLOR_B }}>B</span> {format(k.b || 0)}</span>
              </div>
              <div style={{ marginTop: 4, fontSize: theme.fontSize.xs, color: deltaColor, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                {(delta >= 0 ? "+" : "") + format(delta)}
              </div>
            </div>
          );
        })}
      </div>
    </Section>
  );
}

function BehavioralPanel({ behav, fmt }) {
  if (!behav) return null;
  var rows = [
    { key: "outputTokens", label: "Output tokens (path noise immune in prefix)" },
    { key: "primaryAssistantTurnCount", label: "Primary assistant turns" },
    { key: "primaryAssistantOutputTokens", label: "Primary assistant output tokens" },
    { key: "toolCallCount", label: "Tool calls" },
    { key: "uniqueToolKinds", label: "Unique tool kinds" },
  ];
  return (
    <Section title="Behavioral KPIs (path-noise resistant)">
      <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: 4 }}>
        {rows.map(function (r) {
          var pair = behav[r.key];
          if (!pair) return null;
          var format = pair.kind === "currency" ? fmt : (pair.kind === "tokens" ? fmtTok : function (v) { return String(v); });
          var delta = (pair.b || 0) - (pair.a || 0);
          return (
            <div key={r.key} style={{ display: "grid", gridTemplateColumns: "1fr auto auto auto", gap: 12, padding: "4px 0", borderBottom: "1px solid " + alpha(theme.border.default, 0.5), fontSize: theme.fontSize.sm }}>
              <span style={{ color: theme.text.secondary }}>{r.label}</span>
              <span style={{ color: COLOR_A, fontVariantNumeric: "tabular-nums" }}>{format(pair.a || 0)}</span>
              <span style={{ color: COLOR_B, fontVariantNumeric: "tabular-nums" }}>{format(pair.b || 0)}</span>
              <span style={{ color: theme.text.muted, fontVariantNumeric: "tabular-nums" }}>{(delta >= 0 ? "+" : "") + format(delta)}</span>
            </div>
          );
        })}
      </div>
    </Section>
  );
}

function Recommendations({ recs }) {
  if (!recs || recs.length === 0) return null;
  return (
    <Section title="Recommendations">
      <ul style={{ margin: 0, paddingLeft: 18, fontSize: theme.fontSize.sm, color: theme.text.secondary }}>
        {recs.map(function (r, i) {
          return (
            <li key={i} style={{ marginBottom: 6 }}>
              <span style={{ color: theme.text.primary, fontWeight: 600 }}>{r.headline}</span>
              {r.detail ? <span> -- {r.detail}</span> : null}
            </li>
          );
        })}
      </ul>
    </Section>
  );
}

function CachePollutionWarning({ pollution }) {
  if (!pollution || !pollution.suspect) return null;
  return (
    <div style={{
      background: alpha(theme.semantic.warning, 0.08),
      border: "1px solid " + alpha(theme.semantic.warning, 0.30),
      borderLeft: "3px solid " + theme.semantic.warning,
      borderRadius: theme.radius.md,
      padding: "10px 12px",
      fontSize: theme.fontSize.sm,
      color: theme.text.secondary,
    }}>
      <strong style={{ color: theme.semantic.warning }}>Cache pollution suspected. </strong>
      {pollution.reason || "Headline numbers may not be apples-to-apples."}
    </div>
  );
}

function DriftPanel({ drift }) {
  if (!drift || !Array.isArray(drift.rows) || drift.rows.length === 0) return null;
  var divergent = drift.rows.filter(function (r) { return r.status !== "match"; });
  if (divergent.length === 0) return null;
  return (
    <Section title={"Run drift (" + divergent.length + " divergent of " + drift.rows.length + ")"}>
      <div style={{ display: "grid", gridTemplateColumns: "180px 1fr 1fr", gap: 8, fontSize: theme.fontSize.xs }}>
        <div style={{ color: theme.text.muted, fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.4 }}>Axis</div>
        <div style={{ color: COLOR_A, fontWeight: 600 }}>A</div>
        <div style={{ color: COLOR_B, fontWeight: 600 }}>B</div>
        {divergent.slice(0, 12).map(function (r) {
          return [
            <div key={r.label + ":l"} style={{ color: theme.text.secondary }}>{r.label}</div>,
            <div key={r.label + ":a"} style={{ color: theme.text.primary, fontFamily: theme.font.mono }}>{String(r.a == null ? "--" : r.a)}</div>,
            <div key={r.label + ":b"} style={{ color: theme.text.primary, fontFamily: theme.font.mono }}>{String(r.b == null ? "--" : r.b)}</div>,
          ];
        })}
      </div>
    </Section>
  );
}

function Section({ title, children }) {
  return (
    <div style={{
      background: theme.bg.surface,
      border: "1px solid " + theme.border.default,
      borderRadius: theme.radius.md,
      padding: "12px 14px",
    }}>
      <div style={{ fontSize: theme.fontSize.sm, fontWeight: 600, color: theme.text.primary, marginBottom: 10 }}>{title}</div>
      {children}
    </div>
  );
}

function ToggleGroup({ value, options, onChange }) {
  return (
    <div style={{
      display: "inline-flex", gap: 2,
      background: theme.bg.surface, borderRadius: theme.radius.md, padding: 2,
    }}>
      {options.map(function (o) {
        var active = value === o.id;
        return (
          <button
            key={o.id}
            className="av-btn"
            onClick={function () { onChange(o.id); }}
            style={{
              background: active ? theme.bg.raised : "transparent",
              color: active ? theme.accent.primary : theme.text.muted,
              border: "none",
              borderRadius: theme.radius.sm,
              padding: "3px 10px",
              fontSize: theme.fontSize.xs,
              fontFamily: theme.font.mono,
              cursor: "pointer",
            }}
          >{o.label}</button>
        );
      })}
    </div>
  );
}

function getCostAnalysis(session) {
  return session && session.metadata && session.metadata.costAnalysis;
}

export default function CostCompare({ sessionA, sessionB }) {
  var [unit, setUnit] = useState("usd");
  var [copied, setCopied] = useState(false);

  var nameA = useMemo(function () { return prettifyRunName(sessionA && sessionA.file); }, [sessionA]);
  var nameB = useMemo(function () { return prettifyRunName(sessionB && sessionB.file); }, [sessionB]);

  var caA = getCostAnalysis(sessionA);
  var caB = getCostAnalysis(sessionB);

  var cmp = useMemo(function () {
    if (!caA || !caB) return null;
    try { return compareRunsCost(caA, caB); }
    catch (e) { return null; }
  }, [caA, caB]);

  if (!cmp) {
    return (
      <div style={{ padding: 24, color: theme.text.muted, fontSize: theme.fontSize.sm, lineHeight: 1.6 }}>
        Cost comparison is only available when both sessions are VS Code Copilot Chat exports
        (<code>copilot_all_prompts_*.json</code>). Load two of those exports into the Compare view
        and re-open this tab.
        {(!caA || !caB) && (
          <div style={{ marginTop: 12, fontSize: theme.fontSize.xs, color: theme.text.muted }}>
            Detected: A {caA ? "OK" : "missing costAnalysis"}, B {caB ? "OK" : "missing costAnalysis"}.
          </div>
        )}
      </div>
    );
  }

  var fmt = makeFormatter(unit);

  function copyMarkdown() {
    var md = formatComparisonAsMarkdown(cmp, { nameA: nameA, nameB: nameB });
    try {
      if (typeof navigator !== "undefined" && navigator.clipboard) {
        navigator.clipboard.writeText(md).then(function () {
          setCopied(true);
          setTimeout(function () { setCopied(false); }, 1500);
        });
      }
    } catch (e) { /* swallow */ }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12, overflow: "auto", padding: 16, minHeight: 0 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div style={{ fontSize: theme.fontSize.sm, color: theme.text.muted }}>
          Comparing <span style={{ color: COLOR_A }}>{nameA}</span> vs <span style={{ color: COLOR_B }}>{nameB}</span>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <ToggleGroup
            value={unit}
            options={[{ id: "usd", label: "USD" }, { id: "credits", label: "AI Credits" }]}
            onChange={setUnit}
          />
          <button
            className="av-btn"
            onClick={copyMarkdown}
            style={{
              background: theme.bg.raised,
              color: theme.text.primary,
              border: "1px solid " + theme.border.default,
              borderRadius: theme.radius.sm,
              padding: "4px 10px",
              fontSize: theme.fontSize.xs,
              fontFamily: theme.font.mono,
              cursor: "pointer",
            }}
          >{copied ? "copied" : "copy summary as markdown"}</button>
        </div>
      </div>

      <VerdictBanner verdict={cmp.verdict} />
      <HeadlineCards cmp={cmp} fmt={fmt} nameA={nameA} nameB={nameB} />
      <CachePollutionWarning pollution={cmp.cachePollution} />
      <BucketWaterfall deltas={cmp.bucketDeltas} fmt={fmt} />
      <KpiPanel kpis={cmp.kpis} fmt={fmt} />
      <BehavioralPanel behav={cmp.behavioralKpis} fmt={fmt} />
      <Recommendations recs={cmp.recommendations} />
      <DriftPanel drift={cmp.drift} />
    </div>
  );
}
