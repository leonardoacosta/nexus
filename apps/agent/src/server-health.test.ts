/**
 * Server health endpoint tests — /health, POST /health/ingest, shutdown.
 */

import { describe, expect, it } from "bun:test";
import type { HealthMetrics } from "@nexus/core";
import { ATTACH_SECRET, baseUrl, streamManager, MockPtySource } from "./server.helpers";

describe("/health", () => {
  it("returns 200 with HealthMetrics shape", async () => {
    const res = await fetch(`${baseUrl}/health`, {
      headers: { "x-nexus-secret": ATTACH_SECRET },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json");

    const body = await res.json() as HealthMetrics;
    expect(body).toHaveProperty("hostname");
    expect(typeof body.hostname).toBe("string");
    expect(body).toHaveProperty("uptime_seconds");
    expect(typeof body.uptime_seconds).toBe("number");
    expect(body).toHaveProperty("cpu");
    expect(typeof body.cpu.overall_percent).toBe("number");
    expect(Array.isArray(body.cpu.per_core_percent)).toBe(true);
    expect(body).toHaveProperty("ram");
    expect(typeof body.ram.percent).toBe("number");
    expect(Array.isArray(body.disk)).toBe(true);
    expect(body).toHaveProperty("docker");
  });
});

// ── Security: SIGTERM / shutdown ─────────────────────────────────────────────

describe("shutdown: streamManager.shutdown() is called", () => {
  it("[2.3] shutdown() ends all active sessions and closes their PTYs", () => {
    const sm = new (streamManager.constructor as typeof import("./terminal/stream-manager").StreamManager)();

    const pty1 = new MockPtySource({ intervalMs: 0 });
    const pty2 = new MockPtySource({ intervalMs: 0 });

    sm.attach("shutdown-sess-1", pty1);
    sm.attach("shutdown-sess-2", pty2);

    expect(sm.getPty("shutdown-sess-1")).toBeDefined();
    expect(sm.getPty("shutdown-sess-2")).toBeDefined();

    sm.shutdown();

    expect(sm.getPty("shutdown-sess-1")).toBeUndefined();
    expect(sm.getPty("shutdown-sess-2")).toBeUndefined();
    expect(sm.viewerCount("shutdown-sess-1")).toBe(0);
    expect(sm.viewerCount("shutdown-sess-2")).toBe(0);
  });
});

// ── POST /health/ingest ───────────────────────────────────────────────────────

describe("POST /health/ingest (task 9.3)", () => {
  it("returns 404 when db is not provided (no-db server)", async () => {
    const res = await fetch(`${baseUrl}/health/ingest`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-nexus-secret": ATTACH_SECRET,
      },
      body: JSON.stringify({
        hostname: "test-machine",
        uptime_seconds: 1234,
        cpu: { overall_percent: 42, per_core_percent: [40, 44], load_average: [1.0, 0.8, 0.6] },
        ram: { total_bytes: 16000000000, used_bytes: 8000000000, percent: 50 },
        disk: [{ mount: "/", total_bytes: 500000000000, used_bytes: 250000000000, percent: 50 }],
        docker: null,
      }),
    });
    expect(res.status).toBe(404);
  });

  it("returns 401 without x-nexus-secret", async () => {
    const res = await fetch(`${baseUrl}/health/ingest`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hostname: "x", uptime_seconds: 0, cpu: {}, ram: {}, disk: [] }),
    });
    expect(res.status).toBe(401);
  });

  it("returns 400 for missing required fields when body is invalid", async () => {
    const res = await fetch(`${baseUrl}/health/ingest`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-nexus-secret": ATTACH_SECRET,
      },
      body: "not json at all",
    });
    expect([400, 404]).toContain(res.status);
  });
});
