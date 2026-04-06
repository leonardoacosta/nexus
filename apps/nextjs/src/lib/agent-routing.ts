import type { CanonicalProject } from "@nexus/core";
import type { AgentStatus } from "./agent-client";

/**
 * Resolves which agent to attach a session to for a given canonical project.
 *
 * Priority:
 * 1. Primary agent (isPrimary=true) if its location is 'active' and the agent is online
 * 2. First available location that is 'active' on an online agent
 * 3. Primary agent as last resort (even if offline — caller handles offline state)
 *
 * Returns the agentName to route to, and a boolean indicating if fallback was used.
 */
export function resolveAttachAgent(
  project: CanonicalProject,
  agentStatuses: AgentStatus[],
): { agentName: string; isFallback: boolean } {
  const onlineAgentNames = new Set(
    agentStatuses.filter((a) => a.online).map((a) => a.name),
  );

  // Sort locations by priority (1 = primary first)
  const sorted = [...project.locations].sort((a, b) => a.priority - b.priority);

  // Prefer primary location if active and online
  const primaryLocation = sorted.find((l) => l.isPrimary && l.status === "active");
  if (primaryLocation && onlineAgentNames.has(primaryLocation.agentName)) {
    return { agentName: primaryLocation.agentName, isFallback: false };
  }

  // Fallback: first active location on an online agent
  const fallback = sorted.find(
    (l) => l.status === "active" && onlineAgentNames.has(l.agentName),
  );
  if (fallback) {
    return { agentName: fallback.agentName, isFallback: true };
  }

  // Last resort: primary location's agentName (caller must handle offline gracefully)
  const primaryFallback = sorted.find((l) => l.isPrimary);
  return { agentName: primaryFallback?.agentName ?? project.primaryAgentId, isFallback: true };
}

/**
 * Returns the display name of the primary agent for a project,
 * or null if no primary location found.
 */
export function getPrimaryAgentName(project: CanonicalProject): string | null {
  const primary = project.locations.find((l) => l.isPrimary);
  return primary?.agentName ?? null;
}
