import { describe, expect, it, afterAll } from "bun:test";
import { startServer, healthCollector } from "./server";

const server = startServer(0);
const baseUrl = `http://localhost:${server.port}`;

afterAll(() => {
  healthCollector.stop();
  server.stop();
});

describe("/health", () => {
  it("returns 200 with HealthMetrics shape", async () => {
    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json");

    const body = await res.json();
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
    // docker is either an object or null
    expect(body).toHaveProperty("docker");
  });
});

describe("CORS", () => {
  it("sets CORS headers for Tailscale origins", async () => {
    const res = await fetch(`${baseUrl}/health`, {
      headers: { Origin: "http://100.64.0.1:3000" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe(
      "http://100.64.0.1:3000",
    );
    expect(res.headers.get("access-control-allow-methods")).toBe(
      "GET, POST, OPTIONS",
    );
    expect(res.headers.get("access-control-allow-headers")).toBe(
      "Content-Type",
    );
  });

  it("does not set CORS headers for non-Tailscale origins", async () => {
    const res = await fetch(`${baseUrl}/health`, {
      headers: { Origin: "http://example.com" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("handles OPTIONS preflight with CORS headers", async () => {
    const res = await fetch(`${baseUrl}/health`, {
      method: "OPTIONS",
      headers: { Origin: "http://100.100.50.25:8080" },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe(
      "http://100.100.50.25:8080",
    );
  });
});
