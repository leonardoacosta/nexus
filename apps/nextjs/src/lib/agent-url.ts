/**
 * Agent base URL resolver.
 *
 * Single source of truth for `http://<host>:<port>` URLs pointing at the
 * local nexus-agent. Previously the specs page hardcoded port 7402 while
 * the agent listens on 7400 (see `apps/agent/src/server.ts`) and the
 * credentials page read the agent list from the database — the two
 * pages drifted out of sync.
 *
 * This helper consults the same DB-backed agent registry as the
 * credentials page (`getAgentConfigs()` in `./get-client.ts`), picks the
 * first enabled agent, and returns the URL prefix. The resolved config
 * is returned alongside so callers can attach auth headers without a
 * second lookup.
 */

import type { AgentConfig } from "@nexus/core/node";
import { getAgentConfigs } from "./get-client";

/**
 * Result of `getAgentBaseUrl()`.
 *
 * `baseUrl` is always a full `http://host:port` string (no trailing slash).
 * `agent` is the `AgentConfig` the base URL was derived from and is useful
 * for attaching the agent name to error messages.
 */
export interface AgentBaseUrlResolution {
  baseUrl: string;
  agent: AgentConfig;
}

/**
 * Resolve the agent base URL from the DB-backed agent registry.
 *
 * Returns `null` when no enabled agent exists. Callers should degrade
 * gracefully (empty page, "agent unreachable" banner) instead of throwing.
 */
export async function getAgentBaseUrl(): Promise<AgentBaseUrlResolution | null> {
  const configs = await getAgentConfigs();
  const agent = configs[0];
  if (!agent) return null;
  return {
    baseUrl: `http://${agent.host}:${agent.port}`,
    agent,
  };
}
