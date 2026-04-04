"use server";

import type { Project } from "@nexus/core";
import { getClient } from "@/lib/get-client";
import type { WithAgent } from "@/lib/agent-client";

export interface ProjectsResult {
  projects: WithAgent<Project>[];
}

/**
 * Fetch all projects aggregated across all agents.
 * Sorted by active session count descending.
 */
export async function fetchProjects(): Promise<ProjectsResult> {
  const client = getClient();
  const projects = await client.fetchAllProjects();

  const sorted = [...projects].sort((a, b) => {
    // Most active sessions first
    if (b.active_sessions !== a.active_sessions) {
      return b.active_sessions - a.active_sessions;
    }
    return a.name.localeCompare(b.name);
  });

  return { projects: sorted };
}
