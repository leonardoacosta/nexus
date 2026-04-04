"use server";

import type { DiscoveredProject } from "@nexus/core";
import { getClient } from "@/lib/get-client";
import type { WithAgent } from "@/lib/agent-client";

export interface ProjectsResult {
  projects: WithAgent<DiscoveredProject>[];
}

/**
 * Fetch all discovered projects aggregated across all agents.
 * Sorted by active session count descending, then alphabetically.
 */
export async function fetchProjects(): Promise<ProjectsResult> {
  const client = await getClient();
  const projects = await client.fetchDiscoveredProjects();

  const sorted = [...projects].sort((a, b) => {
    if (b.active_sessions !== a.active_sessions) {
      return b.active_sessions - a.active_sessions;
    }
    return a.name.localeCompare(b.name);
  });

  return { projects: sorted };
}
