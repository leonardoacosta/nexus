"use client";

import { useState, useEffect, useCallback } from "react";
import type { Session } from "@nexus/core";
import type { WithAgent } from "@/lib/agent-client";
import { fetchSessions } from "@/app/actions/sessions";
import { ProjectGroup } from "./ProjectGroup";
import { AgentsOfflineBanner } from "./AgentsOfflineBanner";

interface SessionListPollerProps {
  initialSessions: WithAgent<Session>[];
  initialAgentCount: number;
  /**
   * Optional — agents considered online (fresh heartbeat within 90s).
   * When undefined the banner is not rendered (back-compat for existing tests
   * that construct the component without this field).
   */
  initialOnlineAgentCount?: number;
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
  initialOnlineAgentCount,
}: SessionListPollerProps) {
  const [sessions, setSessions] = useState(initialSessions);
  const [agentCount, setAgentCount] = useState(initialAgentCount);
  const [onlineAgentCount, setOnlineAgentCount] = useState<number | undefined>(
    initialOnlineAgentCount,
  );

  const poll = useCallback(async () => {
    try {
      // Match the SSR fetch in app/page.tsx — only fingerprinted rows.
      // See openspec/changes/fix-agent-cc-session-tracking/specs/session-persistence/spec.md
      const result = await fetchSessions({ withFingerprint: true });
      setSessions(result.sessions);
      setAgentCount(result.agentCount);
      setOnlineAgentCount(result.onlineAgentCount);
    } catch {
      // Keep existing data on fetch failure
    }
  }, []);

  useEffect(() => {
    const interval = setInterval(poll, 5000);
    return () => clearInterval(interval);
  }, [poll]);

  const banner =
    onlineAgentCount !== undefined ? (
      <AgentsOfflineBanner
        agentCount={agentCount}
        onlineAgentCount={onlineAgentCount}
      />
    ) : null;

  if (sessions.length === 0) {
    return (
      <div>
        {banner}
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
          <p
            style={{
              fontSize: "var(--font-size-lg)",
              marginBottom: "var(--space-2)",
            }}
          >
            No active sessions
          </p>
          <p style={{ fontSize: "var(--font-size-sm)" }}>
            No active sessions across {agentCount} machine
            {agentCount !== 1 ? "s" : ""}
          </p>
        </div>
      </div>
    );
  }

  const grouped = groupByProject(sessions);

  return (
    <div>
      {banner}
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
