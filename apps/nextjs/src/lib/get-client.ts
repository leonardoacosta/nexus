import { AgentClient, TtlCache } from "./agent-client";
import type { AgentConfig } from "@nexus/core";
import { getDb } from "./db";
import { agents, eq } from "@nexus/db";

/**
 * Module-level cache that persists across `getClient()` calls within the same
 * process. In serverless, cold starts reset module scope naturally. In the dev
 * server this lets the cache actually work as intended instead of being thrown
 * away on every request.
 */
const sharedCache = new TtlCache();

/**
 * Read enabled agents from the database.
 * Returns localhost:7400 fallback when the table is empty.
 */
export async function getAgentConfigs(): Promise<AgentConfig[]> {
  const db = getDb();
  const rows = await db.select().from(agents).where(eq(agents.enabled, true));

  if (rows.length === 0) {
    return [{ name: "localhost", host: "127.0.0.1", port: 7400 }];
  }

  return rows.map((row) => ({
    name: row.name || row.id, // fallback to id (hostname) if name is empty
    host: row.host,
    port: row.port ?? 7400,
  }));
}

/**
 * Get an AgentClient backed by current DB agent config.
 * Creates a fresh client each call — no stale singleton.
 */
export async function getClient(): Promise<AgentClient> {
  const configs = await getAgentConfigs();
  return new AgentClient(configs, sharedCache);
}

/**
 * Resolve an agent name to its host:port string.
 * Used by the terminal panel to build WebSocket URLs.
 */
export async function getAgentHost(agentName: string): Promise<string | null> {
  const configs = await getAgentConfigs();
  const agent = configs.find((a) => a.name === agentName);
  if (!agent) return null;
  return `${agent.host}:${agent.port}`;
}
