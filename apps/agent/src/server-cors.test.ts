/**
 * Server CORS tests — CORS headers and preflight handling.
 */

import { describe, expect, it } from "bun:test";
import { ATTACH_SECRET, baseUrl } from "./server.helpers";

describe("CORS", () => {
  it("sets CORS headers for Tailscale origins", async () => {
    const res = await fetch(`${baseUrl}/health`, {
      headers: { Origin: "http://100.64.0.1:3000", "x-nexus-secret": ATTACH_SECRET },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe(
      "http://100.64.0.1:3000",
    );
    expect(res.headers.get("access-control-allow-methods")).toBe(
      "GET, POST, OPTIONS",
    );
    expect(res.headers.get("access-control-allow-headers")).toBe(
      "Content-Type, x-nexus-secret",
    );
  });

  it("does not set CORS headers for non-Tailscale origins", async () => {
    const res = await fetch(`${baseUrl}/health`, {
      headers: { Origin: "http://example.com", "x-nexus-secret": ATTACH_SECRET },
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

// ── Task 3.2: CORS preflight — updated Allow-Headers includes x-nexus-secret ──

describe("CORS preflight: x-nexus-secret in Allow-Headers (task 3.2)", () => {
  it("OPTIONS preflight from Tailscale origin receives x-nexus-secret in Allow-Headers", async () => {
    const res = await fetch(`${baseUrl}/health`, {
      method: "OPTIONS",
      headers: { Origin: "http://100.64.0.1:7401" },
    });
    expect(res.status).toBe(204);
    const allowHeaders = res.headers.get("access-control-allow-headers");
    expect(allowHeaders).toBeDefined();
    expect(allowHeaders).toContain("x-nexus-secret");
    expect(allowHeaders).toContain("Content-Type");
  });

  it("OPTIONS preflight from Tailscale origin receives correct CORS allow-origin", async () => {
    const tailscaleOrigin = "http://100.100.50.25:3000";
    const res = await fetch(`${baseUrl}/health`, {
      method: "OPTIONS",
      headers: { Origin: tailscaleOrigin },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe(tailscaleOrigin);
  });
});
