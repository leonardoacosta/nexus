import Link from "next/link";
import type { Session } from "@nexus/core";
import type { WithAgent } from "@/lib/agent-client";
import { Badge, StatusDot } from "@nexus/ui";
import { formatDuration, formatRelativeTime } from "@/lib/format";

interface SessionCardProps {
  session: WithAgent<Session>;
}

function getStatusDotStatus(status: string): "active" | "idle" | "ended" {
  if (status === "active") return "active";
  if (status === "idle") return "idle";
  return "ended";
}

export function SessionCard({ session }: SessionCardProps) {
  const duration = formatDuration(
    Date.now() - new Date(session.startedAt).getTime(),
  );
  const lastActivity = formatRelativeTime(session.lastHeartbeat);

  return (
    <Link
      href={`/session/${encodeURIComponent(session.id)}`}
      style={{ textDecoration: "none", color: "inherit", display: "block" }}
    >
      <div
        style={{
          background: "var(--color-surface)",
          border: "1px solid var(--color-border)",
          borderRadius: "var(--radius-lg)",
          padding: "var(--space-4)",
          transition: "border-color var(--transition-fast)",
          cursor: "pointer",
        }}
        onMouseEnter={(e) => {
          (e.currentTarget as HTMLElement).style.borderColor =
            "var(--color-border-bright)";
        }}
        onMouseLeave={(e) => {
          (e.currentTarget as HTMLElement).style.borderColor =
            "var(--color-border)";
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "var(--space-2)",
            marginBottom: "var(--space-2)",
          }}
        >
          <StatusDot status={getStatusDotStatus(session.status)} />
          <span
            style={{
              fontSize: "var(--font-size-sm)",
              fontWeight: "var(--font-weight-medium)",
              color: "var(--color-fg)",
              flex: 1,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {session.project ?? "No project"}
          </span>
          <Badge>{session.agent}</Badge>
        </div>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "var(--space-3)",
            fontSize: "var(--font-size-xs)",
            color: "var(--color-fg-muted)",
          }}
        >
          <span>{session.status}</span>
          <span
            style={{
              fontFamily: "var(--font-mono)",
            }}
          >
            {duration}
          </span>
          <span style={{ marginLeft: "auto" }}>{lastActivity}</span>
        </div>
      </div>
    </Link>
  );
}
