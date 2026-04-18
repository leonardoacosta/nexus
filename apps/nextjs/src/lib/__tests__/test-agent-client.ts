import type { AgentConfig } from "@nexus/core/node";
import type { DiscoveredProject } from "@nexus/core";
import { AgentClient, type WithAgent } from "../agent-client";

/**
 * Test-only subclass of AgentClient that exposes internals for seeding
 * test state without `as any` casts.
 *
 * This subclass mirrors the private `discoveredProjectsMap` field. If the
 * parent class changes its internal shape, update this subclass accordingly.
 */
export class TestAgentClient extends AgentClient {
  constructor(agents: AgentConfig[]) {
    super(agents);
  }

  /**
   * Seed the internal discovered-projects map with an entry.
   * Used by stale-eviction and dedup tests that need pre-populated state.
   */
  seedDiscoveredProject(
    key: string,
    entry: WithAgent<DiscoveredProject> & { machineCount: number },
    lastSeenAt: number,
  ): void {
    // Access the private map via bracket notation (test-only escape hatch)
    const map = (this as unknown as { discoveredProjectsMap: Map<string, unknown> })
      .discoveredProjectsMap;
    map.set(key, { entry, lastSeenAt });
  }
}
