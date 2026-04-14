/**
 * AgentClient core tests.
 *
 * Covers updateCommand, fetchSession, fetchDiscoveredProjects,
 * online/offline tracking, and cache behavior.
 *
 * Note: fetchAllSessions, fetchAllHealth, and fetchAllProjects were removed
 * as part of the dual-path collapse. Those call sites now use @nexus/db
 * Drizzle queries directly.
 */

import { describe, test, expect, afterEach, vi } from "vitest";
import { AgentClient } from "../agent-client";
import { agents, makeSession, jsonResponse } from "../agent-client.helpers";

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

  // ---- fetchSession: single-agent fetch ------------------------------------

  describe("fetchSession", () => {
    test("returns a single session from the named agent", async () => {
      const session = makeSession("s1");

      vi.stubGlobal("fetch", async () => jsonResponse(session));

      const client = new AgentClient(agents);
      const result = await client.fetchSession("dev-1", "s1");

      expect(result).not.toBeNull();
      expect(result!.id).toBe("s1");
      expect(result!.agent).toBe("dev-1");
    });

    test("returns null for unknown agent", async () => {
      const client = new AgentClient(agents);
      const result = await client.fetchSession("nonexistent", "s1");
      expect(result).toBeNull();
    });
  });

  // ---- Offline agent: tracked with lastSeen=null --------------------------

  describe("offline agent", () => {
    test("offline agent is tracked with lastSeen=null", async () => {
      vi.stubGlobal("fetch", async () => {
        throw new Error("connection refused");
      });

      const client = new AgentClient([{ name: "dead", host: "10.0.0.1", port: 7400 }]);
      const result = await client.fetchSession("dead", "s1");

      expect(result).toBeNull();

      const statuses = client.getAgentStatuses();
      expect(statuses.length).toBe(1);
      expect(statuses[0]!.name).toBe("dead");
      expect(statuses[0]!.online).toBe(false);
      expect(statuses[0]!.lastSeen).toBeNull();
    });
  });

  // ---- Slow agent: first request fails, retry succeeds --------------------

  describe("slow agent (retry)", () => {
    test("first request fails, retry succeeds", async () => {
      let callCount = 0;
      const session = makeSession("retry-s1");

      vi.stubGlobal("fetch", async () => {
        callCount++;
        if (callCount === 1) throw new Error("ECONNRESET");
        return jsonResponse(session);
      });

      const client = new AgentClient([{ name: "flaky", host: "10.0.0.1", port: 7400 }]);
      const result = await client.fetchSession("flaky", "retry-s1");

      expect(result).not.toBeNull();
      expect(result!.id).toBe("retry-s1");
      expect(result!.agent).toBe("flaky");
      expect(callCount).toBe(2);
    });
  });

  // ---- Agent status tracking -----------------------------------------------

  describe("agent status tracking", () => {
    test("successful fetch marks agent online", async () => {
      const session = makeSession("s1");
      vi.stubGlobal("fetch", async () => jsonResponse(session));

      const client = new AgentClient(agents);
      await client.fetchSession("dev-1", "s1");

      const statuses = client.getAgentStatuses();
      const dev1 = statuses.find((s) => s.name === "dev-1");
      expect(dev1).toBeDefined();
      expect(dev1!.online).toBe(true);
      expect(dev1!.lastSeen).not.toBeNull();
    });

    test("failed fetch leaves agent offline", async () => {
      vi.stubGlobal("fetch", async () => {
        throw new Error("connection refused");
      });

      const client = new AgentClient(agents);
      await client.fetchSession("dev-1", "s1");

      const statuses = client.getAgentStatuses();
      const dev1 = statuses.find((s) => s.name === "dev-1");
      expect(dev1).toBeDefined();
      expect(dev1!.online).toBe(false);
    });
  });
});
