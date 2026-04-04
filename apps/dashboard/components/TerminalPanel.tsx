"use client";

import { useState, useCallback } from "react";
import { XTerminal } from "./XTerminal";
import { InteractiveToggle } from "./InteractiveToggle";
import type { TerminalMode } from "./XTerminal";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TerminalPanelProps {
  agentHost: string;
  sessionId: string;
}

interface OverlayState {
  visible: boolean;
  message: string;
  type: "offline" | "ended" | null;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function TerminalPanel({ agentHost, sessionId }: TerminalPanelProps) {
  const [mode, setMode] = useState<TerminalMode>("stream");
  const [overlay, setOverlay] = useState<OverlayState>({
    visible: false,
    message: "",
    type: null,
  });

  const handleControlFrame = useCallback((frame: { type: string; [key: string]: unknown }) => {
    if (frame.type === "session_ended") {
      setOverlay({
        visible: true,
        message: "Session ended",
        type: "ended",
      });
    } else if (frame.type === "agent_offline") {
      setOverlay({
        visible: true,
        message: "Machine offline",
        type: "offline",
      });
    }
  }, []);

  const handleModeChange = useCallback((newMode: TerminalMode) => {
    // Clear overlay when switching modes
    setOverlay({ visible: false, message: "", type: null });
    setMode(newMode);
  }, []);

  return (
    <div
      data-testid="terminal-panel"
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        background: "var(--color-surface)",
        border: "1px solid var(--color-border)",
        borderRadius: "var(--radius-lg)",
        overflow: "hidden",
      }}
    >
      {/* Toolbar */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "var(--space-2) var(--space-3)",
          borderBottom: "1px solid var(--color-border)",
          background: "var(--color-surface-raised)",
        }}
      >
        <span
          style={{
            fontSize: "var(--font-size-xs)",
            color: "var(--color-fg-muted)",
            fontFamily: "var(--font-mono)",
          }}
        >
          Terminal
        </span>
        <InteractiveToggle
          mode={mode}
          onModeChange={handleModeChange}
          connected={false}
        />
      </div>

      {/* Terminal */}
      <div style={{ flex: 1, position: "relative", minHeight: 0 }}>
        <XTerminal
          agentHost={agentHost}
          sessionId={sessionId}
          mode={mode}
          onControlFrame={handleControlFrame}
        />

        {/* Overlay for offline/ended states */}
        {overlay.visible && (
          <div
            data-testid="terminal-overlay"
            style={{
              position: "absolute",
              inset: 0,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              flexDirection: "column",
              gap: "var(--space-3)",
              background: "rgba(10, 10, 11, 0.85)",
              backdropFilter: "blur(4px)",
              zIndex: 20,
            }}
          >
            <div
              style={{
                width: 48,
                height: 48,
                borderRadius: "var(--radius-md)",
                background:
                  overlay.type === "ended"
                    ? "var(--color-error-ghost)"
                    : "var(--color-warning-ghost)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: "var(--font-size-xl)",
                color:
                  overlay.type === "ended"
                    ? "var(--color-error)"
                    : "var(--color-warning)",
              }}
            >
              {overlay.type === "ended" ? "✕" : "⚠"}
            </div>
            <p
              style={{
                color: "var(--color-fg)",
                fontSize: "var(--font-size-sm)",
                fontWeight: "var(--font-weight-medium)",
              }}
            >
              {overlay.message}
            </p>
            {overlay.type === "ended" && (
              <button
                onClick={() => setOverlay({ visible: false, message: "", type: null })}
                style={{
                  padding: "var(--space-1) var(--space-3)",
                  fontSize: "var(--font-size-xs)",
                  color: "var(--color-fg-dim)",
                  background: "var(--color-surface-raised)",
                  border: "1px solid var(--color-border)",
                  borderRadius: "var(--radius-md)",
                  cursor: "pointer",
                }}
              >
                Dismiss
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
