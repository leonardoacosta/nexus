"use server";

import { revalidatePath } from "next/cache";
import type { AgentConfig } from "@nexus/core/node";
import { agents as agentsTable, healthSnapshots, sql, eq } from "@nexus/db";
import type { AgentStatus } from "@/lib/agent-client";
import { getReadOnlyDb } from "@/lib/db";
import { getClient } from "@/lib/get-client";

export interface SettingsResult {
  agentStatuses: AgentStatus[];
}

/** Threshold (ms) — agents with a snapshot newer than this are considered online. */
const ONLINE_THRESHOLD_MS = 90_000; // 3x the 30s health-scheduler interval

/**
 * Derive agent statuses from the database.
 * Uses the latest health snapshot timestamp per agent to determine online/offline.
 */
export async function fetchAgentStatuses(): Promise<SettingsResult> {
  const db = getReadOnlyDb();

  const agentRows = await db
    .select({
      id: agentsTable.id,
      name: agentsTable.name,
      lastSeen: agentsTable.lastSeen,
    })
    .from(agentsTable)
    .where(eq(agentsTable.enabled, true));

  // Get the latest snapshot timestamp per agent in a single query
  const latestSnapshots = await db
    .select({
      agentId: healthSnapshots.agentId,
      latestTs: sql<Date>`max(${healthSnapshots.timestamp})`.as("latest_ts"),
    })
    .from(healthSnapshots)
    .groupBy(healthSnapshots.agentId);

  const snapshotMap = new Map(latestSnapshots.map((s) => [s.agentId, s.latestTs]));
  const now = Date.now();

  const agentStatuses: AgentStatus[] = agentRows.map((agent) => {
    const snapshotTs = snapshotMap.get(agent.id);
    const lastSeen = snapshotTs ?? agent.lastSeen ?? null;
    const online = lastSeen != null && now - new Date(lastSeen).getTime() < ONLINE_THRESHOLD_MS;

    return {
      name: agent.name || agent.id,
      online,
      lastSeen: lastSeen ? new Date(lastSeen) : null,
    };
  });

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
 * Persist an agent entry via the agent HTTP API.
 * Upserts on add (POST /agents); deletes on remove (DELETE /agents/:id).
 *
 * Delegates to the agent so that apps/nextjs never writes directly to the DB.
 */
export async function saveAgentConfig(
  action: "add" | "remove",
  agent: AgentConfig,
): Promise<void> {
  const client = await getClient();

  if (action === "add") {
    await client.saveAgent({ name: agent.name, host: agent.host, port: agent.port ?? 7400 });
    revalidatePath("/settings");
  } else {
    await client.deleteAgent(agent.name);
    revalidatePath("/settings");
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
