import type { AgentStatus } from "@/lib/agent-client";
import { Card } from "@/components/ui";
import { formatRelativeTime } from "@/lib/format";

interface OfflineMachineCardProps {
  agent: AgentStatus;
}

export function OfflineMachineCard({ agent }: OfflineMachineCardProps) {
  return (
    <Card
      style={{
        opacity: 0.5,
        filter: "grayscale(0.6)",
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
        }}
      >
        <h3
          style={{
            fontSize: "var(--font-size-base)",
            fontWeight: "var(--font-weight-semibold)",
            color: "var(--color-fg-dim)",
          }}
        >
          {agent.name}
        </h3>
        <span
          style={{
            fontSize: "var(--font-size-xs)",
            color: "var(--color-fg-ghost)",
          }}
        >
          Offline
        </span>
      </div>
      <p
        style={{
          fontSize: "var(--font-size-xs)",
          color: "var(--color-fg-ghost)",
          marginTop: "var(--space-2)",
        }}
      >
        {agent.lastSeen
          ? `Last seen ${formatRelativeTime(agent.lastSeen)}`
          : "Never connected"}
      </p>
    </Card>
  );
}
