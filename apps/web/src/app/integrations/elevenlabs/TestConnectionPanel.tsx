"use client";

import type { ElevenlabsTestResult } from "~/lib/elevenlabs-client";
import { theme } from "~/components/theme";

/**
 * Test-connection result panel (task 3.4). Renders the status code from
 * `POST /elevenlabs/credentials/test` plus a quota summary
 * (`${characterCount} / ${characterLimit} chars`) when the probe returned
 * subscription data. `statusCode: null` means the probe threw before any HTTP
 * exchange (network error) and renders as such rather than a bogus "Status: 0".
 */

function statusLabel(result: ElevenlabsTestResult): string {
  if (result.statusCode === null) {
    return "Network error — could not reach api.elevenlabs.io";
  }
  if (result.statusCode === 401) {
    return `Status: 401 — invalid or expired API key`;
  }
  if (result.ok) return `Status: ${result.statusCode} — OK`;
  return `Status: ${result.statusCode} — request rejected`;
}

export function TestConnectionPanel({
  result,
  pending,
}: {
  result: ElevenlabsTestResult | null;
  pending: boolean;
}) {
  if (pending) {
    return (
      <p style={{ ...boxStyle, color: theme.muted }}>Testing connection…</p>
    );
  }
  if (!result) return null;

  const tone = result.ok ? theme.live : theme.closed;
  const sub = result.subscription;

  return (
    <div style={{ ...boxStyle, borderColor: tone }}>
      <p style={{ margin: 0, color: tone, fontSize: 13 }}>{statusLabel(result)}</p>
      {result.ok && sub && (
        <p style={{ margin: "6px 0 0", color: theme.fg, fontSize: 12 }}>
          {sub.characterCount} / {sub.characterLimit} chars
          {sub.tier ? ` · ${sub.tier}` : ""}
        </p>
      )}
    </div>
  );
}

const boxStyle: React.CSSProperties = {
  margin: 0,
  padding: "12px 14px",
  borderRadius: 8,
  border: `1px solid ${theme.border}`,
  background: theme.surface,
  fontFamily: theme.mono,
};
