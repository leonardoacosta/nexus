"use server";

import type { AgentStatus } from "@/lib/agent-client";
import { getClient } from "@/lib/get-client";

export interface SettingsResult {
  agentStatuses: AgentStatus[];
}

/**
 * Fetch agent statuses from all configured agents.
 * Used by the settings page to display agent connection status.
 */
export async function fetchAgentStatuses(): Promise<SettingsResult> {
  const client = getClient();
  // Trigger a lightweight fetch to refresh agent online/offline status
  await client.fetchAllHealth();
  const agentStatuses = client.getAgentStatuses();

  return { agentStatuses };
}
