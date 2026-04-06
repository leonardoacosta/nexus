"use server";

import type { Session } from "@nexus/core";
import { getClient, getAgentHost } from "@/lib/get-client";
import type { WithAgent } from "@/lib/agent-client";

/** Session detail enriched with the agent's host:port for WebSocket connections. */
export interface SessionDetailResult {
  session: WithAgent<Session>;
  agentHost: string; // "host:port" for WS connections
}

/**
 * Fetch a single session by ID.
 * Searches across all agents since the session could be on any machine.
 * Returns the session + the agent host:port needed for terminal WS connections.
 */
export async function fetchSessionDetail(
  sessionId: string,
): Promise<SessionDetailResult | null> {
  const client = await getClient();
  const statuses = client.getAgentStatuses();

  // Fetch from all agents in parallel and return the first non-null result.
  const results = await Promise.all(
    statuses.map(async (status) => {
      const session = await client.fetchSession(status.name, sessionId);
      if (!session) return null;
      const host = await getAgentHost(status.name);
      return { session, agentHost: host ?? "127.0.0.1:7400" };
    }),
  );

  return results.find((r) => r !== null) ?? null;
}
