import type { ConnectionStatus } from "~/lib";

import { STATUS_META, theme } from "./theme";

/**
 * Connection-status indicator for the attach chrome. Renders a colored dot +
 * label driven by the transport client's `onStatus` callback
 * (connecting | live | read-only | closed). The `read-only` state doubles as
 * the read-only badge required by task 3.3 — when read-only, input + resize are
 * suppressed and this pill is the user-visible signal.
 */
export function StatusPill({ status }: { status: ConnectionStatus }) {
  const meta = STATUS_META[status];
  const pulsing = status === "connecting" || status === "live";
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 8,
        padding: "4px 10px",
        borderRadius: 999,
        border: `1px solid ${theme.border}`,
        background: theme.surface,
        fontSize: 12,
        lineHeight: 1,
        color: theme.fg,
        fontFamily: theme.mono,
      }}
    >
      <span
        aria-hidden
        style={{
          width: 8,
          height: 8,
          borderRadius: "50%",
          background: meta.color,
          boxShadow: pulsing ? `0 0 6px ${meta.color}` : "none",
        }}
      />
      {meta.label}
    </span>
  );
}
