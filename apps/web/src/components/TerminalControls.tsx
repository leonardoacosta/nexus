"use client";

import { theme } from "./theme";

/**
 * Touch-friendly control bar for the phone attach view. Three groups:
 *
 *  - Zoom: fit-width (1:1 reset), zoom out, zoom in. The active state is the
 *    `zoomed` flag — when zoomed, "Fit width" is highlighted as the way back.
 *  - Keyboard: explicit "raise keyboard" affordance for phones where tapping
 *    the dense terminal is fiddly.
 *  - Reflow: the opt-in "Fit to my screen" button that resizes the SHARED pane
 *    once (writable attaches only). Disabled + hinted when read-only.
 *
 * All buttons are >=40px tap targets, no hover-only affordances. This is its own
 * file (one component per file) and takes only callbacks + flags — it never
 * touches the transport or WTerm.
 */
export function TerminalControls({
  zoomed,
  onFitWidth,
  onZoomIn,
  onZoomOut,
  onRaiseKeyboard,
  onReflow,
  reflowDisabled,
  reflowPending,
}: {
  zoomed: boolean;
  onFitWidth: () => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onRaiseKeyboard: () => void;
  onReflow: () => void;
  /** True when read-only (another viewer is driving) — reflow is gated off. */
  reflowDisabled: boolean;
  reflowPending: boolean;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "8px 12px",
        borderTop: `1px solid ${theme.border}`,
        background: theme.surface,
        // Allow wrap on very narrow phones; keep groups grouped.
        flexWrap: "wrap",
        // Respect the iOS home-indicator safe area at the screen bottom.
        paddingBottom: "calc(8px + env(safe-area-inset-bottom, 0px))",
      }}
    >
      <div style={{ display: "flex", gap: 6 }}>
        <ControlButton
          label="Fit width"
          onClick={onFitWidth}
          active={!zoomed}
          title="Reset zoom — fit the whole pane to the screen width"
        />
        <ControlButton label="−" onClick={onZoomOut} title="Zoom out" mono />
        <ControlButton label="+" onClick={onZoomIn} title="Zoom in" mono />
      </div>

      <ControlButton
        label="⌨ Keyboard"
        onClick={onRaiseKeyboard}
        title="Show the on-screen keyboard to type into the terminal"
      />

      <span style={{ flex: 1, minWidth: 8 }} />

      <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end" }}>
        <ControlButton
          label={reflowPending ? "Reflowing…" : "Fit to my screen"}
          onClick={onReflow}
          disabled={reflowDisabled || reflowPending}
          primary
          title={
            reflowDisabled
              ? "Read-only — another viewer is driving the pane"
              : "Resize the shared pane to your phone width (transient — snaps back when a wider client attaches)"
          }
        />
        {reflowDisabled && (
          <span
            style={{
              fontSize: 10,
              color: theme.muted,
              fontFamily: theme.mono,
              marginTop: 2,
            }}
          >
            read-only — can't reflow
          </span>
        )}
      </div>
    </div>
  );
}

function ControlButton({
  label,
  onClick,
  title,
  active,
  primary,
  disabled,
  mono,
}: {
  label: string;
  onClick: () => void;
  title?: string;
  active?: boolean;
  primary?: boolean;
  disabled?: boolean;
  mono?: boolean;
}) {
  const bg = disabled
    ? theme.border
    : primary
      ? theme.accent
      : active
        ? theme.border
        : theme.bg;
  const fg = disabled
    ? theme.muted
    : primary
      ? theme.bg
      : active
        ? theme.fg
        : theme.muted;
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      style={{
        minHeight: 40,
        minWidth: mono ? 40 : 44,
        padding: "0 12px",
        borderRadius: 8,
        border: `1px solid ${active ? theme.accent : theme.border}`,
        background: bg,
        color: fg,
        fontFamily: theme.mono,
        fontSize: mono ? 18 : 13,
        fontWeight: primary ? 600 : 500,
        cursor: disabled ? "not-allowed" : "pointer",
        // Prevent the browser's tap-to-zoom / double-tap from hijacking the
        // button on touch, and remove the grey tap flash.
        touchAction: "manipulation",
        WebkitTapHighlightColor: "transparent",
        lineHeight: 1,
        whiteSpace: "nowrap",
      }}
    >
      {label}
    </button>
  );
}
