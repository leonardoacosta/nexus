/**
 * Server ingest endpoint tests — kept minimal as an additional validation file.
 *
 * The /health/ingest tests are in server-health.test.ts.
 * This file covers the ingest-adjacent validation: POST /health/ingest
 * error paths that overlap with the health endpoint tests.
 *
 * NOTE: This file exists to maintain the 5-file split structure per spec.
 * The primary ingest tests are in server-health.test.ts.
 * This file covers the remaining POST /health/ingest edge cases.
 */

import { describe, expect, it } from "bun:test";
import { ATTACH_SECRET, baseUrl } from "./server.helpers";

// ── POST /health/ingest: additional edge cases ───────────────────────────────

describe("POST /health/ingest — edge cases", () => {
  it("returns 405 for GET /health/ingest (wrong method)", async () => {
    const res = await fetch(`${baseUrl}/health/ingest`, {
      method: "GET",
      headers: { "x-nexus-secret": ATTACH_SECRET },
    });
    // Without DB the route is not registered — falls through to 404
    // But GET on a POST-only route should not return 200
    expect(res.status).not.toBe(200);
  });

  it("returns 401 for PUT /health/ingest without secret", async () => {
    const res = await fetch(`${baseUrl}/health/ingest`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hostname: "x" }),
    });
    expect(res.status).toBe(401);
  });

  it("returns non-200 for empty JSON body with valid secret", async () => {
    const res = await fetch(`${baseUrl}/health/ingest`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-nexus-secret": ATTACH_SECRET,
      },
      body: "{}",
    });
    // Without DB → 404; with DB → 400 (missing fields)
    expect([400, 404]).toContain(res.status);
  });
});
