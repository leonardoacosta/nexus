/**
 * AgentClient mutation tests — wave 3, spec: pick-db-writer-boundary (task 4.1)
 *
 * Verifies that the three dashboard mutation methods (updateProject, saveAgent,
 * deleteAgent) route correctly through the agent HTTP API:
 *   - Correct HTTP method and URL
 *   - Correct request body (where applicable)
 *   - x-nexus-secret header present
 *   - Error surfaces (404, 500, network error) — not silently swallowed
 */

import { describe, test, expect, afterEach, vi } from "vitest";
import { AgentClient } from "../agent-client";
import { jsonResponse } from "../agent-client.helpers";

const TEST_SECRET = "wave-3-test-secret";
const AGENT = { name: "dev-1", host: "100.64.0.1", port: 7400 };
const BASE = `http://${AGENT.host}:${AGENT.port}`;

// Helper: capture the request the client sends
interface CapturedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function captureRequest(responseData: unknown, status = 200): { captured: CapturedRequest | null; stub: () => Promise<Response> } {
  const captured: { value: CapturedRequest | null } = { value: null };
  const stub = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof Request ? input.url : input.href;
    const headers = Object.fromEntries(new Headers(init?.headers ?? {}).entries());
    let body: unknown = undefined;
    if (init?.body) {
      try { body = JSON.parse(init.body as string); } catch { body = init.body; }
    }
    captured.value = { url, method: init?.method ?? "GET", headers, body };
    return jsonResponse(responseData, status);
  };
  return { captured: null, stub };
}

// Keep a ref we can read after calling vi.stubGlobal
function makeFetchSpy(responseData: unknown, status = 200) {
  let captured: CapturedRequest | null = null;
  const fetchSpy = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof Request ? input.url : (input as URL).href;
    const headers = Object.fromEntries(new Headers(init?.headers ?? {}).entries());
    let body: unknown = undefined;
    if (init?.body) {
      try { body = JSON.parse(init.body as string); } catch { body = init.body; }
    }
    captured = { url, method: init?.method ?? "GET", headers, body };
    return jsonResponse(responseData, status);
  };
  return { fetchSpy, getCapture: () => captured };
}

describe("AgentClient mutations (wave-3 boundary tests)", () => {
  const originalSecret = process.env.NEXUS_ATTACH_SECRET;

  afterEach(() => {
    vi.unstubAllGlobals();
    process.env.NEXUS_ATTACH_SECRET = originalSecret;
  });

  // ---- updateProject --------------------------------------------------------

  describe("updateProject", () => {
    test("sends PATCH to /projects/:id with correct body and secret header", async () => {
      const { fetchSpy, getCapture } = makeFetchSpy({ updated: true });
      vi.stubGlobal("fetch", fetchSpy);
      process.env.NEXUS_ATTACH_SECRET = TEST_SECRET;

      const client = new AgentClient([AGENT]);
      const result = await client.updateProject({
        id: "proj-123",
        tags: ["rust", "cli"],
        description: "Updated desc",
      });

      expect(result).toEqual({ updated: true });

      const req = getCapture()!;
      expect(req.url).toBe(`${BASE}/projects/proj-123`);
      expect(req.method).toBe("PATCH");
      expect(req.headers["x-nexus-secret"]).toBe(TEST_SECRET);
      expect(req.headers["content-type"]).toContain("application/json");
      expect(req.body).toEqual({ tags: ["rust", "cli"], description: "Updated desc" });
    });

    test("URL-encodes project id with special characters", async () => {
      const { fetchSpy, getCapture } = makeFetchSpy({ updated: true });
      vi.stubGlobal("fetch", fetchSpy);
      process.env.NEXUS_ATTACH_SECRET = TEST_SECRET;

      const client = new AgentClient([AGENT]);
      await client.updateProject({ id: "proj/with spaces" });

      const req = getCapture()!;
      expect(req.url).toBe(`${BASE}/projects/${encodeURIComponent("proj/with spaces")}`);
    });

    test("throws when agent returns 404", async () => {
      vi.stubGlobal("fetch", async () => jsonResponse({ error: "project not found" }, 404));
      process.env.NEXUS_ATTACH_SECRET = TEST_SECRET;

      const client = new AgentClient([AGENT]);
      await expect(client.updateProject({ id: "ghost" })).rejects.toThrow("project not found");
    });

    test("throws when agent returns 500", async () => {
      vi.stubGlobal("fetch", async () => jsonResponse({ error: "internal error" }, 500));
      process.env.NEXUS_ATTACH_SECRET = TEST_SECRET;

      const client = new AgentClient([AGENT]);
      await expect(client.updateProject({ id: "any" })).rejects.toThrow("internal error");
    });

    test("throws when network request fails", async () => {
      vi.stubGlobal("fetch", async () => { throw new Error("ECONNREFUSED"); });

      const client = new AgentClient([AGENT]);
      await expect(client.updateProject({ id: "any" })).rejects.toThrow("ECONNREFUSED");
    });

    test("throws when no agents are configured", async () => {
      const client = new AgentClient([]);
      await expect(client.updateProject({ id: "any" })).rejects.toThrow("No agents configured");
    });
  });

  // ---- saveAgent ------------------------------------------------------------

  describe("saveAgent", () => {
    test("sends POST to /agents with correct body and secret header", async () => {
      const { fetchSpy, getCapture } = makeFetchSpy({ saved: true });
      vi.stubGlobal("fetch", fetchSpy);
      process.env.NEXUS_ATTACH_SECRET = TEST_SECRET;

      const client = new AgentClient([AGENT]);
      const result = await client.saveAgent({ name: "mac", host: "100.64.0.5", port: 7400 });

      expect(result).toEqual({ saved: true });

      const req = getCapture()!;
      expect(req.url).toBe(`${BASE}/agents`);
      expect(req.method).toBe("POST");
      expect(req.headers["x-nexus-secret"]).toBe(TEST_SECRET);
      expect(req.headers["content-type"]).toContain("application/json");
      expect(req.body).toEqual({ name: "mac", host: "100.64.0.5", port: 7400 });
    });

    test("throws when agent returns 400", async () => {
      vi.stubGlobal("fetch", async () => jsonResponse({ error: "duplicate agent name" }, 400));
      process.env.NEXUS_ATTACH_SECRET = TEST_SECRET;

      const client = new AgentClient([AGENT]);
      await expect(
        client.saveAgent({ name: "mac", host: "100.64.0.5", port: 7400 }),
      ).rejects.toThrow("duplicate agent name");
    });

    test("throws when agent returns 500", async () => {
      vi.stubGlobal("fetch", async () => jsonResponse({ error: "db write failed" }, 500));
      process.env.NEXUS_ATTACH_SECRET = TEST_SECRET;

      const client = new AgentClient([AGENT]);
      await expect(
        client.saveAgent({ name: "x", host: "1.2.3.4", port: 7400 }),
      ).rejects.toThrow("db write failed");
    });

    test("throws when network request fails", async () => {
      vi.stubGlobal("fetch", async () => { throw new Error("network unreachable"); });

      const client = new AgentClient([AGENT]);
      await expect(
        client.saveAgent({ name: "x", host: "1.2.3.4", port: 7400 }),
      ).rejects.toThrow("network unreachable");
    });

    test("throws when no agents are configured", async () => {
      const client = new AgentClient([]);
      await expect(
        client.saveAgent({ name: "x", host: "1.2.3.4", port: 7400 }),
      ).rejects.toThrow("No agents configured");
    });
  });

  // ---- deleteAgent ----------------------------------------------------------

  describe("deleteAgent", () => {
    test("sends DELETE to /agents/:id with correct secret header", async () => {
      const { fetchSpy, getCapture } = makeFetchSpy({ deleted: true });
      vi.stubGlobal("fetch", fetchSpy);
      process.env.NEXUS_ATTACH_SECRET = TEST_SECRET;

      const client = new AgentClient([AGENT]);
      const result = await client.deleteAgent("agent-abc");

      expect(result).toEqual({ deleted: true });

      const req = getCapture()!;
      expect(req.url).toBe(`${BASE}/agents/agent-abc`);
      expect(req.method).toBe("DELETE");
      expect(req.headers["x-nexus-secret"]).toBe(TEST_SECRET);
      // DELETE has no body
      expect(req.body).toBeUndefined();
    });

    test("URL-encodes agent id", async () => {
      const { fetchSpy, getCapture } = makeFetchSpy({ deleted: true });
      vi.stubGlobal("fetch", fetchSpy);
      process.env.NEXUS_ATTACH_SECRET = TEST_SECRET;

      const client = new AgentClient([AGENT]);
      await client.deleteAgent("agent/special id");

      const req = getCapture()!;
      expect(req.url).toBe(`${BASE}/agents/${encodeURIComponent("agent/special id")}`);
    });

    test("throws when agent returns 404", async () => {
      vi.stubGlobal("fetch", async () => jsonResponse({ error: "agent not found" }, 404));
      process.env.NEXUS_ATTACH_SECRET = TEST_SECRET;

      const client = new AgentClient([AGENT]);
      await expect(client.deleteAgent("ghost-id")).rejects.toThrow("agent not found");
    });

    test("throws when agent returns 500", async () => {
      vi.stubGlobal("fetch", async () => jsonResponse({ error: "delete failed" }, 500));
      process.env.NEXUS_ATTACH_SECRET = TEST_SECRET;

      const client = new AgentClient([AGENT]);
      await expect(client.deleteAgent("any-id")).rejects.toThrow("delete failed");
    });

    test("throws when network request fails", async () => {
      vi.stubGlobal("fetch", async () => { throw new Error("ETIMEDOUT"); });

      const client = new AgentClient([AGENT]);
      await expect(client.deleteAgent("any-id")).rejects.toThrow("ETIMEDOUT");
    });

    test("throws when no agents are configured", async () => {
      const client = new AgentClient([]);
      await expect(client.deleteAgent("any-id")).rejects.toThrow("No agents configured");
    });
  });
});
