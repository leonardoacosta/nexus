"use client";

import { useState, useEffect, useCallback } from "react";
import type { Session } from "@nexus/core";
import type { WithAgent } from "@/lib/agent-client";
import { fetchSessions } from "@/app/actions/sessions";
import { ProjectGroup } from "./ProjectGroup";

interface SessionListPollerProps {
  initialSessions: WithAgent<Session>[];
  initialAgentCount: number;
}

function groupByProject(
  sessions: WithAgent<Session>[],
): Map<string, WithAgent<Session>[]> {
  const groups = new Map<string, WithAgent<Session>[]>();
  for (const session of sessions) {
    const key = session.project ?? "Unassigned";
    const group = groups.get(key);
    if (group) {
      group.push(session);
    } else {
      groups.set(key, [session]);
    }
  }
  return groups;
}

export function SessionListPoller({
  initialSessions,
  initialAgentCount,
}: SessionListPollerProps) {
  const [sessions, setSessions] = useState(initialSessions);
  const [agentCount, setAgentCount] = useState(initialAgentCount);

  const poll = useCallback(async () => {
    try {
      const result = await fetchSessions();
      setSessions(result.sessions);
      setAgentCount(result.agentCount);
    } catch {
      // Keep existing data on fetch failure
    }
  }, []);

  useEffect(() => {
    const interval = setInterval(poll, 5000);
    return () => clearInterval(interval);
  }, [poll]);

  if (sessions.length === 0) {
    return (
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          padding: "var(--space-16) var(--space-4)",
          color: "var(--color-fg-muted)",
          textAlign: "center",
        }}
      >
        <p style={{ fontSize: "var(--font-size-lg)", marginBottom: "var(--space-2)" }}>
          No active sessions
        </p>
        <p style={{ fontSize: "var(--font-size-sm)" }}>
          No active sessions across {agentCount} machine{agentCount !== 1 ? "s" : ""}
        </p>
      </div>
    );
  }

  const grouped = groupByProject(sessions);

  return (
    <div>
      {Array.from(grouped.entries()).map(([projectName, projectSessions]) => (
        <ProjectGroup
          key={projectName}
          projectName={projectName}
          sessions={projectSessions}
        />
      ))}
    </div>
  );
}
