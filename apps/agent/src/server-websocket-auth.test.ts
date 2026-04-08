/**
 * Server WebSocket and REST authentication tests.
 *
 * Covers WebSocket upgrade auth, query-string token auth, REST auth,
 * timing-safe comparison, session ID validation, and credential ID sanitization.
 */

import { describe, expect, it } from "bun:test";
import { ATTACH_SECRET, baseUrl } from "./server.helpers";

// ── Security: WebSocket authentication ──────────────────────────────────────

describe("WebSocket security: authentication", () => {
  it("[2.1] /sessions/{id}/stream upgrade without secret returns 401", async () => {
    const res = await fetch(`${baseUrl}/sessions/some-session/stream`);
    expect(res.status).toBe(401);
  });

  it("[2.1] /sessions/{id}/interact upgrade without secret returns 401", async () => {
    const res = await fetch(`${baseUrl}/sessions/some-session/interact`);
    expect(res.status).toBe(401);
  });

  it("[2.1] /sessions/{id}/stream upgrade with wrong secret returns 401", async () => {
    const res = await fetch(`${baseUrl}/sessions/some-session/stream`, {
      headers: { "x-nexus-secret": "wrong-secret" },
    });
    expect(res.status).toBe(401);
  });

  it("[2.1] /sessions/{id}/interact upgrade with wrong secret returns 401", async () => {
    const res = await fetch(`${baseUrl}/sessions/some-session/interact`, {
      headers: { "x-nexus-secret": "wrong-secret" },
    });
    expect(res.status).toBe(401);
  });
});

// ── Security: WebSocket query-string token auth ──────────────────────────────

describe("WebSocket query-string token auth", () => {
  it("[1.4] stream: missing token (no header, no QS) → 401", async () => {
    const res = await fetch(`${baseUrl}/sessions/some-session/stream`);
    expect(res.status).toBe(401);
  });

  it("[1.4] stream: wrong token in query-string → 401", async () => {
    const res = await fetch(`${baseUrl}/sessions/some-session/stream?token=wrong-token`);
    expect(res.status).toBe(401);
  });

  it("[1.4] stream: correct token in query-string → passes auth (404 because no PTY, not 401)", async () => {
    const res = await fetch(
      `${baseUrl}/sessions/some-session/stream?token=${encodeURIComponent(ATTACH_SECRET)}`,
    );
    expect(res.status).not.toBe(401);
    expect(res.status).toBe(404);
  });

  it("[1.4] interact: missing token (no header, no QS) → 401", async () => {
    const res = await fetch(`${baseUrl}/sessions/some-session/interact`);
    expect(res.status).toBe(401);
  });

  it("[1.4] interact: wrong token in query-string → 401", async () => {
    const res = await fetch(`${baseUrl}/sessions/some-session/interact?token=wrong-token`);
    expect(res.status).toBe(401);
  });

  it("[1.4] interact: correct token in query-string → passes auth (404 because no PTY, not 401)", async () => {
    const res = await fetch(
      `${baseUrl}/sessions/some-session/interact?token=${encodeURIComponent(ATTACH_SECRET)}`,
    );
    expect(res.status).not.toBe(401);
    expect(res.status).toBe(404);
  });
});

// ── Task 1.3: Global REST auth — missing x-nexus-secret returns 401 ──────────

describe("REST auth: missing x-nexus-secret returns 401 (task 1.3)", () => {
  const routes = [
    { method: "GET", path: "/credentials" },
    { method: "GET", path: "/sessions" },
    { method: "GET", path: "/projects" },
    { method: "GET", path: "/health" },
    { method: "POST", path: "/notifications/send" },
  ];

  for (const { method, path } of routes) {
    it(`${method} ${path} without x-nexus-secret returns 401`, async () => {
      const res = await fetch(`${baseUrl}${path}`, { method });
      expect(res.status).toBe(401);
    });
  }
});

// ── Task 1.4: Global REST auth — correct secret passes through ───────────────

describe("REST auth: correct x-nexus-secret passes through (task 1.4)", () => {
  it("GET /health with correct secret returns 200", async () => {
    const res = await fetch(`${baseUrl}/health`, {
      headers: { "x-nexus-secret": ATTACH_SECRET },
    });
    expect(res.status).toBe(200);
  });

  it("GET /sessions with correct secret does not return 401", async () => {
    const res = await fetch(`${baseUrl}/sessions`, {
      headers: { "x-nexus-secret": ATTACH_SECRET },
    });
    expect(res.status).not.toBe(401);
  });
});

// ── Task 2.4: Timing-safe comparison — different byte length returns 401 ─────

describe("Timing-safe comparison: different byte length (task 2.4)", () => {
  it("secret header shorter than ATTACH_SECRET returns 401 without throwing", async () => {
    const res = await fetch(`${baseUrl}/health`, {
      headers: { "x-nexus-secret": "x" },
    });
    expect(res.status).toBe(401);
  });

  it("secret header longer than ATTACH_SECRET returns 401 without throwing", async () => {
    const res = await fetch(`${baseUrl}/health`, {
      headers: { "x-nexus-secret": ATTACH_SECRET.repeat(3) + "extra" },
    });
    expect(res.status).toBe(401);
  });

  it("empty secret header returns 401 without throwing", async () => {
    const res = await fetch(`${baseUrl}/health`, {
      headers: { "x-nexus-secret": "" },
    });
    expect(res.status).toBe(401);
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

  it("[2.6] valid alphanumeric session ID proceeds past validation (reaches auth/session checks)", async () => {
    const res = await fetch(`${baseUrl}/sessions/valid-session-123/stream`);
    expect(res.status).toBe(401);
  });

  it("[8.2] session ID with dots is accepted (returns 401 not 400)", async () => {
    const res = await fetch(`${baseUrl}/sessions/session.2026-04-06.1/stream`);
    expect(res.status).toBe(401);
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
        headers: { "x-nexus-secret": ATTACH_SECRET, "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
    });

    it(`POST /credentials/${id}/report-rate-limit with ${label} returns 400`, async () => {
      const res = await fetch(`${baseUrl}/credentials/${id}/report-rate-limit`, {
        method: "POST",
        headers: { "x-nexus-secret": ATTACH_SECRET, "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
    });
  }
});
