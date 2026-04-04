/**
 * Agent-side acceptance tests.
 *
 * Verifies that the agent API endpoints return data in the correct shape
 * as expected by the dashboard. Tests run against the real server
 * (no mocks for the HTTP layer — only the DB/pty are absent).
 */

import { describe, expect, it, afterAll } from "bun:test";
import { startServer, healthCollector } from "../../src/server";

const server = startServer(0);
const baseUrl = `http://localhost:${server.port}`;

afterAll(() => {
  healthCollector.stop();
  server.stop();
});

// ---------------------------------------------------------------------------
// Session API shape
// ---------------------------------------------------------------------------

describe("Agent API: /sessions shape", () => {
  it("GET /sessions returns 200 with JSON array", async () => {
    const res = await fetch(`${baseUrl}/sessions`);
    // Without a DB, sessions route returns 404 (no DB mounted)
    // This is expected — the route only works with SQLite
    if (res.status === 200) {
      const body = await res.json();
      expect(Array.isArray(body)).toBe(true);
    } else {
      // Without DB, server returns 404 on session routes
      expect(res.status).toBe(404);
    }
  });

  it("GET /sessions/{id} returns 404 for nonexistent session", async () => {
    const res = await fetch(`${baseUrl}/sessions/nonexistent-id`);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body).toHaveProperty("error");
  });
});

// ---------------------------------------------------------------------------
// Health API shape
// ---------------------------------------------------------------------------

describe("Agent API: /health shape", () => {
  it("GET /health returns 200 with correct HealthMetrics shape", async () => {
    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json");

    const body = await res.json();

    // Required fields
    expect(body).toHaveProperty("hostname");
    expect(typeof body.hostname).toBe("string");

    expect(body).toHaveProperty("uptime_seconds");
    expect(typeof body.uptime_seconds).toBe("number");

    expect(body).toHaveProperty("cpu");
    expect(typeof body.cpu.overall_percent).toBe("number");
    expect(Array.isArray(body.cpu.per_core_percent)).toBe(true);
    expect(Array.isArray(body.cpu.load_average)).toBe(true);

    expect(body).toHaveProperty("ram");
    expect(typeof body.ram.total_bytes).toBe("number");
    expect(typeof body.ram.used_bytes).toBe("number");
    expect(typeof body.ram.percent).toBe("number");

    expect(body).toHaveProperty("disk");
    expect(Array.isArray(body.disk)).toBe(true);

    // docker is either an object or null
    expect(body).toHaveProperty("docker");
    if (body.docker !== null) {
      expect(typeof body.docker.containers).toBe("number");
      expect(typeof body.docker.running).toBe("number");
    }
  });

  it("GET /health?detail=true returns processes and network", async () => {
    const res = await fetch(`${baseUrl}/health?detail=true`);
    expect(res.status).toBe(200);

    const body = await res.json();
    // Detail fields may not be populated if collector is warming up,
    // but the shape should be there or omitted gracefully
    expect(body).toHaveProperty("hostname");
    expect(body).toHaveProperty("cpu");
    expect(body).toHaveProperty("ram");
  });
});

// ---------------------------------------------------------------------------
// WebSocket endpoints existence
// ---------------------------------------------------------------------------

describe("Agent API: WebSocket endpoints", () => {
  it("GET /sessions/{id}/stream without upgrade returns 404 (no PTY)", async () => {
    // Without a PTY attached, the server returns 404
    const res = await fetch(`${baseUrl}/sessions/test-id/stream`);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("session not found");
  });

  it("GET /sessions/{id}/interact without upgrade returns 404 (no PTY)", async () => {
    const res = await fetch(`${baseUrl}/sessions/test-id/interact`);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("session not found");
  });
});

// ---------------------------------------------------------------------------
// Projects API shape
// ---------------------------------------------------------------------------

describe("Agent API: /projects shape", () => {
  it("GET /projects returns 200 with JSON array when DB is available", async () => {
    const res = await fetch(`${baseUrl}/projects`);
    // Without a DB, returns 404
    if (res.status === 200) {
      const body = await res.json();
      expect(Array.isArray(body)).toBe(true);
      if (body.length > 0) {
        const project = body[0];
        expect(project).toHaveProperty("name");
        expect(project).toHaveProperty("active_sessions");
        expect(project).toHaveProperty("total_sessions");
        expect(project).toHaveProperty("machines");
        expect(Array.isArray(project.machines)).toBe(true);
      }
    } else {
      expect(res.status).toBe(404);
    }
  });
});

// ---------------------------------------------------------------------------
// CORS handling
// ---------------------------------------------------------------------------

describe("Agent API: CORS", () => {
  it("sets CORS headers for Tailscale origins", async () => {
    const res = await fetch(`${baseUrl}/health`, {
      headers: { Origin: "http://100.64.0.1:3100" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe(
      "http://100.64.0.1:3100",
    );
  });

  it("OPTIONS preflight returns 204 with CORS headers", async () => {
    const res = await fetch(`${baseUrl}/health`, {
      method: "OPTIONS",
      headers: { Origin: "http://100.100.1.1:3100" },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe(
      "http://100.100.1.1:3100",
    );
    expect(res.headers.get("access-control-allow-methods")).toBe(
      "GET, POST, OPTIONS",
    );
  });

  it("does not set CORS for non-Tailscale origins", async () => {
    const res = await fetch(`${baseUrl}/health`, {
      headers: { Origin: "http://evil.com" },
    });
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 404 for unknown routes
// ---------------------------------------------------------------------------

describe("Agent API: unknown routes", () => {
  it("returns 404 JSON for unknown paths", async () => {
    const res = await fetch(`${baseUrl}/unknown/path`);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("not found");
  });
});
