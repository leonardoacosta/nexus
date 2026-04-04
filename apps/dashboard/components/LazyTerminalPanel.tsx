"use client";

import dynamic from "next/dynamic";

const TerminalPanel = dynamic(
  () => import("./TerminalPanel").then((m) => m.TerminalPanel),
  {
    ssr: false,
    loading: () => (
      <div
        style={{
          width: "100%",
          height: "100%",
          background: "var(--color-surface)",
          border: "1px solid var(--color-border)",
          borderRadius: "var(--radius-lg)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          flexDirection: "column",
          gap: "var(--space-2)",
          minHeight: 400,
        }}
      >
        <div
          style={{
            width: 48,
            height: 48,
            borderRadius: "var(--radius-md)",
            background: "var(--color-surface-raised)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: "var(--font-size-xl)",
            color: "var(--color-fg-ghost)",
          }}
        >
          &gt;_
        </div>
        <p
          style={{
            color: "var(--color-fg-muted)",
            fontSize: "var(--font-size-sm)",
          }}
        >
          Loading terminal...
        </p>
      </div>
    ),
  },
);

export interface LazyTerminalPanelProps {
  agentHost: string;
  sessionId: string;
}

export function LazyTerminalPanel({ agentHost, sessionId }: LazyTerminalPanelProps) {
  return <TerminalPanel agentHost={agentHost} sessionId={sessionId} />;
}
