import { describe, test, expect, afterEach, vi } from "vitest";
import { AgentClient } from "./agent-client";
import type { AgentConfig, Session, HealthMetrics, Project, DiscoveredProject, DiscoveredProjectsResponse } from "@nexus/core";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const agents: AgentConfig[] = [
  { name: "dev-1", host: "100.64.0.1", port: 7400 },
  { name: "dev-2", host: "100.64.0.2", port: 7400 },
  { name: "offline", host: "100.64.0.99", port: 7400 },
];

function makeSession(id: string, overrides: Partial<Session> = {}): Session {
  return {
    id,
    pid: 1234,
    project: "nx",
    machine: "dev-1",
    cwd: "/home/user/dev/nx",
    branch: "main",
    startedAt: "2026-04-03T10:00:00Z",
    lastHeartbeat: "2026-04-03T10:05:00Z",
    endedAt: null,
    status: "active",
    spec: null,
    command: null,
    agent: null,
    tmuxSession: null,
    ccSessionId: null,
    tmuxTarget: null,
    rateLimitUtilization: null,
    rateLimitType: null,
    totalCostUsd: null,
    model: null,
    sessionType: "ad_hoc",
    ...overrides,
  };
}

function makeHealth(hostname: string): HealthMetrics {
  return {
    hostname,
    uptime_seconds: 86400,
    cpu: { overall_percent: 25, per_core_percent: [25], load_average: [1.0] },
    ram: { total_bytes: 16e9, used_bytes: 8e9, percent: 50 },
    disk: [{ mount: "/", total_bytes: 500e9, used_bytes: 200e9, percent: 40 }],
    docker: null,
  };
}

function makeProject(name: string): Project {
  return { name, active_sessions: 1, total_sessions: 5, machines: ["dev-1"] };
}

// ---------------------------------------------------------------------------
// Mock fetch helper
// ---------------------------------------------------------------------------

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("AgentClient", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // ---- updateCommand: includes x-nexus-secret header -----------------------

  describe("updateCommand", () => {
    test("[3.2] request includes x-nexus-secret header", async () => {
      let capturedHeaders: Record<string, string> | null = null;

      vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
        capturedHeaders = Object.fromEntries(
          new Headers(init?.headers ?? {}).entries(),
        );
        return jsonResponse({ updated: true, path: "/home/user/.claude/commands/test.md" });
      });

      // Set the env var so updateCommand picks it up
      const originalSecret = process.env.NEXUS_ATTACH_SECRET;
      process.env.NEXUS_ATTACH_SECRET = "test-secret";

      try {
        const client = new AgentClient([{ name: "dev-1", host: "100.64.0.1", port: 7400 }]);
        await client.updateCommand("dev-1", "test-cmd", "content here");
      } finally {
        process.env.NEXUS_ATTACH_SECRET = originalSecret;
      }

      expect(capturedHeaders).not.toBeNull();
      expect(capturedHeaders!["x-nexus-secret"]).toBe("test-secret");
    });
  });

  // ---- Online agent: returns sessions/health data -------------------------

  describe("online agent", () => {
    test("fetchAllSessions returns sessions tagged with agent name", async () => {
      const sessions1 = [makeSession("s1"), makeSession("s2")];
      const sessions2 = [makeSession("s3")];

      vi.stubGlobal("fetch", async (input: string | URL | Request) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.includes("100.64.0.1")) return jsonResponse(sessions1);
        if (url.includes("100.64.0.2")) return jsonResponse(sessions2);
        throw new Error("connection refused");
      });

      const client = new AgentClient(agents);
      const result = await client.fetchAllSessions();

      // dev-1 and dev-2 are online; offline agent fails
      expect(result.length).toBe(3);
      expect(result.filter((s) => s.agent === "dev-1").length).toBe(2);
      expect(result.filter((s) => s.agent === "dev-2").length).toBe(1);
      expect(result[0]!.agent).toBe("dev-1");
    });

    test("fetchAllHealth returns health tagged with agent name", async () => {
      const h1 = makeHealth("dev-1");
      const h2 = makeHealth("dev-2");

      vi.stubGlobal("fetch", async (input: string | URL | Request) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.includes("100.64.0.1")) return jsonResponse(h1);
        if (url.includes("100.64.0.2")) return jsonResponse(h2);
        throw new Error("connection refused");
      });

      const client = new AgentClient(agents);
      const result = await client.fetchAllHealth();

      expect(result.length).toBe(2);
      expect(result.find((h) => h.agent === "dev-1")?.hostname).toBe("dev-1");
      expect(result.find((h) => h.agent === "dev-2")?.hostname).toBe("dev-2");
    });

    test("fetchAllProjects returns projects tagged with agent name", async () => {
      const p1 = [makeProject("nx"), makeProject("co")];
      const p2 = [makeProject("nx")];

      vi.stubGlobal("fetch", async (input: string | URL | Request) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.includes("100.64.0.1")) return jsonResponse(p1);
        if (url.includes("100.64.0.2")) return jsonResponse(p2);
        throw new Error("connection refused");
      });

      const client = new AgentClient(agents);
      const result = await client.fetchAllProjects();

      expect(result.length).toBe(3);
      expect(result.filter((p) => p.agent === "dev-1").length).toBe(2);
      expect(result.filter((p) => p.agent === "dev-2").length).toBe(1);
    });

    test("fetchSession returns a single session from the named agent", async () => {
      const session = makeSession("s1");

      vi.stubGlobal("fetch", async () => jsonResponse(session));

      const client = new AgentClient(agents);
      const result = await client.fetchSession("dev-1", "s1");

      expect(result).not.toBeNull();
      expect(result!.id).toBe("s1");
      expect(result!.agent).toBe("dev-1");
    });
  });

  // ---- Offline agent: timeout after 3s, marked offline --------------------

  describe("offline agent", () => {
    test("offline agent is tracked with lastSeen=null", async () => {
      vi.stubGlobal("fetch", async () => {
        throw new Error("connection refused");
      });

      const client = new AgentClient([{ name: "dead", host: "10.0.0.1", port: 7400 }]);
      const result = await client.fetchAllSessions();

      expect(result.length).toBe(0);

      const statuses = client.getAgentStatuses();
      expect(statuses.length).toBe(1);
      expect(statuses[0]!.name).toBe("dead");
      expect(statuses[0]!.online).toBe(false);
      expect(statuses[0]!.lastSeen).toBeNull();
    });

    test("timeout aborts after 3 seconds", async () => {
      vi.stubGlobal(
        "fetch",
        async (_input: string | URL | Request, init?: RequestInit) => {
          return new Promise<Response>((_, reject) => {
            const signal = init?.signal;
            if (signal) {
              signal.addEventListener("abort", () => {
                reject(new DOMException("The operation was aborted.", "AbortError"));
              });
            }
          });
        },
      );

      const client = new AgentClient([{ name: "slow", host: "10.0.0.1", port: 7400 }]);

      const start = Date.now();
      const result = await client.fetchAllSessions();
      const elapsed = Date.now() - start;

      expect(result.length).toBe(0);
      // Should have timed out: 3s first attempt + 1s delay + 3s retry = ~7s
      // But allow some margin; the key check is that it did eventually return
      expect(elapsed).toBeGreaterThan(2_900);

      const statuses = client.getAgentStatuses();
      expect(statuses[0]!.online).toBe(false);
    }, 15_000);
  });

  // ---- Slow agent: first request fails, retry succeeds --------------------

  describe("slow agent (retry)", () => {
    test("first request fails, retry succeeds", async () => {
      let callCount = 0;
      const sessions = [makeSession("retry-s1")];

      vi.stubGlobal("fetch", async () => {
        callCount++;
        if (callCount === 1) throw new Error("ECONNRESET");
        return jsonResponse(sessions);
      });

      const client = new AgentClient([{ name: "flaky", host: "10.0.0.1", port: 7400 }]);
      const result = await client.fetchAllSessions();

      expect(result.length).toBe(1);
      expect(result[0]!.id).toBe("retry-s1");
      expect(result[0]!.agent).toBe("flaky");
      expect(callCount).toBe(2); // initial + 1 retry
    });
  });

  // ---- Mixed: 2 online + 1 offline ----------------------------------------

  describe("mixed agents", () => {
    test("2 online + 1 offline: merged results contain only online data, offline tracked", async () => {
      const sessions1 = [makeSession("m1")];
      const sessions2 = [makeSession("m2"), makeSession("m3")];

      vi.stubGlobal("fetch", async (input: string | URL | Request) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.includes("100.64.0.1")) return jsonResponse(sessions1);
        if (url.includes("100.64.0.2")) return jsonResponse(sessions2);
        // offline agent
        throw new Error("connection refused");
      });

      const client = new AgentClient(agents);
      const result = await client.fetchAllSessions();

      // Only online agents' data
      expect(result.length).toBe(3);
      expect(result.every((s) => s.agent !== "offline")).toBe(true);

      const statuses = client.getAgentStatuses();
      const offlineAgent = statuses.find((s) => s.name === "offline");
      expect(offlineAgent).toBeDefined();
      expect(offlineAgent!.online).toBe(false);

      const onlineAgents = statuses.filter((s) => s.online);
      expect(onlineAgents.length).toBe(2);
    });
  });

  // ---- Cache ---------------------------------------------------------------

  describe("caching", () => {
    test("subsequent calls within TTL return cached data", async () => {
      let callCount = 0;
      const sessions = [makeSession("cached-1")];

      vi.stubGlobal("fetch", async () => {
        callCount++;
        return jsonResponse(sessions);
      });

      const client = new AgentClient([{ name: "dev", host: "10.0.0.1", port: 7400 }]);

      const result1 = await client.fetchAllSessions();
      const result2 = await client.fetchAllSessions();

      expect(result1.length).toBe(1);
      expect(result2.length).toBe(1);
      // fetch should only have been called once due to cache
      expect(callCount).toBe(1);
    });
  });

  // ---- Stale eviction (Spec 1, task 5.3) ----------------------------------

  describe("fetchDiscoveredProjects stale eviction", () => {
    function emptyDiscoveredResponse(): { projects: unknown[]; truncated: boolean } {
      return { projects: [], truncated: false };
    }

    test("project not seen for 61 minutes is evicted and excluded from result", async () => {
      // Agent returns no new projects this poll cycle
      vi.stubGlobal("fetch", async () => jsonResponse(emptyDiscoveredResponse()));

      const client = new AgentClient([{ name: "dev-1", host: "100.64.0.1", port: 7400 }]);

      // Seed internal map with a stale entry (61 minutes old — exceeds 1-hour threshold)
      const staleTs = Date.now() - 61 * 60 * 1_000;
      (client as any).discoveredProjectsMap.set("/home/user/dev/stale", {
        entry: {
          name: "stale-project",
          path: "/home/user/dev/stale",
          active_sessions: 0,
          total_sessions: 0,
          agent: "dev-1",
          machineCount: 1,
        },
        lastSeenAt: staleTs,
      });

      const result = await client.fetchDiscoveredProjects();

      expect(result.find((p) => p.name === "stale-project")).toBeUndefined();
      expect(result.length).toBe(0);
    });

    test("project last seen 59 minutes ago is NOT evicted", async () => {
      // Agent returns no new projects this poll cycle
      vi.stubGlobal("fetch", async () => jsonResponse(emptyDiscoveredResponse()));

      const client = new AgentClient([{ name: "dev-1", host: "100.64.0.1", port: 7400 }]);

      // Seed internal map with a fresh entry (59 minutes old — within the 1-hour window)
      const freshTs = Date.now() - 59 * 60 * 1_000;
      (client as any).discoveredProjectsMap.set("/home/user/dev/fresh", {
        entry: {
          name: "fresh-project",
          path: "/home/user/dev/fresh",
          active_sessions: 1,
          total_sessions: 3,
          agent: "dev-1",
          machineCount: 1,
        },
        lastSeenAt: freshTs,
      });

      const result = await client.fetchDiscoveredProjects();

      const found = result.find((p) => p.name === "fresh-project");
      expect(found).toBeDefined();
      expect(found!.active_sessions).toBe(1);
    });
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
      // Wire format: agents send camelCase activeSessions/totalSessions/gitRemoteUrl
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

      // Git remote dedup: two agents → one entry
      expect(result.length).toBe(1);
      const nx = result.find((p) => p.name === "nx");
      expect(nx).toBeDefined();
      expect(nx!.active_sessions).toBe(3); // 2 + 1
      expect(nx!.total_sessions).toBe(8);  // 5 + 3
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

      // Different remotes → different keys → two entries
      expect(result.length).toBe(2);
    });

    test("two agents reporting same project yields one entry with machineCount === 2", async () => {
      const sharedProject = makeDiscoveredProject("nx", "/home/user/dev/nx");
      const uniqueProject = makeDiscoveredProject("co", "/home/user/dev/co");

      vi.stubGlobal("fetch", async (input: string | URL | Request) => {
        const url = typeof input === "string" ? input : input.toString();
        // Both agents report the shared project; only dev-1 reports the unique one
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

      // Should have 2 unique projects (not 3 raw entries)
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
