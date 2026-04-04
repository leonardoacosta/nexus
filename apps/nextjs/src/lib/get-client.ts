import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { AgentClient } from "./agent-client";
import type { AgentConfig } from "@nexus/core";

/**
 * Read agents from ~/.config/nexus/dashboard.json if it exists.
 * Returns an empty array if the file is missing or malformed.
 */
function getDashboardAgents(): AgentConfig[] {
  try {
    const dashboardPath = join(homedir(), ".config", "nexus", "dashboard.json");
    const raw = readFileSync(dashboardPath, "utf-8");
    const parsed = JSON.parse(raw) as { agents?: AgentConfig[] };
    return parsed.agents ?? [];
  } catch {
    return [];
  }
}

/**
 * Build merged agent config list.
 *
 * Priority (highest wins on name collision): NEXUS_AGENTS env > dashboard.json
 *
 * NEXUS_AGENTS format: "name:host:port,name:host:port"
 * Example: "dev-server:100.64.0.1:7400,build-box:100.64.0.2:7400"
 */
function getAgentConfigs(): AgentConfig[] {
  const dashboardAgents = getDashboardAgents();
  const envAgents = process.env.NEXUS_AGENTS
    ? process.env.NEXUS_AGENTS.split(",").map((entry) => {
        const [name, host, portStr] = entry.trim().split(":");
        return {
          name: name ?? "agent",
          host: host ?? "127.0.0.1",
          port: parseInt(portStr ?? "7400", 10),
        };
      })
    : [];

  // Merge: env takes precedence on name collision
  const merged = new Map<string, AgentConfig>();
  for (const a of dashboardAgents) merged.set(a.name, a);
  for (const a of envAgents) merged.set(a.name, a);

  if (merged.size === 0) {
    return [{ name: "localhost", host: "127.0.0.1", port: 7400 }];
  }
  return Array.from(merged.values());
}

let _client: AgentClient | null = null;
let _configs: AgentConfig[] | null = null;

function getConfigs(): AgentConfig[] {
  if (!_configs) {
    _configs = getAgentConfigs();
  }
  return _configs;
}

/**
 * Get the singleton AgentClient instance.
 * Safe to call from server actions and server components.
 */
export function getClient(): AgentClient {
  if (!_client) {
    _client = new AgentClient(getConfigs());
  }
  return _client;
}

/**
 * Reset the singleton so the next getClient() call picks up updated agent
 * configs (e.g. after dashboard.json changes via saveAgentConfig).
 */
export function resetClient(): void {
  _client = null;
  _configs = null;
}

/**
 * Resolve an agent name to its host:port string.
 * Used by the terminal panel to build WebSocket URLs.
 */
export function getAgentHost(agentName: string): string | null {
  const agent = getConfigs().find((a) => a.name === agentName);
  if (!agent) return null;
  return `${agent.host}:${agent.port}`;
}
