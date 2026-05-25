import { theme, alpha } from "../../lib/theme.js";
import Icon from "../Icon.jsx";
import ToolbarButton from "../ui/ToolbarButton.jsx";

export function buildLiveSessionStats(session) {
  var events = session && session.events ? session.events : [];
  var turns = session && session.turns ? session.turns : [];
  var metadata = session && session.metadata ? session.metadata : {};
  var errorCount = metadata.errorCount != null
    ? metadata.errorCount
    : events.filter(function (event) { return event.isError; }).length;

  return {
    events: metadata.totalEvents || events.length,
    turns: metadata.totalTurns || turns.length,
    errors: errorCount,
    elapsed: session && session.total ? session.total : metadata.duration || 0,
  };
}

function LivePulse() {
  return (
    <span style={{
      display: "inline-flex",
      width: 8,
      height: 8,
      borderRadius: theme.radius.full,
      background: theme.semantic.success,
      boxShadow: "none",
      flexShrink: 0,
    }}
    aria-label="Live session active indicator"
    />
  );
}

export default function LiveSessionBanner({ session, completed, onReview, onCompare, onImprove, onDismiss }) {
  var stats = buildLiveSessionStats(session);
  var tone = completed ? theme.accent.primary : theme.semantic.success;
  var stateText = completed
    ? "Evidence is stable. Compare and Improve are ready."
    : "Compare and Improve stay locked while events are still arriving.";

  return (
    <section
      role={completed ? "status" : undefined}
      aria-live={completed ? "polite" : "off"}
      aria-label="Live session status"
      style={{
      flexShrink: 0,
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      gap: theme.space.lg,
      padding: "8px " + theme.space.xl + "px",
      borderBottom: "1px solid " + alpha(tone, 0.35),
      background: alpha(tone, 0.08),
      color: theme.text.secondary,
      fontFamily: theme.font.mono,
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: theme.space.md, minWidth: 0 }}>
        {completed ? (
          <Icon name="sparkles" size={14} style={{ color: tone, flexShrink: 0 }} />
        ) : (
          <LivePulse />
        )}
        <div style={{ minWidth: 0 }}>
          <div style={{ color: tone, fontSize: theme.fontSize.sm, fontWeight: 700 }}>
            {completed ? "Session complete" : "Live session streaming"}
          </div>
          <div style={{
            color: theme.text.muted,
            fontSize: theme.fontSize.xs,
            marginTop: 2,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}>
            {stats.events} events · {stats.turns} turns · {stats.errors} errors · {stats.elapsed.toFixed(1)}s · {stateText}
          </div>
        </div>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: theme.space.sm, flexShrink: 0 }}>
        {completed ? (
          <>
            <ToolbarButton onClick={onReview} style={{ color: theme.accent.primary, borderColor: theme.accent.primary }}>
              Review summary
            </ToolbarButton>
            <ToolbarButton onClick={onCompare}>
              Compare
            </ToolbarButton>
            <ToolbarButton onClick={onImprove}>
              Improve
            </ToolbarButton>
            <ToolbarButton onClick={onDismiss} aria-label="Dismiss live completion banner">
              Dismiss
            </ToolbarButton>
          </>
        ) : (
          <ToolbarButton onClick={onReview} style={{ color: theme.semantic.success, borderColor: theme.semantic.success }}>
            Go to Review
          </ToolbarButton>
        )}
      </div>
    </section>
  );
}
