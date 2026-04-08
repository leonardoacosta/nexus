/**
 * AgentClient core CRUD + caching tests.
 *
 * Covers updateCommand, online/offline/mixed/slow agents, and cache behavior.
 */

import { describe, test, expect, afterEach, vi } from "vitest";
import { AgentClient } from "../agent-client";
import { agents, makeSession, makeHealth, makeProject, jsonResponse } from "../agent-client.helpers";

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
      expect(callCount).toBe(2);
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
        throw new Error("connection refused");
      });

      const client = new AgentClient(agents);
      const result = await client.fetchAllSessions();

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
      expect(callCount).toBe(1);
    });
  });
});
