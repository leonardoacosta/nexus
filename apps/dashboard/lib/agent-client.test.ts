import { describe, test, expect, mock, beforeEach } from "bun:test";
import { AgentClient } from "./agent-client";
import type { AgentConfig, Session, HealthMetrics, Project } from "@nexus/core";

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

type FetchFn = typeof globalThis.fetch;

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
  let originalFetch: FetchFn;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  function restoreFetch() {
    globalThis.fetch = originalFetch;
  }

  // ---- Online agent: returns sessions/health data -------------------------

  describe("online agent", () => {
    test("fetchAllSessions returns sessions tagged with agent name", async () => {
      const sessions1 = [makeSession("s1"), makeSession("s2")];
      const sessions2 = [makeSession("s3")];

      globalThis.fetch = mock(async (input: string | URL | Request) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.includes("100.64.0.1")) return jsonResponse(sessions1);
        if (url.includes("100.64.0.2")) return jsonResponse(sessions2);
        throw new Error("connection refused");
      }) as FetchFn;

      const client = new AgentClient(agents);
      const result = await client.fetchAllSessions();

      // dev-1 and dev-2 are online; offline agent fails
      expect(result.length).toBe(3);
      expect(result.filter((s) => s.agent === "dev-1").length).toBe(2);
      expect(result.filter((s) => s.agent === "dev-2").length).toBe(1);
      expect(result[0]!.agent).toBe("dev-1");

      restoreFetch();
    });

    test("fetchAllHealth returns health tagged with agent name", async () => {
      const h1 = makeHealth("dev-1");
      const h2 = makeHealth("dev-2");

      globalThis.fetch = mock(async (input: string | URL | Request) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.includes("100.64.0.1")) return jsonResponse(h1);
        if (url.includes("100.64.0.2")) return jsonResponse(h2);
        throw new Error("connection refused");
      }) as FetchFn;

      const client = new AgentClient(agents);
      const result = await client.fetchAllHealth();

      expect(result.length).toBe(2);
      expect(result.find((h) => h.agent === "dev-1")?.hostname).toBe("dev-1");
      expect(result.find((h) => h.agent === "dev-2")?.hostname).toBe("dev-2");

      restoreFetch();
    });

    test("fetchAllProjects returns projects tagged with agent name", async () => {
      const p1 = [makeProject("nx"), makeProject("co")];
      const p2 = [makeProject("nx")];

      globalThis.fetch = mock(async (input: string | URL | Request) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.includes("100.64.0.1")) return jsonResponse(p1);
        if (url.includes("100.64.0.2")) return jsonResponse(p2);
        throw new Error("connection refused");
      }) as FetchFn;

      const client = new AgentClient(agents);
      const result = await client.fetchAllProjects();

      expect(result.length).toBe(3);
      expect(result.filter((p) => p.agent === "dev-1").length).toBe(2);
      expect(result.filter((p) => p.agent === "dev-2").length).toBe(1);

      restoreFetch();
    });

    test("fetchSession returns a single session from the named agent", async () => {
      const session = makeSession("s1");

      globalThis.fetch = mock(async () => jsonResponse(session)) as FetchFn;

      const client = new AgentClient(agents);
      const result = await client.fetchSession("dev-1", "s1");

      expect(result).not.toBeNull();
      expect(result!.id).toBe("s1");
      expect(result!.agent).toBe("dev-1");

      restoreFetch();
    });
  });

  // ---- Offline agent: timeout after 3s, marked offline --------------------

  describe("offline agent", () => {
    test("offline agent is tracked with lastSeen=null", async () => {
      globalThis.fetch = mock(async () => {
        throw new Error("connection refused");
      }) as FetchFn;

      const client = new AgentClient([{ name: "dead", host: "10.0.0.1", port: 7400 }]);
      const result = await client.fetchAllSessions();

      expect(result.length).toBe(0);

      const statuses = client.getAgentStatuses();
      expect(statuses.length).toBe(1);
      expect(statuses[0]!.name).toBe("dead");
      expect(statuses[0]!.online).toBe(false);
      expect(statuses[0]!.lastSeen).toBeNull();

      restoreFetch();
    });

    test("timeout aborts after 3 seconds", async () => {
      globalThis.fetch = mock(async (_input: string | URL | Request, init?: RequestInit) => {
        // Simulate a request that hangs until aborted
        return new Promise<Response>((_, reject) => {
          const signal = init?.signal;
          if (signal) {
            signal.addEventListener("abort", () => {
              reject(new DOMException("The operation was aborted.", "AbortError"));
            });
          }
        });
      }) as FetchFn;

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

      restoreFetch();
    }, 15_000);
  });

  // ---- Slow agent: first request fails, retry succeeds --------------------

  describe("slow agent (retry)", () => {
    test("first request fails, retry succeeds", async () => {
      let callCount = 0;
      const sessions = [makeSession("retry-s1")];

      globalThis.fetch = mock(async () => {
        callCount++;
        if (callCount === 1) {
          throw new Error("ECONNRESET");
        }
        return jsonResponse(sessions);
      }) as FetchFn;

      const client = new AgentClient([{ name: "flaky", host: "10.0.0.1", port: 7400 }]);
      const result = await client.fetchAllSessions();

      expect(result.length).toBe(1);
      expect(result[0]!.id).toBe("retry-s1");
      expect(result[0]!.agent).toBe("flaky");
      expect(callCount).toBe(2); // initial + 1 retry

      restoreFetch();
    });
  });

  // ---- Mixed: 2 online + 1 offline ----------------------------------------

  describe("mixed agents", () => {
    test("2 online + 1 offline: merged results contain only online data, offline tracked", async () => {
      const sessions1 = [makeSession("m1")];
      const sessions2 = [makeSession("m2"), makeSession("m3")];

      globalThis.fetch = mock(async (input: string | URL | Request) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.includes("100.64.0.1")) return jsonResponse(sessions1);
        if (url.includes("100.64.0.2")) return jsonResponse(sessions2);
        // offline agent
        throw new Error("connection refused");
      }) as FetchFn;

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

      restoreFetch();
    });
  });

  // ---- Cache ---------------------------------------------------------------

  describe("caching", () => {
    test("subsequent calls within TTL return cached data", async () => {
      let callCount = 0;
      const sessions = [makeSession("cached-1")];

      globalThis.fetch = mock(async () => {
        callCount++;
        return jsonResponse(sessions);
      }) as FetchFn;

      const client = new AgentClient([{ name: "dev", host: "10.0.0.1", port: 7400 }]);

      const result1 = await client.fetchAllSessions();
      const result2 = await client.fetchAllSessions();

      expect(result1.length).toBe(1);
      expect(result2.length).toBe(1);
      // fetch should only have been called once due to cache
      expect(callCount).toBe(1);

      restoreFetch();
    });
  });
});
