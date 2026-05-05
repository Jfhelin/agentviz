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

function HeaderStrip({ nameA, nameB, primaryModelA, primaryModelB, costA, costB }) {
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
    <div style={{ display: "grid", gridTemplateColumns: "repeat(6, 1fr)", gap: 8 }}>
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
                <td style={{ padding: "8px 10px", textAlign: "right", color: COLOR_A, fontVariantNumeric: "tabular-nums" }}>{p.a ? p.a.promptTokens.toLocaleString() : "--"}</td>
                <td style={{ padding: "8px 10px", textAlign: "right", color: COLOR_B, fontVariantNumeric: "tabular-nums" }}>{p.b ? p.b.promptTokens.toLocaleString() : "--"}</td>
                <td style={{ padding: "8px 10px", textAlign: "right", color: COLOR_A, fontVariantNumeric: "tabular-nums" }}>{p.a ? p.a.output.toLocaleString() : "--"}</td>
                <td style={{ padding: "8px 10px", textAlign: "right", color: COLOR_B, fontVariantNumeric: "tabular-nums" }}>{p.b ? p.b.output.toLocaleString() : "--"}</td>
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
      />

      <div style={{ marginTop: 16 }}>
        <VerdictBanner verdict={cmp.verdict} />
      </div>

      <SectionHeader title="Headline numbers" sub="all metrics, side by side" />
      <KpiGrid kpis={cmp.kpis} equivalent={cmp.answersEquivalent} />

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
