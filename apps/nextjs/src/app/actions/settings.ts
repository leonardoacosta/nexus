"use server";

import type { AgentConfig } from "@nexus/core";
import { eq } from "@nexus/db";
import type { AgentStatus } from "@/lib/agent-client";
import { getDb } from "@/lib/db";
import { getClient } from "@/lib/get-client";
import { agents as agentsTable } from "@nexus/db";

export interface SettingsResult {
  agentStatuses: AgentStatus[];
}

/**
 * Fetch agent statuses from all configured agents.
 * Used by the settings page to display agent connection status.
 */
export async function fetchAgentStatuses(): Promise<SettingsResult> {
  const client = await getClient();
  // Trigger a lightweight fetch to refresh agent online/offline status
  await client.fetchAllHealth();
  const agentStatuses = client.getAgentStatuses();

  return { agentStatuses };
}

/**
 * Start a new Claude Code session on the given agent.
 */
export async function startSession(
  agentName: string,
  project: string,
  path: string,
): Promise<{ session_name: string; started: boolean }> {
  const client = await getClient();
  return client.startSession(agentName, { project, path });
}

/**
 * Fetch self-reported config from every configured agent.
 * Returns null for agents that are offline or unreachable.
 */
export async function fetchAgentConfigs(): Promise<
  Array<{
    name: string;
    host: string;
    port: number;
    role: string;
    projects_dir: string;
  } | null>
> {
  const client = await getClient();
  const agents = client.getAgentStatuses();
  return Promise.all(agents.map((a) => client.fetchAgentSelf(a.name)));
}

/**
 * Persist an agent entry to the database.
 * Upserts on add; deletes on remove.
 */
export async function saveAgentConfig(
  action: "add" | "remove",
  agent: AgentConfig,
): Promise<void> {
  const db = getDb();

  if (action === "add") {
    await db
      .insert(agentsTable)
      .values({
        id: agent.name,
        name: agent.name,
        host: agent.host,
        port: agent.port,
        enabled: true,
      })
      .onConflictDoUpdate({
        target: agentsTable.id,
        set: {
          name: agent.name,
          host: agent.host,
          port: agent.port,
          enabled: true,
        },
      });
  } else {
    await db.delete(agentsTable).where(eq(agentsTable.id, agent.name));
  }
}

/**
 * Update a named command on the given agent.
 */
export async function saveCommand(
  agentName: string,
  commandName: string,
  content: string,
): Promise<{ updated: boolean; path: string }> {
  const client = await getClient();
  return client.updateCommand(agentName, commandName, content);
}
