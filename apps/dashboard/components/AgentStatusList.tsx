import type { AgentStatus } from "@/lib/agent-client";
import { Card, StatusDot, Badge } from "@/components/ui";
import { formatRelativeTime } from "@/lib/format";

interface AgentStatusListProps {
  agents: AgentStatus[];
}

export function AgentStatusList({ agents }: AgentStatusListProps) {
  if (agents.length === 0) {
    return (
      <Card>
        <p
          style={{
            color: "var(--color-fg-muted)",
            fontSize: "var(--font-size-sm)",
            textAlign: "center",
            padding: "var(--space-4)",
          }}
        >
          No agents configured
        </p>
      </Card>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)" }}>
      {agents.map((agent) => (
        <Card key={agent.name}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: "var(--space-3)",
            }}
          >
            <StatusDot status={agent.online ? "active" : "ended"} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "var(--space-2)",
                }}
              >
                <span
                  style={{
                    fontSize: "var(--font-size-sm)",
                    fontWeight: "var(--font-weight-medium)",
                    color: "var(--color-fg)",
                  }}
                >
                  {agent.name}
                </span>
                <Badge variant={agent.online ? "success" : "default"}>
                  {agent.online ? "Online" : "Offline"}
                </Badge>
              </div>
              <span
                style={{
                  fontSize: "var(--font-size-xs)",
                  color: "var(--color-fg-muted)",
                }}
              >
                {agent.lastSeen
                  ? `Last seen ${formatRelativeTime(agent.lastSeen)}`
                  : "Never connected"}
              </span>
            </div>
          </div>
        </Card>
      ))}
    </div>
  );
}
