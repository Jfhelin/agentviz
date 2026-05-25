import { theme } from "../../lib/theme.js";
import CompareView from "../CompareView.jsx";
import ExportStatusButton from "../ui/ExportStatusButton.jsx";
import ToolbarButton from "../ui/ToolbarButton.jsx";
import { V2EmptyState, V2ZoneHeader } from "./V2ShellPrimitives.jsx";

function getEntryTitle(entry) {
  return entry && (entry.primaryPrompt || entry.file || entry.filename || entry.id) || "Selected session";
}

function getCandidateTitle(entry) {
  return entry && (entry.primaryPrompt || entry.file || entry.filename || entry.summary || entry.id) || "Session";
}

function EmptyCompare({ seedEntries, candidateEntries, canCompareCurrent, compareContext, onNavigate, onCompareWithEntry }) {
  var hasSeed = seedEntries && seedEntries.length >= 2;
  var candidates = (candidateEntries || []).filter(function (entry) {
    return entry && (entry.hasContent !== false || entry.discoveredPath || entry.isDiscovered);
  }).slice(0, 4);

  return (
    <V2EmptyState
      title="Select two sessions to compare"
      description={compareContext && compareContext.eventIndex != null
        ? "Selected event context is ready. Choose another session to compare against the current run."
        : "Use Find multi-select, pick a recent session below, or compare from a session context action."}
      actionLabel="Go to Find"
      onAction={function () { if (onNavigate) onNavigate("find"); }}
    >
      {compareContext && compareContext.eventIndex != null && (
        <div style={{
          border: "1px solid " + theme.border.default,
          borderRadius: theme.radius.lg,
          background: theme.bg.base,
          color: theme.text.secondary,
          fontSize: theme.fontSize.sm,
          fontFamily: theme.font.mono,
          padding: theme.space.lg,
          width: "min(640px, 100%)",
        }}>
          Compare request came from event {compareContext.eventIndex + 1}. Pick a comparison session to continue.
        </div>
      )}

      {hasSeed && (
        <div style={{
          display: "grid",
          gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
          gap: theme.space.md,
          width: "min(640px, 100%)",
        }}>
          {seedEntries.slice(0, 2).map(function (entry, index) {
            return (
              <div key={index} style={{
                border: "1px solid " + theme.border.default,
                borderRadius: theme.radius.lg,
                background: theme.bg.base,
                padding: theme.space.lg,
                minWidth: 0,
              }}>
                <div style={{ color: theme.text.dim, fontSize: theme.fontSize.xs, marginBottom: theme.space.sm }}>
                  Session {index === 0 ? "A" : "B"}
                </div>
                <div style={{
                  color: theme.text.primary,
                  fontFamily: theme.font.mono,
                  fontSize: theme.fontSize.sm,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}>
                  {getEntryTitle(entry)}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {!hasSeed && candidates.length > 0 && canCompareCurrent && (
        <div style={{
          width: "min(720px, 100%)",
          display: "grid",
          gap: theme.space.sm,
          textAlign: "left",
        }}>
          <div style={{ color: theme.text.dim, fontSize: theme.fontSize.xs, textTransform: "uppercase", letterSpacing: 1 }}>
            Compare current run with
          </div>
          {candidates.map(function (entry) {
            return (
              <button
                key={entry.id || entry.discoveredPath || entry.file}
                type="button"
                className="av-btn"
                onClick={function () { if (onCompareWithEntry) onCompareWithEntry(entry); }}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: theme.space.lg,
                  border: "1px solid " + theme.border.default,
                  borderRadius: theme.radius.lg,
                  background: theme.bg.base,
                  color: theme.text.secondary,
                  padding: theme.space.lg,
                  cursor: "pointer",
                  fontFamily: theme.font.mono,
                }}
              >
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {getCandidateTitle(entry)}
                </span>
                <span style={{ color: theme.accent.primary, fontSize: theme.fontSize.xs, flexShrink: 0 }}>Compare</span>
              </button>
            );
          })}
        </div>
      )}
      {!hasSeed && candidates.length > 0 && !canCompareCurrent && (
        <div style={{ color: theme.text.muted, fontSize: theme.fontSize.sm, fontFamily: theme.font.mono, maxWidth: 640, lineHeight: 1.6 }}>
          Current session raw content is not available for A/B loading. Use Find multi-select to compare two stored or discovered sessions.
        </div>
      )}
    </V2EmptyState>
  );
}

export default function InlineCompare({
  sessionA,
  sessionB,
  seedEntries,
  candidateEntries,
  canCompareCurrent,
  compareContext,
  compareReady,
  onNavigate,
  onCompareWithEntry,
  onExportComparison,
  exportState,
  exportError,
  onOpenSessionA,
  onOpenSessionB,
}) {
  if (!compareReady) {
    return (
      <EmptyCompare
        seedEntries={seedEntries}
        candidateEntries={candidateEntries}
        canCompareCurrent={canCompareCurrent}
        compareContext={compareContext}
        onNavigate={onNavigate}
        onCompareWithEntry={onCompareWithEntry}
      />
    );
  }

  return (
    <main style={{
      flex: 1,
      minWidth: 0,
      minHeight: 0,
      display: "flex",
      flexDirection: "column",
      background: theme.bg.base,
      overflow: "hidden",
    }}>
      <V2ZoneHeader
        eyebrow="Compare"
        title={<>{sessionA.file} <span style={{ color: theme.text.ghost }}>vs</span> {sessionB.file}</>}
        actions={(
          <>
          {exportError && (
            <span style={{ color: theme.semantic.errorText, fontSize: theme.fontSize.xs, maxWidth: 240, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {exportError}
            </span>
          )}
          <ExportStatusButton
            state={exportState}
            error={exportError}
            onClick={onExportComparison}
            padding="4px 10px"
          />
          <ToolbarButton onClick={function () { if (onNavigate) onNavigate("review"); }}>
            Back to Review
          </ToolbarButton>
          </>
        )}
      />

      <section style={{
        flex: 1,
        minHeight: 0,
        overflow: "hidden",
        padding: theme.space.lg + "px " + theme.space.xl + "px " + theme.space.xl + "px",
      }}>
        <CompareView
          sessionA={sessionA}
          sessionB={sessionB}
          onOpenSessionA={onOpenSessionA}
          onOpenSessionB={onOpenSessionB}
        />
      </section>
    </main>
  );
}
