/**
 * AgentClient stale eviction tests for fetchDiscoveredProjects.
 */

import { describe, test, expect, afterEach, vi } from "vitest";
import { TestAgentClient } from "./test-agent-client";
import { jsonResponse } from "../agent-client.helpers";

describe("AgentClient", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // ---- Stale eviction (Spec 1, task 5.3) ----------------------------------

  describe("fetchDiscoveredProjects stale eviction", () => {
    function emptyDiscoveredResponse(): { projects: unknown[]; truncated: boolean } {
      return { projects: [], truncated: false };
    }

    test("project not seen for 61 minutes is evicted and excluded from result", async () => {
      vi.stubGlobal("fetch", async () => jsonResponse(emptyDiscoveredResponse()));

      const client = new TestAgentClient([{ name: "dev-1", host: "100.64.0.1", port: 7400 }]);

      const staleTs = Date.now() - 61 * 60 * 1_000;
      client.seedDiscoveredProject(
        "/home/user/dev/stale",
        {
          name: "stale-project",
          path: "/home/user/dev/stale",
          active_sessions: 0,
          total_sessions: 0,
          agent: "dev-1",
          machineCount: 1,
        },
        staleTs,
      );

      const result = await client.fetchDiscoveredProjects();

      expect(result.find((p) => p.name === "stale-project")).toBeUndefined();
      expect(result.length).toBe(0);
    });

    test("project last seen 59 minutes ago is NOT evicted", async () => {
      vi.stubGlobal("fetch", async () => jsonResponse(emptyDiscoveredResponse()));

      const client = new TestAgentClient([{ name: "dev-1", host: "100.64.0.1", port: 7400 }]);

      const freshTs = Date.now() - 59 * 60 * 1_000;
      client.seedDiscoveredProject(
        "/home/user/dev/fresh",
        {
          name: "fresh-project",
          path: "/home/user/dev/fresh",
          active_sessions: 1,
          total_sessions: 3,
          agent: "dev-1",
          machineCount: 1,
        },
        freshTs,
      );

      const result = await client.fetchDiscoveredProjects();

      const found = result.find((p) => p.name === "fresh-project");
      expect(found).toBeDefined();
      expect(found!.active_sessions).toBe(1);
    });
  });
});
