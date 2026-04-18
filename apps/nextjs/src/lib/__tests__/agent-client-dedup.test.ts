/**
 * AgentClient deduplication tests for fetchDiscoveredProjects.
 */

import { describe, test, expect, afterEach, vi } from "vitest";
import { AgentClient } from "../agent-client";
import type { AgentConfig } from "@nexus/core/node";
import type { DiscoveredProject, DiscoveredProjectsResponse } from "@nexus/core";
import { jsonResponse } from "../agent-client.helpers";

describe("AgentClient", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // ---- Deduplication (Spec 1, task 3.3) -----------------------------------

  describe("fetchDiscoveredProjects deduplication", () => {
    function makeDiscoveredProject(name: string, projectPath: string): DiscoveredProject {
      return {
        name,
        path: projectPath,
        active_sessions: 0,
        total_sessions: 0,
        agent: "",
      };
    }

    function makeDiscoveredResponse(projects: DiscoveredProject[]): DiscoveredProjectsResponse {
      return { projects, truncated: false };
    }

    // ── Task 4.4 — cross-machine dedup via git remote ──────────────────────

    test("same project on two agents with same gitRemoteUrl → single entry, counts accumulated", async () => {
      const homelabProject = {
        name: "nx",
        path: "/home/leo/dev/nx",
        gitRemoteUrl: "git@github.com:user/nx.git",
        activeSessions: 2,
        totalSessions: 5,
      };
      const macProject = {
        name: "nx",
        path: "/Users/leo/dev/nx",
        gitRemoteUrl: "git@github.com:user/nx.git",
        activeSessions: 1,
        totalSessions: 3,
      };

      vi.stubGlobal("fetch", async (input: string | URL | Request) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.includes("100.64.0.1")) return jsonResponse({ projects: [homelabProject], truncated: false });
        if (url.includes("100.64.0.2")) return jsonResponse({ projects: [macProject], truncated: false });
        throw new Error("connection refused");
      });

      const twoAgents: AgentConfig[] = [
        { name: "homelab", host: "100.64.0.1", port: 7400 },
        { name: "mac", host: "100.64.0.2", port: 7400 },
      ];
      const client = new AgentClient(twoAgents);
      const result = await client.fetchDiscoveredProjects();

      expect(result.length).toBe(1);
      const nx = result.find((p) => p.name === "nx");
      expect(nx).toBeDefined();
      expect(nx!.active_sessions).toBe(3);
      expect(nx!.total_sessions).toBe(8);
      expect(nx!.machineCount).toBe(2);
    });

    test("same project with different gitRemoteUrls → two separate entries", async () => {
      const project1 = {
        name: "fork",
        path: "/home/leo/dev/fork",
        gitRemoteUrl: "git@github.com:user/fork.git",
        activeSessions: 1,
        totalSessions: 2,
      };
      const project2 = {
        name: "fork",
        path: "/home/other/dev/fork",
        gitRemoteUrl: "git@github.com:other/fork.git",
        activeSessions: 0,
        totalSessions: 1,
      };

      vi.stubGlobal("fetch", async (input: string | URL | Request) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.includes("100.64.0.1")) return jsonResponse({ projects: [project1], truncated: false });
        if (url.includes("100.64.0.2")) return jsonResponse({ projects: [project2], truncated: false });
        throw new Error("connection refused");
      });

      const twoAgents: AgentConfig[] = [
        { name: "dev-1", host: "100.64.0.1", port: 7400 },
        { name: "dev-2", host: "100.64.0.2", port: 7400 },
      ];
      const client = new AgentClient(twoAgents);
      const result = await client.fetchDiscoveredProjects();

      expect(result.length).toBe(2);
    });

    test("two agents reporting same project yields one entry with machineCount === 2", async () => {
      const sharedProject = makeDiscoveredProject("nx", "/home/user/dev/nx");
      const uniqueProject = makeDiscoveredProject("co", "/home/user/dev/co");

      vi.stubGlobal("fetch", async (input: string | URL | Request) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.includes("100.64.0.1")) {
          return jsonResponse(makeDiscoveredResponse([sharedProject, uniqueProject]));
        }
        if (url.includes("100.64.0.2")) {
          return jsonResponse(makeDiscoveredResponse([sharedProject]));
        }
        throw new Error("connection refused");
      });

      const twoAgents: AgentConfig[] = [
        { name: "dev-1", host: "100.64.0.1", port: 7400 },
        { name: "dev-2", host: "100.64.0.2", port: 7400 },
      ];
      const client = new AgentClient(twoAgents);
      const result = await client.fetchDiscoveredProjects();

      expect(result.length).toBe(2);

      const nx = result.find((p) => p.name === "nx");
      expect(nx).toBeDefined();
      expect(nx!.machineCount).toBe(2);

      const co = result.find((p) => p.name === "co");
      expect(co).toBeDefined();
      expect(co!.machineCount).toBe(1);
    });

    test("unique projects from separate agents each get machineCount === 1", async () => {
      const project1 = makeDiscoveredProject("alpha", "/home/user/dev/alpha");
      const project2 = makeDiscoveredProject("beta", "/home/user/dev/beta");

      vi.stubGlobal("fetch", async (input: string | URL | Request) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.includes("100.64.0.1")) {
          return jsonResponse(makeDiscoveredResponse([project1]));
        }
        if (url.includes("100.64.0.2")) {
          return jsonResponse(makeDiscoveredResponse([project2]));
        }
        throw new Error("connection refused");
      });

      const twoAgents: AgentConfig[] = [
        { name: "dev-1", host: "100.64.0.1", port: 7400 },
        { name: "dev-2", host: "100.64.0.2", port: 7400 },
      ];
      const client = new AgentClient(twoAgents);
      const result = await client.fetchDiscoveredProjects();

      expect(result.length).toBe(2);
      expect(result.every((p) => p.machineCount === 1)).toBe(true);
    });
  });
});
