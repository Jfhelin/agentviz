import { theme } from "../../lib/theme.js";
import ToolbarButton from "../ui/ToolbarButton.jsx";

export function V2EmptyState({ title, description, actionLabel, onAction, children, maxWidth }) {
  return (
    <main style={{
      flex: 1,
      minWidth: 0,
      overflow: "auto",
      padding: theme.space.xxl,
      background: theme.bg.base,
    }}>
      <div style={{
        border: "1px dashed " + theme.border.strong,
        borderRadius: theme.radius.xxl,
        background: theme.bg.surface,
        minHeight: 320,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: theme.space.lg,
        color: theme.text.secondary,
        textAlign: "center",
      }}>
        <h1 style={{ color: theme.text.primary, fontSize: theme.fontSize.xxl, fontWeight: 700, margin: 0 }}>
          {title}
        </h1>
        <div style={{ color: theme.text.muted, fontSize: theme.fontSize.md, maxWidth: maxWidth || 560, lineHeight: 1.7 }}>
          {description}
        </div>
        {children}
        {actionLabel && (
          <ToolbarButton onClick={onAction} style={{ color: theme.accent.primary, borderColor: theme.accent.primary }}>
            {actionLabel}
          </ToolbarButton>
        )}
      </div>
    </main>
  );
}

export function V2ZoneHeader({ eyebrow, title, description, actions }) {
  return (
    <header style={{
      flexShrink: 0,
      borderBottom: "1px solid " + theme.border.default,
      background: theme.bg.surface,
      padding: theme.space.lg + "px " + theme.space.xl + "px",
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      gap: theme.space.lg,
    }}>
      <div style={{ minWidth: 0 }}>
        <div style={{
          color: theme.text.dim,
          fontSize: theme.fontSize.xs,
          textTransform: "uppercase",
          letterSpacing: 1,
          marginBottom: theme.space.sm,
        }}>
          {eyebrow}
        </div>
        <h1 tabIndex={-1} style={{
          color: theme.text.primary,
          fontSize: theme.fontSize.lg,
          fontWeight: 700,
          fontFamily: theme.font.mono,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          margin: 0,
        }}>
          {title}
        </h1>
        {description && (
          <div style={{
            color: theme.text.muted,
            fontSize: theme.fontSize.sm,
            marginTop: theme.space.xs,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}>
            {description}
          </div>
        )}
      </div>

      {actions && (
        <div style={{ display: "flex", gap: theme.space.sm, alignItems: "center", flexShrink: 0, flexWrap: "wrap", justifyContent: "flex-end" }}>
          {actions}
        </div>
      )}
    </header>
  );
}
