"use server";

import type { Session } from "@nexus/core";
import { getClient } from "@/lib/get-client";
import type { WithAgent } from "@/lib/agent-client";

/**
 * Fetch a single session by ID.
 * Searches across all agents since the session could be on any machine.
 */
export async function fetchSessionDetail(
  sessionId: string,
): Promise<WithAgent<Session> | null> {
  const client = getClient();
  const statuses = client.getAgentStatuses();

  // Try each agent until we find the session
  for (const status of statuses) {
    const session = await client.fetchSession(status.name, sessionId);
    if (session) return session;
  }

  return null;
}
