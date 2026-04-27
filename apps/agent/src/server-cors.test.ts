/**
 * Server CORS tests — CORS headers and preflight handling.
 *
 * Auth gate dropped in `drop-attach-secret-gate` — tests no longer set
 * `x-nexus-secret` and the header is no longer included in
 * Access-Control-Allow-Headers.
 */

import { describe, expect, it } from "bun:test";
import { baseUrl } from "./server.helpers";

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
      "GET, POST, PUT, OPTIONS",
    );
    expect(res.headers.get("access-control-allow-headers")).toBe(
      "Content-Type",
    );
  });

  it("blocks non-Tailscale browser origins with 403 (task 2.3 defense-in-depth)", async () => {
    const res = await fetch(`${baseUrl}/health`, {
      headers: { Origin: "http://example.com" },
    });
    expect(res.status).toBe(403);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("origin not allowed");
  });

  it("treats malformed Origin as absent (falls through to dispatch)", async () => {
    const res = await fetch(`${baseUrl}/health`, {
      headers: { Origin: "not-a-url" },
    });
    // Malformed origin → not classified as non-Tailscale → falls through
    // to dispatch and returns 200 on /health.
    expect(res.status).toBe(200);
  });

  it("passes through requests with no Origin header (curl/wscat)", async () => {
    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(200);
  });

  it("still allows OPTIONS preflight from any Origin (browsers need it)", async () => {
    const res = await fetch(`${baseUrl}/health`, {
      method: "OPTIONS",
      headers: { Origin: "http://example.com" },
    });
    // OPTIONS bypasses the 403 block. Non-Tailscale preflight returns 204 but
    // without Access-Control-Allow-Origin (withCors only sets headers for TS).
    expect(res.status).toBe(204);
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

// ── CORS preflight: Allow-Headers post-drop-attach-secret-gate ──────────────

describe("CORS preflight: Allow-Headers no longer advertises x-nexus-secret", () => {
  it("OPTIONS preflight from Tailscale origin advertises only Content-Type", async () => {
    const res = await fetch(`${baseUrl}/health`, {
      method: "OPTIONS",
      headers: { Origin: "http://100.64.0.1:7401" },
    });
    expect(res.status).toBe(204);
    const allowHeaders = res.headers.get("access-control-allow-headers");
    expect(allowHeaders).toBeDefined();
    expect(allowHeaders).toBe("Content-Type");
    expect(allowHeaders).not.toContain("x-nexus-secret");
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
