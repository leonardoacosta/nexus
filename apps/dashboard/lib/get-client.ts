import { AgentClient } from "./agent-client";
import type { AgentConfig } from "@nexus/core";

/**
 * Default agent config — uses NEXUS_AGENTS env var or falls back to localhost.
 *
 * NEXUS_AGENTS format: "name:host:port,name:host:port"
 * Example: "dev-server:100.64.0.1:7400,build-box:100.64.0.2:7400"
 */
function getAgentConfigs(): AgentConfig[] {
  const envAgents = process.env.NEXUS_AGENTS;
  if (envAgents) {
    return envAgents.split(",").map((entry) => {
      const [name, host, portStr] = entry.trim().split(":");
      return {
        name: name ?? "agent",
        host: host ?? "127.0.0.1",
        port: parseInt(portStr ?? "7400", 10),
      };
    });
  }

  // Default: single local agent
  return [{ name: "localhost", host: "127.0.0.1", port: 7400 }];
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
 * Resolve an agent name to its host:port string.
 * Used by the terminal panel to build WebSocket URLs.
 */
export function getAgentHost(agentName: string): string | null {
  const agent = getConfigs().find((a) => a.name === agentName);
  if (!agent) return null;
  return `${agent.host}:${agent.port}`;
}
