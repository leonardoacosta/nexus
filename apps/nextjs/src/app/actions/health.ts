"use server";

import type { HealthMetrics } from "@nexus/core";
import { getClient } from "@/lib/get-client";
import type { WithAgent, AgentStatus } from "@/lib/agent-client";

export interface HealthResult {
  metrics: WithAgent<HealthMetrics>[];
  statuses: AgentStatus[];
}

/**
 * Fetch health metrics from all configured agents.
 * Returns per-machine health data plus agent online/offline statuses.
 */
export async function fetchHealth(): Promise<HealthResult> {
  const client = await getClient();
  const metrics = await client.fetchAllHealth();
  const statuses = client.getAgentStatuses();

  return { metrics, statuses };
}
