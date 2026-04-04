"use client";

import type { TerminalMode } from "./XTerminal";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface InteractiveToggleProps {
  /** Current mode */
  mode: TerminalMode;
  /** Called when user toggles mode */
  onModeChange: (mode: TerminalMode) => void;
  /** Whether the terminal is currently connected */
  connected: boolean;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function InteractiveToggle({
  mode,
  onModeChange,
  connected: _connected,
}: InteractiveToggleProps) {
  return (
    <div
      data-testid="interactive-toggle"
      style={{
        display: "flex",
        alignItems: "center",
        gap: "var(--space-2)",
      }}
    >
      {/* Mode indicator */}
      <span
        data-testid="mode-indicator"
        style={{
          fontSize: "var(--font-size-xs)",
          color: "var(--color-fg-muted)",
          fontFamily: "var(--font-mono)",
        }}
      >
        {mode === "stream" ? "Streaming (read-only)" : "Interactive"}
      </span>

      {/* Toggle button */}
      <button
        data-testid="mode-toggle-btn"
        onClick={() => onModeChange(mode === "stream" ? "interact" : "stream")}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: "var(--space-1)",
          padding: "var(--space-1) var(--space-3)",
          fontSize: "var(--font-size-xs)",
          fontWeight: "var(--font-weight-medium)",
          fontFamily: "var(--font-sans)",
          color:
            mode === "interact"
              ? "var(--color-primary-fg)"
              : "var(--color-fg-dim)",
          background:
            mode === "interact"
              ? "var(--color-primary)"
              : "var(--color-surface-raised)",
          border: `1px solid ${
            mode === "interact"
              ? "var(--color-primary)"
              : "var(--color-border)"
          }`,
          borderRadius: "var(--radius-md)",
          cursor: "pointer",
          transition: "all var(--transition-fast)",
        }}
      >
        {mode === "stream" ? "Switch to Interactive" : "Switch to Stream"}
      </button>

      {/* Disconnect button — only shown in interactive mode */}
      {mode === "interact" && (
        <button
          data-testid="disconnect-btn"
          onClick={() => onModeChange("stream")}
          style={{
            display: "inline-flex",
            alignItems: "center",
            padding: "var(--space-1) var(--space-3)",
            fontSize: "var(--font-size-xs)",
            fontWeight: "var(--font-weight-medium)",
            fontFamily: "var(--font-sans)",
            color: "var(--color-error)",
            background: "var(--color-error-ghost)",
            border: "1px solid var(--color-error)",
            borderRadius: "var(--radius-md)",
            cursor: "pointer",
            transition: "all var(--transition-fast)",
          }}
        >
          Disconnect
        </button>
      )}
    </div>
  );
}
