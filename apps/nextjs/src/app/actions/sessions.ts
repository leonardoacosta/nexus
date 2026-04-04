"use server";

import type { Session } from "@nexus/core";
import { getClient } from "@/lib/get-client";
import type { WithAgent } from "@/lib/agent-client";

export interface SessionsResult {
  sessions: WithAgent<Session>[];
  agentCount: number;
}

/**
 * Fetch all sessions from all configured agents.
 * Returns sessions sorted: active first, then by last heartbeat descending.
 */
export async function fetchSessions(): Promise<SessionsResult> {
  const client = await getClient();
  const sessions = await client.fetchAllSessions();
  const agentCount = client.getAgentStatuses().length;

  // Sort: active first, then by lastHeartbeat descending
  const sorted = [...sessions].sort((a, b) => {
    const statusOrder: Record<string, number> = {
      active: 0,
      idle: 1,
      stale: 2,
      errored: 3,
      ended: 4,
    };
    const aOrder = statusOrder[a.status] ?? 5;
    const bOrder = statusOrder[b.status] ?? 5;

    if (aOrder !== bOrder) return aOrder - bOrder;

    // Same status — sort by last heartbeat, most recent first
    return new Date(b.lastHeartbeat).getTime() - new Date(a.lastHeartbeat).getTime();
  });

  return { sessions: sorted, agentCount };
}
