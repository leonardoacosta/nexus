"use server";

import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentConfig } from "@nexus/core";
import type { AgentStatus } from "@/lib/agent-client";
import { getClient, resetClient } from "@/lib/get-client";

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

/**
 * Start a new Claude Code session on the given agent.
 */
export async function startSession(
  agentName: string,
  project: string,
  path: string,
): Promise<{ session_name: string; started: boolean }> {
  const client = getClient();
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
  const client = getClient();
  const agents = client.getAgentStatuses();
  return Promise.all(agents.map((a) => client.fetchAgentSelf(a.name)));
}

/**
 * Persist an agent entry to ~/.config/nexus/dashboard.json.
 * Resets the AgentClient singleton so the new config is picked up immediately.
 */
export async function saveAgentConfig(
  action: "add" | "remove",
  agent: AgentConfig,
): Promise<void> {
  const configDir = join(homedir(), ".config", "nexus");
  const dashboardPath = join(configDir, "dashboard.json");

  let existing: { agents: AgentConfig[] } = { agents: [] };
  try {
    const raw = readFileSync(dashboardPath, "utf-8");
    existing = JSON.parse(raw) as { agents: AgentConfig[] };
  } catch {
    // File doesn't exist yet — start fresh
  }

  if (action === "add") {
    // Replace if same name, otherwise append
    const idx = existing.agents.findIndex((a) => a.name === agent.name);
    if (idx >= 0) {
      existing.agents[idx] = agent;
    } else {
      existing.agents.push(agent);
    }
  } else {
    existing.agents = existing.agents.filter((a) => a.name !== agent.name);
  }

  mkdirSync(configDir, { recursive: true });
  writeFileSync(dashboardPath, JSON.stringify(existing, null, 2), "utf-8");

  // Reset singleton so next getClient() picks up new agents
  resetClient();
}

/**
 * Update a named command on the given agent.
 */
export async function saveCommand(
  agentName: string,
  commandName: string,
  content: string,
): Promise<{ updated: boolean; path: string }> {
  const client = getClient();
  return client.updateCommand(agentName, commandName, content);
}
