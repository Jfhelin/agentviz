import { useMemo } from "react";
import { theme, alpha } from "../lib/theme.js";
import { compareRunsCost, BUCKETS } from "../lib/compareCost";
import { prettifyRunName } from "../lib/runDisplayName";

// A = primary blue, B = system purple. Matches the convention used elsewhere
// in CompareView for A/B accent colors.
const COLOR_A = theme.accent.primary;
const COLOR_B = theme.agent.system;

const BUCKET_COLOR = {
  system:       theme.cost.ctxSystem,
  tool_defs:    theme.cost.ctxToolDefs,
  history:      theme.cost.ctxHistory,
  tool_results: theme.cost.ctxToolResults,
  current:      theme.cost.ctxCurrent,
  output:       theme.cost.ctxOutput,
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
  if (!isFinite(n)) return "--";
  if (n === 0) return "$0.00";
  if (Math.abs(n) < 0.001) return "$" + n.toFixed(5);
  if (Math.abs(n) < 0.01) return "$" + n.toFixed(4);
  if (Math.abs(n) < 1) return "$" + n.toFixed(3);
  return "$" + n.toFixed(2);
}
function fmtCr(n) {
  if (!isFinite(n)) return "--";
  const cr = n * 100;
  if (cr === 0) return "0 cr";
  if (Math.abs(cr) < 0.01) return cr.toFixed(3) + " cr";
  if (Math.abs(cr) < 10) return cr.toFixed(2) + " cr";
  if (Math.abs(cr) < 100) return cr.toFixed(1) + " cr";
  return Math.round(cr).toLocaleString() + " cr";
}
function fmtPct(n, decimals) {
  if (n == null || !isFinite(n)) return "--";
  const d = decimals == null ? 1 : decimals;
  return (n * 100).toFixed(d) + "%";
}
function fmtPctSigned(n) {
  if (n == null || !isFinite(n)) return "--";
  const sign = n < 0 ? "" : "+"; // negative prints its own sign
  return sign + (n * 100).toFixed(Math.abs(n) < 0.01 ? 2 : 1) + "%";
}
function fmtTok(n) {
  if (!n) return "0";
  if (n < 1000) return String(n);
  if (n < 10000) return (n / 1000).toFixed(1) + "k";
  return Math.round(n / 1000).toLocaleString() + "k";
}

function fmtRate(n) {
  // Cost per 1M tokens. Input is computed in dollars/M tokens.
  if (!isFinite(n) || n === 0) return "--";
  if (n < 0.10) return "$" + n.toFixed(3) + "/M";
  if (n < 10) return "$" + n.toFixed(2) + "/M";
  return "$" + n.toFixed(1) + "/M";
}

function getCostAnalysis(session) {
  return session && session.metadata && session.metadata.costAnalysis;
}

function VerdictBanner({ verdict }) {
  const toneColor = {
    success: theme.semantic.success,
    warning: theme.semantic.warning,
    error: theme.semantic.error,
    neutral: theme.text.secondary,
  }[verdict.tone] || theme.text.secondary;
  const bg = {
    success: alpha(theme.semantic.success, 0.08),
    warning: alpha(theme.semantic.warning, 0.08),
    error: alpha(theme.semantic.error, 0.08),
    neutral: theme.bg.raised,
  }[verdict.tone] || theme.bg.raised;
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

function HeaderStrip({ nameA, nameB, primaryModelA, primaryModelB, costA, costB, summaryA, summaryB }) {
  function rateLine(s) {
    if (!s) return null;
    return (
      <div style={{ fontSize: 10, color: theme.text.muted, marginTop: 4, fontVariantNumeric: "tabular-nums" }}>
        in {fmtRate(s.avgInputRatePerMTok)} · out {fmtRate(s.avgOutputRatePerMTok)}
      </div>
    );
  }
  return (
    <div style={{
      display: "grid",
      gridTemplateColumns: "1fr auto 1fr",
      gap: 16,
      alignItems: "center",
      padding: "14px 18px",
      background: theme.bg.raised,
      border: "1px solid " + theme.border.default,
      borderRadius: theme.radius.md,
    }}>
      <div style={{ textAlign: "right", borderRight: "1px solid " + theme.border.default, paddingRight: 16 }}>
        <div style={{ fontSize: theme.fontSize.xs, color: theme.text.dim, textTransform: "uppercase", letterSpacing: "0.08em" }}>Run A</div>
        <div style={{ fontSize: theme.fontSize.lg, fontWeight: 600, color: COLOR_A, marginTop: 2 }}>{nameA}</div>
        <div style={{ fontSize: theme.fontSize.xs, color: theme.text.muted, marginTop: 2 }}>{primaryModelA || "--"}</div>
        <div style={{ fontSize: theme.fontSize.xl, fontWeight: 700, color: theme.text.primary, marginTop: 6, fontVariantNumeric: "tabular-nums" }}>
          {fmtCr(costA)}
        </div>
        <div style={{ fontSize: theme.fontSize.xs, color: theme.text.dim, fontVariantNumeric: "tabular-nums" }}>{fmtUsd(costA)}</div>
        {rateLine(summaryA)}
      </div>
      <div style={{ color: theme.text.dim, fontSize: 24 }}>→</div>
      <div style={{ paddingLeft: 16 }}>
        <div style={{ fontSize: theme.fontSize.xs, color: theme.text.dim, textTransform: "uppercase", letterSpacing: "0.08em" }}>Run B</div>
        <div style={{ fontSize: theme.fontSize.lg, fontWeight: 600, color: COLOR_B, marginTop: 2 }}>{nameB}</div>
        <div style={{ fontSize: theme.fontSize.xs, color: theme.text.muted, marginTop: 2 }}>{primaryModelB || "--"}</div>
        <div style={{ fontSize: theme.fontSize.xl, fontWeight: 700, color: theme.text.primary, marginTop: 6, fontVariantNumeric: "tabular-nums" }}>
          {fmtCr(costB)}
        </div>
        <div style={{ fontSize: theme.fontSize.xs, color: theme.text.dim, fontVariantNumeric: "tabular-nums" }}>{fmtUsd(costB)}</div>
        {rateLine(summaryB)}
      </div>
    </div>
  );
}

function KpiGrid({ kpis, equivalent }) {
  function fmtKpi(k, v) {
    if (k.key === "cache_hit" || k.key === "fixed_share") return fmtPct(v, 1);
    if (k.key === "output_tokens") return fmtTok(v);
    if (k.key === "cr_per_out_tok") return fmtCr(v);
    if (k.key === "cr_per_call") return fmtCr(v);
    if (k.key === "avg_in_rate" || k.key === "avg_out_rate") return fmtRate(v);
    return fmtCr(v);
  }
  function deltaTone(k) {
    if (Math.abs(k.deltaPct || 0) < 0.02) return theme.text.muted;
    if (k.direction === "lower") return k.delta < 0 ? theme.semantic.success : theme.semantic.error;
    if (k.direction === "higher") return k.delta > 0 ? theme.semantic.success : theme.semantic.error;
    return theme.text.muted;
  }
  function deltaText(k) {
    if (k.deltaPct == null) return "--";
    return "Δ " + fmtPctSigned(k.deltaPct);
  }

  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 8 }}>
      {kpis.map(k => (
        <div key={k.key} style={{
          background: theme.bg.raised,
          border: "1px solid " + theme.border.default,
          borderRadius: theme.radius.md,
          padding: "10px 12px",
        }}>
          <div style={{ fontSize: 10, color: theme.text.dim, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 6 }}>{k.label}</div>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 6, alignItems: "baseline" }}>
            <span style={{ color: COLOR_A, fontVariantNumeric: "tabular-nums", fontSize: theme.fontSize.sm, fontWeight: 600 }}>{fmtKpi(k, k.a)}</span>
            <span style={{ color: COLOR_B, fontVariantNumeric: "tabular-nums", fontSize: theme.fontSize.sm, fontWeight: 600 }}>{fmtKpi(k, k.b)}</span>
          </div>
          <div style={{
            marginTop: 8, paddingTop: 6, borderTop: "1px solid " + theme.border.default,
            fontSize: 10, color: deltaTone(k), fontVariantNumeric: "tabular-nums",
          }}>{deltaText(k)}</div>
        </div>
      ))}
      <div style={{
        background: equivalent ? alpha(theme.semantic.success, 0.08) : alpha(theme.semantic.warning, 0.08),
        border: "1px solid " + alpha(equivalent ? theme.semantic.success : theme.semantic.warning, 0.30),
        borderRadius: theme.radius.md,
        padding: "10px 12px",
      }}>
        <div style={{ fontSize: 10, color: equivalent ? theme.semantic.success : theme.semantic.warning, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 6 }}>
          Answer equivalence
        </div>
        <div style={{ fontSize: theme.fontSize.sm, color: equivalent ? theme.semantic.success : theme.semantic.warning, fontWeight: 600 }}>
          {equivalent ? "✓ identical" : "differs"}
        </div>
        <div style={{ marginTop: 8, paddingTop: 6, borderTop: "1px solid " + alpha(equivalent ? theme.semantic.success : theme.semantic.warning, 0.20), fontSize: 10, color: theme.text.muted }}>
          final response
        </div>
      </div>
    </div>
  );
}

function FixedVsVariable({ a, b }) {
  function bar(label, color, fixed, variable) {
    const total = fixed + variable;
    const fxPct = total > 0 ? fixed / total : 0;
    const varPct = total > 0 ? variable / total : 0;
    return (
      <div style={{ display: "grid", gridTemplateColumns: "100px 1fr 90px", gap: 12, alignItems: "center", padding: "6px 0" }}>
        <div style={{ fontSize: theme.fontSize.xs, color: theme.text.secondary }}>
          <div>{label}</div>
        </div>
        <div style={{ display: "flex", height: 22, background: theme.bg.base, borderRadius: theme.radius.sm, overflow: "hidden" }}>
          <div title={"Fixed: " + fmtPct(fxPct, 1)} style={{
            width: (fxPct * 100) + "%",
            background: alpha(color, 0.55),
            display: "flex", alignItems: "center", padding: "0 8px",
            fontSize: 10, fontWeight: 600, color: theme.text.primary, whiteSpace: "nowrap",
          }}>
            {fxPct > 0.10 ? fmtPct(fxPct, 0) + " fixed" : ""}
          </div>
          <div title={"Variable: " + fmtPct(varPct, 1)} style={{
            width: (varPct * 100) + "%",
            background: theme.semantic.success,
            display: "flex", alignItems: "center", padding: "0 8px",
            fontSize: 10, fontWeight: 600, color: "rgba(0,0,0,0.7)", whiteSpace: "nowrap",
          }}>
            {varPct > 0.10 ? fmtPct(varPct, 0) + " variable" : ""}
          </div>
        </div>
        <div style={{ fontSize: theme.fontSize.xs, color, textAlign: "right", fontVariantNumeric: "tabular-nums", fontWeight: 600 }}>
          {fmtCr(total)}
        </div>
      </div>
    );
  }
  return (
    <div>
      {bar("A", COLOR_A, a.fixedCost, a.variableCost)}
      {bar("B", COLOR_B, b.fixedCost, b.variableCost)}
      <div style={{
        marginTop: 10, padding: "10px 12px",
        background: theme.bg.base, borderLeft: "3px solid " + theme.accent.primary,
        borderRadius: theme.radius.sm,
        fontSize: theme.fontSize.xs, color: theme.text.secondary, lineHeight: 1.6,
      }}>
        <strong style={{ color: theme.text.primary }}>Fixed</strong> = system prompt + tool definitions injected on every call.
        <strong style={{ color: theme.text.primary }}> Variable</strong> = your prompt + history + tool results + the model's response.
        Lowering the variable share (caveman-style prompting) only helps when fixed isn't already dominant.
      </div>
    </div>
  );
}

function ComponentStacks({ a, b }) {
  function row(label, color, share) {
    return (
      <div style={{ marginBottom: 10 }}>
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: theme.fontSize.xs, marginBottom: 3 }}>
          <span style={{ color: theme.text.secondary }}>
            <span style={{
              display: "inline-block", padding: "1px 6px", borderRadius: 3,
              background: color, color: "white",
              fontSize: 9, fontWeight: 600, marginRight: 6,
            }}>{label}</span>
          </span>
          <span style={{ color: theme.text.muted, fontVariantNumeric: "tabular-nums" }}>{fmtPct(BUCKETS.reduce((s,k)=>s+share[k],0), 0)}</span>
        </div>
        <div style={{ display: "flex", height: 18, background: theme.bg.base, borderRadius: theme.radius.sm, overflow: "hidden" }}>
          {BUCKETS.map(k => (
            <div key={k}
              title={BUCKET_LABEL[k] + ": " + fmtPct(share[k], 1)}
              style={{ width: (share[k] * 100) + "%", background: BUCKET_COLOR[k] }} />
          ))}
        </div>
      </div>
    );
  }
  return (
    <div>
      {row("A", COLOR_A, a.componentShare)}
      {row("B", COLOR_B, b.componentShare)}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 12, marginTop: 12, paddingTop: 10, borderTop: "1px solid " + theme.border.default }}>
        {BUCKETS.map(k => (
          <div key={k} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: theme.fontSize.xs, color: theme.text.muted }}>
            <div style={{ width: 10, height: 10, borderRadius: 2, background: BUCKET_COLOR[k] }} />
            {BUCKET_LABEL[k]}
          </div>
        ))}
      </div>
    </div>
  );
}

function CallTable({ pairs }) {
  return (
    <div style={{ overflowX: "auto" }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: theme.fontSize.xs }}>
        <thead>
          <tr style={{ background: theme.bg.raised }}>
            <th style={{ textAlign: "left", padding: "8px 10px", color: theme.text.muted, fontWeight: 500, textTransform: "uppercase", fontSize: 10, letterSpacing: "0.05em" }}>Call</th>
            <th style={{ textAlign: "left", padding: "8px 10px", color: theme.text.muted, fontWeight: 500, textTransform: "uppercase", fontSize: 10, letterSpacing: "0.05em" }}>Model</th>
            <th style={{ textAlign: "right", padding: "8px 10px", color: COLOR_A, fontWeight: 500, textTransform: "uppercase", fontSize: 10, letterSpacing: "0.05em" }}>A in</th>
            <th style={{ textAlign: "right", padding: "8px 10px", color: COLOR_B, fontWeight: 500, textTransform: "uppercase", fontSize: 10, letterSpacing: "0.05em" }}>B in</th>
            <th style={{ textAlign: "right", padding: "8px 10px", color: COLOR_A, fontWeight: 500, textTransform: "uppercase", fontSize: 10, letterSpacing: "0.05em" }}>A out</th>
            <th style={{ textAlign: "right", padding: "8px 10px", color: COLOR_B, fontWeight: 500, textTransform: "uppercase", fontSize: 10, letterSpacing: "0.05em" }}>B out</th>
            <th style={{ textAlign: "right", padding: "8px 10px", color: COLOR_A, fontWeight: 500, textTransform: "uppercase", fontSize: 10, letterSpacing: "0.05em" }}>A cost</th>
            <th style={{ textAlign: "right", padding: "8px 10px", color: COLOR_B, fontWeight: 500, textTransform: "uppercase", fontSize: 10, letterSpacing: "0.05em" }}>B cost</th>
            <th style={{ textAlign: "right", padding: "8px 10px", color: theme.text.muted, fontWeight: 500, textTransform: "uppercase", fontSize: 10, letterSpacing: "0.05em" }}>Δ</th>
          </tr>
        </thead>
        <tbody>
          {pairs.map((p, i) => {
            const aCost = p.a ? p.a.cost : 0;
            const bCost = p.b ? p.b.cost : 0;
            const dPct = aCost > 0 ? (bCost - aCost) / aCost : null;
            const dColor = dPct == null ? theme.text.muted
              : Math.abs(dPct) < 0.02 ? theme.text.muted
              : dPct < 0 ? theme.semantic.success : theme.semantic.error;
            return (
              <tr key={i} style={{ borderBottom: "1px solid " + theme.border.subtle }}>
                <td style={{ padding: "8px 10px", color: theme.text.primary }}>
                  {p.name}
                  {!p.sameModel && p.a && p.b && (
                    <div style={{ fontSize: 9, color: theme.semantic.warning, marginTop: 2 }}>model differs</div>
                  )}
                </td>
                <td style={{ padding: "8px 10px", color: theme.text.secondary }}>
                  {p.a && p.b && p.sameModel ? p.a.model
                    : (p.a ? p.a.model : "--") + " / " + (p.b ? p.b.model : "--")}
                </td>
                <td style={{ padding: "8px 10px", textAlign: "right", color: COLOR_A, fontVariantNumeric: "tabular-nums" }}>{p.a ? (p.a.promptTokens ?? 0).toLocaleString() : "--"}</td>
                <td style={{ padding: "8px 10px", textAlign: "right", color: COLOR_B, fontVariantNumeric: "tabular-nums" }}>{p.b ? (p.b.promptTokens ?? 0).toLocaleString() : "--"}</td>
                <td style={{ padding: "8px 10px", textAlign: "right", color: COLOR_A, fontVariantNumeric: "tabular-nums" }}>{p.a ? (p.a.output ?? 0).toLocaleString() : "--"}</td>
                <td style={{ padding: "8px 10px", textAlign: "right", color: COLOR_B, fontVariantNumeric: "tabular-nums" }}>{p.b ? (p.b.output ?? 0).toLocaleString() : "--"}</td>
                <td style={{ padding: "8px 10px", textAlign: "right", color: COLOR_A, fontVariantNumeric: "tabular-nums" }}>{p.a ? fmtCr(aCost) : "--"}</td>
                <td style={{ padding: "8px 10px", textAlign: "right", color: COLOR_B, fontVariantNumeric: "tabular-nums" }}>{p.b ? fmtCr(bCost) : "--"}</td>
                <td style={{ padding: "8px 10px", textAlign: "right", color: dColor, fontVariantNumeric: "tabular-nums" }}>{dPct == null ? "--" : fmtPctSigned(dPct)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function IOSideBySide({ userA, userB, ansA, ansB, equivalent, nameA, nameB, promptsA, promptsB }) {
  const listA = promptsA && promptsA.length ? promptsA : [{ label: userA, finalAnswer: ansA }];
  const listB = promptsB && promptsB.length ? promptsB : [{ label: userB, finalAnswer: ansB }];
  const rowCount = Math.max(listA.length, listB.length);
  const isMulti = rowCount > 1;

  function pane(name, color, prompt, answer) {
    return (
      <div style={{
        background: theme.bg.raised, border: "1px solid " + theme.border.default,
        borderLeft: "3px solid " + color,
        borderRadius: theme.radius.md, padding: "12px 14px",
      }}>
        {name && (
          <div style={{ fontSize: 10, color: theme.text.dim, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 6 }}>{name}</div>
        )}
        <div style={{ fontSize: theme.fontSize.xs, color: theme.text.secondary, marginBottom: 4 }}>You asked:</div>
        <div style={{
          background: theme.bg.base, padding: "8px 10px", borderRadius: theme.radius.sm,
          fontSize: theme.fontSize.sm, color: theme.text.primary, marginBottom: 8,
          maxHeight: 120, overflow: "auto", lineHeight: 1.5,
        }}>
          {prompt || <em style={{ color: theme.text.dim }}>(no user-facing prompt in this run)</em>}
        </div>
        <div style={{ fontSize: theme.fontSize.xs, color: theme.text.secondary, marginBottom: 4 }}>Model answered:</div>
        <div style={{
          background: alpha(theme.semantic.success, 0.08),
          border: "1px solid " + alpha(theme.semantic.success, 0.20),
          padding: "8px 10px", borderRadius: theme.radius.sm,
          color: theme.semantic.success, fontSize: theme.fontSize.sm, fontWeight: 600,
          maxHeight: 120, overflow: "auto", lineHeight: 1.5,
        }}>
          {answer || <em style={{ color: theme.text.dim, fontWeight: 400 }}>(no response captured)</em>}
        </div>
      </div>
    );
  }

  function rowEquivalent(a, b) {
    const na = (a || "").trim().toLowerCase().replace(/\s+/g, " ");
    const nb = (b || "").trim().toLowerCase().replace(/\s+/g, " ");
    return na.length > 0 && nb.length > 0 && na === nb;
  }

  return (
    <div>
      {Array.from({ length: rowCount }).map((_, i) => {
        const a = listA[i];
        const b = listB[i];
        const promptA = a ? a.label : "";
        const promptB = b ? b.label : "";
        const answerA = a ? a.finalAnswer : "";
        const answerB = b ? b.finalAnswer : "";
        const eq = a && b ? rowEquivalent(answerA, answerB) : false;
        const showRowEq = isMulti && a && b;
        return (
          <div key={i} style={{ marginBottom: i < rowCount - 1 ? 16 : 0 }}>
            {isMulti && (
              <div style={{
                fontSize: 11, color: theme.text.muted, marginBottom: 6,
                textTransform: "uppercase", letterSpacing: "0.06em", fontWeight: 600,
              }}>
                Turn {i + 1}
                {showRowEq && (
                  <span style={{
                    marginLeft: 8, padding: "1px 6px", borderRadius: 999,
                    background: alpha(eq ? theme.semantic.success : theme.semantic.warning, 0.12),
                    color: eq ? theme.semantic.success : theme.semantic.warning,
                    fontSize: 10, letterSpacing: "0.04em",
                  }}>
                    {eq ? "✓ same answer" : "⚠ different answer"}
                  </span>
                )}
              </div>
            )}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
              {a ? pane(i === 0 ? nameA : null, COLOR_A, promptA, answerA)
                 : pane(i === 0 ? nameA : null, COLOR_A, "", "")}
              {b ? pane(i === 0 ? nameB : null, COLOR_B, promptB, answerB)
                 : pane(i === 0 ? nameB : null, COLOR_B, "", "")}
            </div>
          </div>
        );
      })}
      {!isMulti && (
        <div style={{
          marginTop: 10, padding: "8px 12px",
          background: equivalent ? alpha(theme.semantic.success, 0.08) : alpha(theme.semantic.warning, 0.08),
          border: "1px solid " + alpha(equivalent ? theme.semantic.success : theme.semantic.warning, 0.30),
          borderRadius: theme.radius.sm, color: equivalent ? theme.semantic.success : theme.semantic.warning,
          fontSize: theme.fontSize.xs, display: "flex", alignItems: "center", gap: 8,
        }}>
          <span style={{ fontSize: 14 }}>{equivalent ? "✓" : "⚠"}</span>
          <span>
            {equivalent
              ? "Answer equivalence detected. Both runs produced byte-identical final responses (after normalization)."
              : "Final responses differ. Review the answers above before drawing conclusions about cost differences."}
          </span>
        </div>
      )}
      {isMulti && listA.length !== listB.length && (
        <div style={{
          marginTop: 10, padding: "8px 12px",
          background: alpha(theme.semantic.warning, 0.08),
          border: "1px solid " + alpha(theme.semantic.warning, 0.30),
          borderRadius: theme.radius.sm, color: theme.semantic.warning,
          fontSize: theme.fontSize.xs,
        }}>
          ⚠ The two runs have different turn counts ({listA.length} vs {listB.length}). Unpaired turns are shown blank on the missing side.
        </div>
      )}
    </div>
  );
}

function BucketWaterfall({ deltas, totalA, totalB }) {
  // Use the LARGER side's component cost as the visual scale anchor so a
  // savings bar's length means "fraction of the original cost saved".
  const maxAbs = Math.max(...deltas.map(d => Math.abs(d.delta)), 0);
  if (maxAbs === 0) {
    return (
      <div style={{ fontSize: theme.fontSize.xs, color: theme.text.muted, padding: "8px 4px" }}>
        No per-bucket cost difference between the two runs.
      </div>
    );
  }
  const netDelta = totalB - totalA;
  return (
    <div>
      {deltas.map(d => {
        const isSaving = d.delta < 0;
        const isNoise = Math.abs(d.delta) / maxAbs < 0.005;
        const color = isNoise ? theme.text.dim : (isSaving ? theme.semantic.success : theme.semantic.error);
        const widthPct = (Math.abs(d.delta) / maxAbs) * 100;
        return (
          <div key={d.bucket} style={{ display: "grid", gridTemplateColumns: "120px 1fr 110px 70px", gap: 12, alignItems: "center", padding: "5px 0" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: theme.fontSize.xs, color: theme.text.secondary }}>
              <div style={{ width: 8, height: 8, borderRadius: 2, background: BUCKET_COLOR[d.bucket] }} />
              {BUCKET_LABEL[d.bucket]}
            </div>
            {/* Bidirectional bar: center divider, savings extend left, increases extend right. */}
            <div style={{ position: "relative", height: 18, background: theme.bg.base, borderRadius: theme.radius.sm }}>
              <div style={{
                position: "absolute", top: 0, bottom: 0, left: "50%",
                width: "1px", background: theme.border.default,
              }} />
              <div
                title={fmtCr(d.aCost) + " → " + fmtCr(d.bCost)}
                style={{
                  position: "absolute", top: 0, bottom: 0,
                  ...(isSaving
                    ? { right: "50%", width: (widthPct / 2) + "%" }
                    : { left: "50%", width: (widthPct / 2) + "%" }),
                  background: alpha(color, 0.6),
                  borderRadius: 2,
                }}
              />
            </div>
            <div style={{ fontSize: theme.fontSize.xs, color, textAlign: "right", fontVariantNumeric: "tabular-nums", fontWeight: 600 }}>
              {(d.delta < 0 ? "" : "+") + fmtCr(d.delta)}
            </div>
            <div style={{ fontSize: 10, color: theme.text.muted, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
              {d.deltaPct == null ? "" : fmtPctSigned(d.deltaPct)}
            </div>
          </div>
        );
      })}
      <div style={{
        marginTop: 6, paddingTop: 8, borderTop: "1px solid " + theme.border.default,
        display: "grid", gridTemplateColumns: "120px 1fr 110px 70px", gap: 12, alignItems: "center",
      }}>
        <div style={{ fontSize: theme.fontSize.xs, color: theme.text.primary, fontWeight: 600 }}>Net</div>
        <div />
        <div style={{
          fontSize: theme.fontSize.sm, fontWeight: 700, textAlign: "right", fontVariantNumeric: "tabular-nums",
          color: netDelta < 0 ? theme.semantic.success : (netDelta > 0 ? theme.semantic.error : theme.text.muted),
        }}>{(netDelta < 0 ? "" : "+") + fmtCr(netDelta)}</div>
        <div style={{ fontSize: 10, color: theme.text.muted, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
          {totalA > 0 ? fmtPctSigned(netDelta / totalA) : ""}
        </div>
      </div>
      <div style={{
        marginTop: 10, padding: "8px 12px", background: theme.bg.base,
        borderLeft: "3px solid " + theme.accent.primary, borderRadius: theme.radius.sm,
        fontSize: theme.fontSize.xs, color: theme.text.secondary, lineHeight: 1.5,
      }}>
        Bars are sized relative to the largest swing. <strong style={{ color: theme.semantic.success }}>Green left</strong> = B saved. <strong style={{ color: theme.semantic.error }}>Red right</strong> = B more expensive. Use this to attribute the headline delta to specific cost components.
      </div>
    </div>
  );
}

function RunDriftPanel({ drift, nameA, nameB }) {
  if (!drift || !drift.rows || drift.rows.length === 0) return null;
  const allMatch = !drift.hasAnyDrift;
  const hasBlocking = drift.hasBlockingDrift;

  // Tone of the panel header reflects severity:
  //   all match  -> success / quiet green
  //   non-blocking diff -> info / muted
  //   blocking diff -> warning
  const tone = hasBlocking ? "warning" : allMatch ? "success" : "info";
  const headerColor = tone === "warning"
    ? theme.semantic.warning
    : tone === "success"
      ? (theme.semantic.success || theme.accent.primary)
      : theme.text.secondary;
  const dotMatch = theme.semantic.success || theme.accent.primary;
  const dotInfo = theme.text.muted;
  const dotDiff = theme.semantic.warning;

  const headlineText = hasBlocking
    ? "Drift detected on something that should have been identical"
    : allMatch
      ? "Both runs match on every controlled axis"
      : "Minor drift — likely fine, see details";

  return (
    <div>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 8 }}>
        <span style={{ fontSize: theme.fontSize.sm, fontWeight: 700, color: headerColor }}>
          {hasBlocking ? "⚠" : allMatch ? "✓" : "•"} Run drift
        </span>
        <span style={{ fontSize: theme.fontSize.xs, color: theme.text.muted }}>{headlineText}</span>
      </div>
      <div style={{ display: "grid", rowGap: 6 }}>
        {drift.rows.map((row) => {
          const dotColor =
            row.status === "match" ? dotMatch
            : row.status === "diff" ? dotDiff
            : dotInfo;
          const symbol =
            row.status === "match" ? "✓"
            : row.status === "diff" ? "⚠"
            : "•";
          return (
            <div key={row.key} style={{
              display: "grid",
              gridTemplateColumns: "20px 140px 1fr 1fr",
              columnGap: 12, alignItems: "baseline",
              fontSize: theme.fontSize.xs,
              fontVariantNumeric: "tabular-nums",
              padding: "4px 0",
              borderBottom: "1px solid " + theme.border.subtle,
            }}>
              <div style={{ color: dotColor, fontWeight: 700, textAlign: "center" }}>{symbol}</div>
              <div style={{ color: theme.text.secondary }}>{row.label}</div>
              <div style={{ color: row.status === "diff" ? theme.text.primary : theme.text.muted }}>
                <span style={{ color: COLOR_A, fontWeight: 600 }}>A:</span> {row.aText || "(empty)"}
              </div>
              <div style={{ color: row.status === "diff" ? theme.text.primary : theme.text.muted }}>
                {row.bText
                  ? <><span style={{ color: COLOR_B, fontWeight: 600 }}>B:</span> {row.bText}</>
                  : <span style={{ color: theme.text.dim, fontStyle: "italic" }}>— same as A —</span>}
              </div>
              {row.detail && (
                <div style={{ gridColumn: "2 / -1", color: theme.text.muted, fontSize: 11, marginTop: 2, lineHeight: 1.5 }}>
                  {row.detail}
                </div>
              )}
            </div>
          );
        })}
      </div>
      <div style={{ marginTop: 8, fontSize: 10, color: theme.text.dim, lineHeight: 1.5 }}>
        Comparing <span style={{ color: COLOR_A }}>{nameA}</span> vs <span style={{ color: COLOR_B }}>{nameB}</span>.
        {" "}Rows marked ⚠ flag axes that should have been identical between the two runs;
        when a blocking row drifts, the cost delta below may reflect that confound rather than the variable you intended to test.
      </div>
    </div>
  );
}

function CachePollutionBanner({ pollution, summaryA, summaryB, nameA, nameB }) {
  if (!pollution || !pollution.suspect) return null;
  const fmtPctLocal = (n) => (n * 100).toFixed(0) + "%";
  return (
    <div style={{
      marginTop: 12,
      background: alpha(theme.semantic.warning, 0.10),
      border: "1px solid " + alpha(theme.semantic.warning, 0.40),
      borderLeft: "3px solid " + theme.semantic.warning,
      borderRadius: theme.radius.md,
      padding: "12px 14px",
    }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 6 }}>
        <span style={{ fontSize: theme.fontSize.sm, fontWeight: 700, color: theme.semantic.warning }}>⚠ Cache pollution suspected</span>
        <span style={{ fontSize: theme.fontSize.xs, color: theme.text.muted }}>
          {pollution.side === "both" ? "both runs"
            : pollution.side === "A" ? "run A (" + nameA + ")"
            : "run B (" + nameB + ")"}
        </span>
      </div>
      <div style={{ fontSize: theme.fontSize.xs, color: theme.text.secondary, lineHeight: 1.5, marginBottom: 8 }}>
        {pollution.reason}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, fontSize: theme.fontSize.xs, fontVariantNumeric: "tabular-nums" }}>
        <div>
          <span style={{ color: COLOR_A, fontWeight: 600 }}>A first call:</span>{" "}
          <span style={{ color: theme.text.secondary }}>{fmtPctLocal(summaryA.firstPrimaryCallCacheHit)} cache · {summaryA.firstPrimaryCallInputTokens.toLocaleString()} in tokens</span>
        </div>
        <div>
          <span style={{ color: COLOR_B, fontWeight: 600 }}>B first call:</span>{" "}
          <span style={{ color: theme.text.secondary }}>{fmtPctLocal(summaryB.firstPrimaryCallCacheHit)} cache · {summaryB.firstPrimaryCallInputTokens.toLocaleString()} in tokens</span>
        </div>
      </div>
    </div>
  );
}

function Recommendations({ recs }) {
  if (!recs || recs.length === 0) return null;
  return (
    <div>
      {recs.map((r, i) => (
        <div key={r.id} style={{
          display: "grid", gridTemplateColumns: "28px 1fr", gap: 12,
          padding: "10px 0", borderBottom: i < recs.length - 1 ? "1px solid " + theme.border.subtle : "none",
        }}>
          <div style={{ color: theme.text.dim, fontWeight: 700, fontSize: theme.fontSize.sm, textAlign: "center" }}>{i + 1}</div>
          <div>
            <div style={{ color: theme.text.primary, fontWeight: 600, marginBottom: 2, fontSize: theme.fontSize.sm }}>{r.title}</div>
            <div style={{ color: theme.text.secondary, fontSize: theme.fontSize.xs, lineHeight: 1.5 }}>{r.body}</div>
          </div>
        </div>
      ))}
    </div>
  );
}

function SectionHeader({ title, sub }) {
  return (
    <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", margin: "20px 0 8px" }}>
      <div style={{ fontSize: theme.fontSize.xs, fontWeight: 600, color: theme.text.secondary, textTransform: "uppercase", letterSpacing: "0.05em" }}>{title}</div>
      {sub && <div style={{ fontSize: 10, color: theme.text.muted }}>{sub}</div>}
    </div>
  );
}

function Card({ children }) {
  return (
    <div style={{
      background: theme.bg.raised, border: "1px solid " + theme.border.default,
      borderRadius: theme.radius.md, padding: "14px 16px",
    }}>
      {children}
    </div>
  );
}

function DivergencePanel({ split, projections, nameA, nameB }) {
  const { preCostA, preCostB, preDelta, preDeltaPct, postCostA, postCostB, postDelta, postDeltaPct, preInputTokensA, preInputTokensB, preInputDelta } = split;
  const fmtTok = (n) => (n || 0).toLocaleString();
  function Row({ label, sub, av, bv, delta, deltaPct, valueFmt, deltaIsTokens }) {
    const dColor = delta === 0 ? theme.text.muted
      : delta < 0 ? theme.semantic.success : theme.semantic.error;
    return (
      <div style={{
        display: "grid",
        gridTemplateColumns: "1fr auto auto auto",
        alignItems: "baseline",
        gap: 12,
        padding: "10px 0",
        borderBottom: "1px solid " + theme.border.subtle,
      }}>
        <div>
          <div style={{ fontSize: theme.fontSize.sm, fontWeight: 600, color: theme.text.primary }}>{label}</div>
          <div style={{ fontSize: 10, color: theme.text.muted, marginTop: 2 }}>{sub}</div>
        </div>
        <div style={{ color: COLOR_A, fontVariantNumeric: "tabular-nums", fontSize: theme.fontSize.sm, minWidth: 80, textAlign: "right" }}>
          A · {valueFmt(av)}
        </div>
        <div style={{ color: COLOR_B, fontVariantNumeric: "tabular-nums", fontSize: theme.fontSize.sm, minWidth: 80, textAlign: "right" }}>
          B · {valueFmt(bv)}
        </div>
        <div style={{ color: dColor, fontVariantNumeric: "tabular-nums", fontSize: theme.fontSize.sm, minWidth: 110, textAlign: "right", fontWeight: 600 }}>
          {delta === 0
            ? "Δ 0"
            : (deltaIsTokens
              ? "Δ " + (delta > 0 ? "+" : "") + fmtTok(delta) + " tok"
              : "Δ " + (delta > 0 ? "+" : "") + fmtCr(delta) + (deltaPct == null ? "" : " (" + fmtPctSigned(deltaPct) + ")"))}
        </div>
      </div>
    );
  }
  return (
    <div>
      <div style={{
        fontSize: theme.fontSize.xs,
        color: theme.text.secondary,
        lineHeight: 1.5,
        marginBottom: 10,
      }}>
        The headline cost delta mixes two very different effects. <b>Pre-divergence</b> is the cost of the first user-facing LLM call: at that point the agent has not acted yet, so this number reflects only the prompt prefix (system + tool defs + your message). <b>Post-divergence</b> is everything else, where the agent's behavioral path differs and dominates the total.
      </div>
      <Row
        label="Prefix tax (input tokens, first primary call)"
        sub="path-free; the only number isolating prefix-only variables like MCP tool count"
        av={preInputTokensA} bv={preInputTokensB} delta={preInputDelta} deltaPct={null}
        valueFmt={fmtTok} deltaIsTokens={true}
      />
      <Row
        label="Pre-divergence cost"
        sub="cost of the first primary call only"
        av={preCostA} bv={preCostB} delta={preDelta} deltaPct={preDeltaPct}
        valueFmt={fmtCr} deltaIsTokens={false}
      />
      <Row
        label="Post-divergence cost"
        sub="total cost minus the first primary call (path-dependent)"
        av={postCostA} bv={postCostB} delta={postDelta} deltaPct={postDeltaPct}
        valueFmt={fmtCr} deltaIsTokens={false}
      />
      <div style={{
        fontSize: 10, color: theme.text.muted, marginTop: 10, lineHeight: 1.5,
      }}>
        N=1 caveat: the post-divergence number reflects what the agent happened to do today on this single run. With temp=0 and no API noise it would still flip on small prompt changes. Use the prefix tax row for causal claims; treat post-divergence as descriptive only.
      </div>
      <ProjectionPanel projections={projections} preInputDelta={preInputDelta} nameA={nameA} nameB={nameB} />
    </div>
  );
}

function ProjectionPanel({ projections, preInputDelta, nameA, nameB }) {
  if (!Array.isArray(projections) || projections.length === 0) return null;
  if (!preInputDelta || preInputDelta === 0) return null;
  const labelFor = (ref) => ref === "A" ? (nameA || "Run A") : (nameB || "Run B");
  const totalAbs = Math.abs(preInputDelta);
  const sign = preInputDelta > 0 ? "+" : "−";
  return (
    <div style={{
      marginTop: 16,
      paddingTop: 14,
      borderTop: "1px dashed " + theme.border.subtle,
    }}>
      <div style={{
        fontSize: theme.fontSize.sm,
        fontWeight: 600,
        color: theme.text.primary,
        marginBottom: 4,
      }}>
        Projected over each run's actual call shape
      </div>
      <div style={{
        fontSize: theme.fontSize.xs,
        color: theme.text.secondary,
        lineHeight: 1.5,
        marginBottom: 10,
      }}>
        If every primary LLM call had paid the prefix tax of {sign}{totalAbs.toLocaleString()} input tokens, this is what each run would have cost on top of its actual total. Cache amortization is automatic: cache-warm calls contribute less than cold calls. <b>Lower bound only</b> -- this assumes the agent's path stays identical; real prefix changes can also shift behavior, which this number won't catch.
      </div>
      <div style={{ display: "grid", gap: 0 }}>
        {projections.map((proj) => (
          <ProjectionRow key={proj.templateRef} proj={proj} label={labelFor(proj.templateRef)} />
        ))}
      </div>
    </div>
  );
}

function ProjectionRow({ proj, label }) {
  const { templateRef, callCount, templateTotalCost, projectedExtraCost, projectedExtraPct } = proj;
  const tone = templateRef === "A" ? COLOR_A : COLOR_B;
  const deltaColor = projectedExtraCost === 0 ? theme.text.muted
    : projectedExtraCost < 0 ? theme.semantic.success : theme.semantic.error;
  const sign = projectedExtraCost > 0 ? "+" : "";
  return (
    <div style={{
      display: "grid",
      gridTemplateColumns: "1fr auto auto",
      alignItems: "baseline",
      gap: 12,
      padding: "8px 0",
      borderBottom: "1px solid " + theme.border.subtle,
    }}>
      <div>
        <div style={{ fontSize: theme.fontSize.sm, color: theme.text.primary }}>
          <span style={{ color: tone, fontWeight: 600 }}>{templateRef}</span>
          <span style={{ color: theme.text.muted }}> · {label}</span>
        </div>
        <div style={{ fontSize: 10, color: theme.text.muted, marginTop: 2 }}>
          {callCount.toLocaleString()} primary call{callCount === 1 ? "" : "s"} · template total {fmtCr(templateTotalCost)}
        </div>
      </div>
      <div style={{
        color: deltaColor,
        fontVariantNumeric: "tabular-nums",
        fontSize: theme.fontSize.sm,
        fontWeight: 600,
        minWidth: 100,
        textAlign: "right",
      }}>
        {sign}{fmtCr(projectedExtraCost)}
      </div>
      <div style={{
        color: deltaColor,
        fontVariantNumeric: "tabular-nums",
        fontSize: theme.fontSize.sm,
        minWidth: 70,
        textAlign: "right",
      }}>
        {projectedExtraPct == null ? "--" : fmtPctSigned(projectedExtraPct)}
      </div>
    </div>
  );
}

export default function CostCompare({ sessionA, sessionB, fileA, fileB }) {
  const costA = getCostAnalysis(sessionA);
  const costB = getCostAnalysis(sessionB);
  const cmp = useMemo(() => compareRunsCost(costA, costB), [costA, costB]);

  const nameA = prettifyRunName(fileA);
  const nameB = prettifyRunName(fileB);

  if (!costA || !costB) {
    const missing = [];
    if (!costA) missing.push("A (" + nameA + ")");
    if (!costB) missing.push("B (" + nameB + ")");
    return (
      <div style={{ padding: 24 }}>
        <div style={{
          background: alpha(theme.semantic.warning, 0.08),
          border: "1px solid " + alpha(theme.semantic.warning, 0.30),
          borderLeft: "3px solid " + theme.semantic.warning,
          borderRadius: theme.radius.md,
          padding: "14px 16px",
          color: theme.text.secondary, fontSize: theme.fontSize.sm, lineHeight: 1.6,
        }}>
          <div style={{ color: theme.text.primary, fontWeight: 600, marginBottom: 4 }}>Cost data not available</div>
          The Cost view needs cost analysis from both runs, but {missing.join(" and ")}{" "}
          {missing.length === 1 ? "does not have it" : "do not have it"}.
          Cost analysis is currently only produced for VS Code Copilot Chat exports
          (<code style={{ color: theme.text.primary }}>copilot_all_prompts_*.json</code>).
        </div>
      </div>
    );
  }
  if (!cmp) return null;

  return (
    <div style={{ padding: 16, overflowY: "auto", height: "100%" }}>
      <HeaderStrip
        nameA={nameA} nameB={nameB}
        primaryModelA={cmp.a.primaryModel} primaryModelB={cmp.b.primaryModel}
        costA={cmp.a.totalCost} costB={cmp.b.totalCost}
        summaryA={cmp.a} summaryB={cmp.b}
      />

      <div style={{ marginTop: 16 }}>
        <VerdictBanner verdict={cmp.verdict} />
      </div>

      <CachePollutionBanner
        pollution={cmp.cachePollution}
        summaryA={cmp.a} summaryB={cmp.b}
        nameA={nameA} nameB={nameB}
      />

      <SectionHeader title="Run drift" sub="things that should be identical between A and B" />
      <Card><RunDriftPanel drift={cmp.drift} nameA={nameA} nameB={nameB} /></Card>

      <SectionHeader title="Headline numbers" sub="all metrics, side by side" />
      <KpiGrid kpis={cmp.kpis} equivalent={cmp.answersEquivalent} />

      <SectionHeader title="Pre- vs post-divergence" sub="separates prefix tax from path-dependent behavior" />
      <Card><DivergencePanel split={cmp.divergenceSplit} projections={cmp.prefixTaxProjections} nameA={nameA} nameB={nameB} /></Card>

      <SectionHeader title="Where the savings came from" sub="per-bucket cost delta (B − A)" />
      <Card><BucketWaterfall deltas={cmp.bucketDeltas} totalA={cmp.a.totalCost} totalB={cmp.b.totalCost} /></Card>

      <SectionHeader title="Fixed overhead vs. variable cost" sub="where the budget went" />
      <Card><FixedVsVariable a={cmp.a} b={cmp.b} /></Card>

      <SectionHeader title="Per-call breakdown" sub={cmp.sameShape ? "same call shape on both runs" : "call shapes differ"} />
      <Card><CallTable pairs={cmp.callPairs} /></Card>

      <SectionHeader title="Input vs. output, side by side" sub="visual proof of what changed" />
      <IOSideBySide
        userA={cmp.userTextA} userB={cmp.userTextB}
        ansA={cmp.finalAnswerA} ansB={cmp.finalAnswerB}
        promptsA={cmp.userPromptsA} promptsB={cmp.userPromptsB}
        equivalent={cmp.answersEquivalent}
        nameA={nameA} nameB={nameB}
      />

      <SectionHeader title="Where the tokens went" sub="cost by component, % of total" />
      <Card><ComponentStacks a={cmp.a} b={cmp.b} /></Card>

      {cmp.recommendations.length > 0 && (
        <>
          <SectionHeader title="What this comparison suggests" sub="rule-based, no LLM" />
          <Card><Recommendations recs={cmp.recommendations} /></Card>
        </>
      )}

      <div style={{ marginTop: 24, fontSize: 10, color: theme.text.dim, textAlign: "center" }}>
        Cost compare · all numbers computed deterministically from the parsed cost analysis.
      </div>
    </div>
  );
}
