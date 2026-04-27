/**
 * Server REST + WebSocket no-auth contract tests.
 *
 * Auth gate dropped in `drop-attach-secret-gate` — both REST and WebSocket
 * surfaces now respond without an `x-nexus-secret` header / `?token=` query
 * param. Reachability is bounded at the bind layer (loopback + Tailscale only)
 * — every connection that reaches dispatch is already authenticated by
 * WireGuard or local OS identity.
 *
 * The tests in this file pin the no-auth contract: previously gated routes
 * now succeed without credentials, stale headers are no-ops, and WebSocket
 * upgrades no longer return 401.
 */

import { describe, expect, it } from "bun:test";
import { baseUrl } from "./server.helpers";

// ── WebSocket: no-auth contract ─────────────────────────────────────────────

describe("WebSocket: no auth gate (drop-attach-secret-gate)", () => {
  it("/sessions/{id}/stream upgrade without token does not return 401", async () => {
    const res = await fetch(`${baseUrl}/sessions/some-session/stream`);
    expect(res.status).not.toBe(401);
    // No PTY attached → 404 from the upgrade handler
    expect(res.status).toBe(404);
  });

  it("/sessions/{id}/interact upgrade without token does not return 401", async () => {
    const res = await fetch(`${baseUrl}/sessions/some-session/interact`);
    expect(res.status).not.toBe(401);
    expect(res.status).toBe(404);
  });

  it("/sessions/{id}/stream upgrade with stale x-nexus-secret header is ignored", async () => {
    const res = await fetch(`${baseUrl}/sessions/some-session/stream`, {
      headers: { "x-nexus-secret": "wrong-secret" },
    });
    expect(res.status).not.toBe(401);
    expect(res.status).toBe(404);
  });

  it("/sessions/{id}/interact upgrade with stale x-nexus-secret header is ignored", async () => {
    const res = await fetch(`${baseUrl}/sessions/some-session/interact`, {
      headers: { "x-nexus-secret": "wrong-secret" },
    });
    expect(res.status).not.toBe(401);
    expect(res.status).toBe(404);
  });

  it("/sessions/{id}/stream upgrade with stale ?token= query param is ignored", async () => {
    const res = await fetch(`${baseUrl}/sessions/some-session/stream?token=anything`);
    expect(res.status).not.toBe(401);
    expect(res.status).toBe(404);
  });

  it("/sessions/{id}/interact upgrade with stale ?token= query param is ignored", async () => {
    const res = await fetch(`${baseUrl}/sessions/some-session/interact?token=anything`);
    expect(res.status).not.toBe(401);
    expect(res.status).toBe(404);
  });
});

// ── REST: no-auth contract ──────────────────────────────────────────────────

describe("REST endpoints: no header required (drop-attach-secret-gate)", () => {
  it("GET /health without x-nexus-secret returns 200", async () => {
    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(200);
  });

  it("GET /sessions without x-nexus-secret does not return 401", async () => {
    const res = await fetch(`${baseUrl}/sessions`);
    expect(res.status).not.toBe(401);
  });

  it("GET /projects without x-nexus-secret does not return 401", async () => {
    const res = await fetch(`${baseUrl}/projects`);
    expect(res.status).not.toBe(401);
  });

  it("GET /credentials without x-nexus-secret does not return 401", async () => {
    const res = await fetch(`${baseUrl}/credentials`);
    expect(res.status).not.toBe(401);
  });

  it("POST /notifications/send without x-nexus-secret does not return 401", async () => {
    const res = await fetch(`${baseUrl}/notifications/send`, { method: "POST" });
    expect(res.status).not.toBe(401);
  });
});

describe("REST endpoints: stale x-nexus-secret header is ignored", () => {
  it("GET /health with any header value returns 200 (no behavior change)", async () => {
    const res = await fetch(`${baseUrl}/health`, {
      headers: { "x-nexus-secret": "anything" },
    });
    expect(res.status).toBe(200);
  });

  it("GET /health with a wrong secret is ignored — 200 (no longer 401)", async () => {
    const res = await fetch(`${baseUrl}/health`, {
      headers: { "x-nexus-secret": "wrong-secret" },
    });
    expect(res.status).toBe(200);
  });

  it("GET /health with an empty secret is ignored — 200 (no longer 401)", async () => {
    const res = await fetch(`${baseUrl}/health`, {
      headers: { "x-nexus-secret": "" },
    });
    expect(res.status).toBe(200);
  });
});

// ── Security: session ID validation ──────────────────────────────────────────

describe("WebSocket security: session ID validation", () => {
  it("[2.6] path traversal in session ID returns 400 on /stream", async () => {
    const res = await fetch(`${baseUrl}/sessions/..%2Fetc%2Fpasswd/stream`);
    expect(res.status).toBe(400);
  });

  it("[2.6] path traversal in session ID returns 400 on /interact", async () => {
    const res = await fetch(`${baseUrl}/sessions/..%2Fetc%2Fpasswd/interact`);
    expect(res.status).toBe(400);
  });

  it("[2.6] session ID with special chars returns 400", async () => {
    const res = await fetch(`${baseUrl}/sessions/evil%3Bid%3D1/stream`);
    expect(res.status).toBe(400);
  });

  it("[2.6] valid alphanumeric session ID proceeds past validation (404 since no PTY)", async () => {
    const res = await fetch(`${baseUrl}/sessions/valid-session-123/stream`);
    expect(res.status).toBe(404);
  });

  it("[8.2] session ID with dots is accepted (404 since no PTY, not 400)", async () => {
    const res = await fetch(`${baseUrl}/sessions/session.2026-04-06.1/stream`);
    expect(res.status).toBe(404);
  });

  it("[8.2] session ID with slashes is rejected with 400", async () => {
    const res = await fetch(`${baseUrl}/sessions/session%2Fbad/stream`);
    expect(res.status).toBe(400);
  });
});

// ── Task 5.4: Credential ID sanitization — invalid IDs return 400 ─────────────

describe("Credential ID sanitization (task 5.4)", () => {
  const invalidIds = [
    { label: "path traversal ../", id: "..%2Fsome-path" },
    { label: "space in id", id: "has%20space" },
    { label: "script tag", id: "%3Cscript%3E" },
  ];

  for (const { label, id } of invalidIds) {
    it(`POST /credentials/${id}/release with ${label} returns 400`, async () => {
      const res = await fetch(`${baseUrl}/credentials/${id}/release`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
    });

    it(`POST /credentials/${id}/report-rate-limit with ${label} returns 400`, async () => {
      const res = await fetch(`${baseUrl}/credentials/${id}/report-rate-limit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
    });
  }
});
