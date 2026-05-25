import { useState } from "react";
import { theme } from "../../lib/theme.js";
import Icon from "../Icon.jsx";

export var V2_ZONES = [
  { id: "find", label: "Find", sub: "Portfolio", icon: "layout-list" },
  { id: "review", label: "Review", sub: "Session health", icon: "alert-circle" },
  { id: "investigate", label: "Investigate", sub: "Evidence stream", icon: "tracks" },
  { id: "analyze", label: "Analyze", sub: "Deep panels", icon: "graph" },
  { id: "compare", label: "Compare", sub: "A/B sessions", icon: "arrow-up-down" },
  { id: "improve", label: "Improve", sub: "Coach & Q&A", icon: "sparkles" },
];

function isZoneDisabled(zoneId, disabledZones) {
  return Boolean(disabledZones && disabledZones.indexOf(zoneId) !== -1);
}

function getZoneAriaLabel(zone, disabled) {
  var label = zone.label + ", " + zone.sub;
  if (disabled) return label + ", unavailable while a live session is streaming";
  return label;
}

export default function FlowRail({ activeZone, onNavigate, disabledZones, compact }) {
  var [tooltipZone, setTooltipZone] = useState(null);
  var tooltip = compact ? V2_ZONES.find(function (zone) { return zone.id === tooltipZone; }) : null;
  var tooltipDisabled = tooltip ? isZoneDisabled(tooltip.id, disabledZones) : false;

  return (
    <nav
      aria-label="V2 workflow zones"
      style={{
        width: compact ? 68 : 220,
        flexShrink: 0,
        borderRight: "1px solid " + theme.border.default,
        background: theme.bg.surface,
        padding: theme.space.lg,
        display: "flex",
        flexDirection: "column",
        gap: theme.space.xs,
        position: "relative",
      }}
    >
      <div style={{
        fontSize: theme.fontSize.xs,
        color: theme.text.dim,
        textTransform: "uppercase",
        letterSpacing: 1,
        margin: "2px 0 " + theme.space.md + "px",
        textAlign: compact ? "center" : "left",
      }}>
        {compact ? "Flow" : "Workflow"}
      </div>

      {V2_ZONES.map(function (zone) {
        var isActive = activeZone === zone.id;
        var disabled = isZoneDisabled(zone.id, disabledZones);
        return (
          <button
            key={zone.id}
            type="button"
            className="av-btn"
            aria-disabled={disabled}
            aria-current={isActive ? "page" : undefined}
            aria-label={getZoneAriaLabel(zone, disabled)}
            title={getZoneAriaLabel(zone, disabled)}
            onFocus={function () { setTooltipZone(zone.id); }}
            onBlur={function () { setTooltipZone(null); }}
            onMouseEnter={function () { setTooltipZone(zone.id); }}
            onMouseLeave={function () { setTooltipZone(null); }}
            onClick={function () {
              setTooltipZone(null);
              if (!disabled && onNavigate) onNavigate(zone.id);
            }}
            onKeyDown={function (event) {
              if (disabled && (event.key === "Enter" || event.key === " ")) {
                event.preventDefault();
                event.stopPropagation();
              }
            }}
            style={{
              width: "100%",
              border: "1px solid " + (isActive ? theme.border.focus : "transparent"),
              borderRadius: theme.radius.lg,
              background: isActive ? theme.bg.raised : "transparent",
              color: isActive ? theme.text.primary : theme.text.secondary,
              padding: "9px 10px",
              display: "flex",
              alignItems: "center",
              gap: compact ? 0 : theme.space.md,
              justifyContent: compact ? "center" : "flex-start",
              cursor: disabled ? "default" : "pointer",
              opacity: disabled ? 0.6 : 1,
              fontFamily: theme.font.mono,
              textAlign: "left",
            }}
          >
            <span style={{
              width: 26,
              height: 26,
              borderRadius: theme.radius.md,
              border: "1px solid " + (isActive ? theme.accent.primary : theme.border.default),
              background: isActive ? theme.accent.muted : theme.bg.base,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: isActive ? theme.accent.primary : theme.text.dim,
              flexShrink: 0,
            }}>
              <Icon name={zone.icon} size={13} />
            </span>
            {!compact && (
            <span style={{ minWidth: 0, display: "flex", flexDirection: "column", gap: 2 }}>
              <span style={{ fontSize: theme.fontSize.md, fontWeight: isActive ? 700 : 500 }}>
                {zone.label}
              </span>
              <span style={{
                fontSize: theme.fontSize.xs,
                color: isActive ? theme.text.muted : theme.text.dim,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}>
                {zone.sub}
              </span>
            </span>
            )}
          </button>
        );
      })}
      {tooltip && (
        <div style={{
          position: "absolute",
          left: "calc(100% + 8px)",
          top: 46 + (V2_ZONES.findIndex(function (zone) { return zone.id === tooltip.id; }) * 47),
          zIndex: theme.z.tooltip,
          width: 220,
          border: "1px solid " + theme.border.strong,
          borderRadius: theme.radius.lg,
          background: theme.bg.surface,
          boxShadow: theme.shadow.md,
          padding: "8px 10px",
          pointerEvents: "none",
        }}>
          <div style={{ color: theme.text.primary, fontSize: theme.fontSize.sm, fontWeight: 700 }}>
            {tooltip.label}
          </div>
          <div style={{ color: theme.text.muted, fontSize: theme.fontSize.xs, lineHeight: 1.5, marginTop: 2 }}>
            {tooltipDisabled ? "Unavailable while a live session is streaming." : tooltip.sub}
          </div>
        </div>
      )}
    </nav>
  );
}
