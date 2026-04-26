"use client";

import { useState } from "react";
import type { ElevenlabsTestResponse } from "@nexus/core";

/**
 * Test-connection probe panel for the ElevenLabs integration page.
 *
 * Renders a single button. On click, calls `onTest()` (which proxies to
 * `POST /elevenlabs/credentials/test` on the agent), stores the result in
 * local state, and renders a status line whose text and color are driven by
 * the (ok, statusCode) pair as documented in the spec's "Save + test happy
 * path" / "401 surfaces clearly" scenarios.
 *
 * The component owns no decisions about what counts as success — the agent
 * proxies the upstream status code through and we render it verbatim.
 */
export interface TestConnectionPanelProps {
  onTest: () => Promise<ElevenlabsTestResponse>;
  disabled?: boolean;
}

interface PanelError {
  kind: "error";
  message: string;
}

type PanelState =
  | { kind: "idle" }
  | { kind: "testing" }
  | { kind: "result"; result: ElevenlabsTestResponse }
  | PanelError;

function statusColor(state: PanelState): string {
  if (state.kind === "result") {
    return state.result.ok ? "var(--color-success)" : "var(--color-error)";
  }
  if (state.kind === "error") return "var(--color-error)";
  return "var(--color-fg-muted)";
}

function statusText(state: PanelState): string | null {
  if (state.kind === "idle" || state.kind === "testing") return null;
  if (state.kind === "error") return state.message;

  const { ok, statusCode, subscription } = state.result;
  if (ok) {
    if (subscription) {
      return `Status: ✓ ${statusCode} — ${subscription.tier} tier · ${subscription.characterCount}/${subscription.characterLimit} chars used`;
    }
    return `Status: ✓ ${statusCode} — connection ok`;
  }

  // Error branches — drive copy off the upstream status code.
  if (statusCode === 401) {
    return `Status: ✗ 401 — invalid or expired API key`;
  }
  if (statusCode === 429) {
    const reset = subscription?.nextResetUnix;
    return reset
      ? `Status: ✗ 429 — quota exhausted, retry after ${reset}`
      : `Status: ✗ 429 — quota exhausted`;
  }
  return `Status: ✗ ${statusCode}`;
}

export function TestConnectionPanel({
  onTest,
  disabled,
}: TestConnectionPanelProps) {
  const [state, setState] = useState<PanelState>({ kind: "idle" });

  const handleClick = async () => {
    setState({ kind: "testing" });
    try {
      const result = await onTest();
      setState({ kind: "result", result });
    } catch (err) {
      setState({
        kind: "error",
        message: `Test failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  };

  const isTesting = state.kind === "testing";
  const buttonDisabled = isTesting || disabled === true;
  const message = statusText(state);

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: "var(--space-3)",
        flexWrap: "wrap",
      }}
    >
      <button
        type="button"
        data-testid="elevenlabs-test-connection"
        onClick={handleClick}
        disabled={buttonDisabled}
        style={{
          padding: "var(--space-2) var(--space-4)",
          fontSize: "var(--font-size-sm)",
          fontWeight: "var(--font-weight-medium)",
          color: "var(--color-fg-dim)",
          background: "var(--color-surface-raised)",
          border: "1px solid var(--color-border)",
          borderRadius: "var(--radius-md)",
          cursor: buttonDisabled ? "not-allowed" : "pointer",
          opacity: buttonDisabled ? 0.6 : 1,
        }}
      >
        {isTesting ? "Testing…" : "Test connection"}
      </button>
      {message ? (
        <span
          data-testid="elevenlabs-test-status"
          style={{
            fontSize: "var(--font-size-sm)",
            color: statusColor(state),
            fontFamily: "var(--font-mono)",
          }}
        >
          {message}
        </span>
      ) : null}
    </div>
  );
}
